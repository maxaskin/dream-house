#!/usr/bin/env node
/*
 * build.js — single source of truth → all artifacts.
 *
 * Reads property_data.json and regenerates, with one canonical scoring model:
 *   - property_summary.html   (English printable summary)
 *   - property_summary_ru.html (Russian summary; reuses existing RU note translations,
 *                               keyed by address, so numbers stay in sync without
 *                               machine-translating notes on every build)
 *
 * Run: node build.js
 *
 * The weight constants below are the ONLY place the model is defined, so the
 * summaries can no longer drift (the manual-sync hazard in INSTRUCTIONS "Keep in sync").
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const GEN_DATE = process.env.BUILD_DATE || new Date().toISOString().slice(0, 10); // today; override with BUILD_DATE=YYYY-MM-DD

// ---- canonical scoring model (must match INSTRUCTIONS_build_summary_html.md) ----
const WEIGHTS = [
  { key: 'price',         label: 'Price & €/m²',      w: 0.35 },
  { key: 'legal',         label: 'Legal / risk',      w: 0.25 },
  { key: 'dist_emmakade', label: 'Dist. Emmakade 33', w: 0.15 },
  { key: 'energy',        label: 'Energy label',      w: 0.15 },
  { key: 'dist_zuidas',   label: 'Dist. Zuidas',      w: 0.10 },
];
function renoDeduct(p) {
  const r = p.scores && p.scores.renovation;
  return (r != null && !isNaN(r)) ? Math.max(0, 6 - r) * 0.3 : 0;
}
function weightedTotal(p) {
  let sum = 0, wsum = 0;
  for (const c of WEIGHTS) {
    const v = p.scores && p.scores[c.key];
    if (v != null && v !== '' && !isNaN(v)) { sum += Number(v) * c.w; wsum += c.w; }
  }
  if (!wsum) return null;
  return sum / wsum - renoDeduct(p);
}

// ---- display helpers ----
function fmt(n) { return n == null ? '' : Number(n).toLocaleString('nl-NL'); }
function eurM2(p) { return (p.price && p.area) ? Math.round(p.price / p.area) : null; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function scoreColor(t) {
  if (t == null) return '#b6bdc8';
  if (t >= 7.5) return '#15803d';
  if (t >= 6.5) return '#2563eb';
  if (t >= 5.5) return '#d97706';
  return '#dc2626';
}
const LABEL_COLOR = { A: '#15803d', B: '#65a30d', C: '#84a017', D: '#d97706', E: '#ea7317', F: '#dc2626', G: '#b91c1c' };
function labelColor(l) { return LABEL_COLOR[(l || '').charAt(0)] || '#888'; }
// ground/tenure → Russian (exact match; falls back to the original Dutch if unmapped)
const GROUND_RU = {
  'Eigen grond': 'Собственный участок',
  'Erfpacht lopend': 'Аренда земли (действующая)',
  'Erfpacht afgekocht': 'Аренда земли (выкуплена)',
  'Erfpacht (afkoop aangevraagd)': 'Аренда земли (выкуп запрошен)',
  'Erfpacht lopend (vastgeklikt €1.865/jr na 2036)': 'Аренда земли (действующая; зафиксирована €1.865/год после 2036)',
  'Erfpacht voortdurend (AB 1994), canon afgekocht tot 31-05-2088': 'Аренда земли (бессрочная, AB 1994; канон выкуплен до 31-05-2088)',
  'Erfpacht (tijdvak tot 2039)': 'Аренда земли (срок до 2039)',
};
function scoreStr(t) { return t == null ? '—' : (Math.round(t * 100) % 10 === 0 ? t.toFixed(1) : t.toFixed(2)); }
// highlight risk tokens in notes (then keep the rest escaped)
function noteHtml(notes) {
  if (!notes) return '';
  return esc(notes).replace(/\b(VERIFIED|CORRECTED|CONFLICT|FLAGS?)\b/g,
    '<strong style="color:#d97706">$1</strong>');
}
// Russian equivalents of the highlighted flag tokens (\b is unreliable for Cyrillic)
function noteHtmlRu(notes) {
  if (!notes) return '';
  return esc(notes).replace(/(ПРОВЕРЕНО|ИСПРАВЛЕНО|РАСХОЖДЕНИЕ|КОНФЛИКТ|ФЛАГ|РИСК)/g,
    '<strong style="color:#d97706">$1</strong>');
}
function vveCell(p) {
  if (p.vve_costs == null) return '?';
  return (p.vve_estimated ? '~€' : '€') + fmt(p.vve_costs);
}
function eurM2Cell(p) {
  const e = eurM2(p);
  if (e == null) return '—';
  return (p.area_estimated ? '~€' : '€') + fmt(e);
}
function wozCell(p) {
  if (p.woz == null) return '—';
  const prem = Math.round((p.price - p.woz) / p.woz * 100);
  const col = prem <= 0 ? '#15803d' : '#888';
  const sign = prem > 0 ? '+' : '';
  return `€${fmt(p.woz)}<br><small style="color:${col}">${sign}${prem}% ask</small>`;
}

// ---- load + rank ----
const data = JSON.parse(fs.readFileSync(path.join(DIR, 'property_data.json'), 'utf8'));

// Auto-flip stale Scheduled viewings: if the date has passed, treat as Visited.
let autoFlipped = 0;
for (const p of data) {
  if (p.viewing && /^scheduled\s+(\d{4}-\d{2}-\d{2})$/i.test(p.viewing)) {
    const dateStr = p.viewing.replace(/^scheduled\s+/i, '');
    if (dateStr < GEN_DATE) {
      p.viewing = 'Visited ' + dateStr;
      autoFlipped++;
    }
  }
}
if (autoFlipped) console.log(`  ${autoFlipped} viewing(s) auto-flipped Scheduled → Visited (date passed).`);

const ranked = data
  .map(p => ({ p, total: weightedTotal(p) }))
  .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));

// =====================================================================
// summary (shared renderer; EN + RU differ only in chrome strings + notes)
// =====================================================================
function viewingBadge(v, T) {
  if (!v || v === 'No') return `<span style="color:#888;font-size:0.8em">${T.no}</span>`;
  const low = v.toLowerCase();
  const vis = low.startsWith('visited'), sch = low.startsWith('scheduled');
  const date = v.replace(/^(visited|scheduled)\s*/i, '');
  const txt = vis ? `${T.visited} ${date}` : sch ? `${T.scheduled} ${date}` : v;
  const bg = vis ? '#dcfce7' : '#fef3c7', fg = vis ? '#166534' : '#92400e';
  return `<span style="background:${bg};color:${fg};padding:2px 7px;border-radius:9px;font-size:0.8em;font-weight:600">${txt}</span>`;
}

function card(r, rank, T) {
  const p = r.p, t = r.total, border = rank === 0 ? '2px solid #2563eb' : '1px solid #e6e9ef';
  const lbl = p.energy_label
    ? `<span style="background:${labelColor(p.energy_label)};color:#fff;padding:1px 7px;border-radius:6px;font-weight:700">${p.energy_label}</span>` : '—';
  return `<div style="flex:1;min-width:260px;border:${border};border-radius:12px;padding:18px;background:#fff">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
  <span style="font-weight:700;font-size:1.05em">#${rank + 1}</span>
  <span style="background:${scoreColor(t)};color:#fff;padding:4px 12px;border-radius:12px;font-weight:700">${scoreStr(t)}</span>
</div>
<div style="font-weight:600;margin-bottom:10px"><a href="${p.url}" target="_blank" style="color:#1d4ed8;text-decoration:none">${esc(p.address)}</a></div>
<table style="font-size:0.88em;border-collapse:collapse;width:100%">
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.price}</td><td style="font-weight:600">€${fmt(p.price)}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">€/m²</td><td>${eurM2Cell(p)}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.area}</td><td>${p.area ? p.area + ' m²' : '—'}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.beds}</td><td>${p.bedrooms ?? '—'}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.label}</td><td>${lbl}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.ground}</td><td style="font-size:0.9em">${esc(T.grnd(p.ground))}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">→ Emmakade</td><td>${p.dist_emmakade_min} min</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">→ Zuidas</td><td>${p.dist_zuidas_min} min</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.viewing}</td><td>${esc(p.viewing || 'No')}</td></tr>
</table>
</div>`;
}

function row(r, rank, T, noteOverride) {
  const p = r.p, t = r.total;
  const lbl = p.energy_label
    ? `<span style="background:${labelColor(p.energy_label)};color:#fff;padding:2px 8px;border-radius:8px;font-weight:700;font-size:0.9em">${p.energy_label}</span>` : '—';
  const note = noteOverride != null ? noteOverride : noteHtml(p.notes);
  return `<tr>
<td style="text-align:center;font-weight:700;color:#555">${rank + 1}</td>
<td><a href="${p.url}" target="_blank" style="color:#1d4ed8;text-decoration:none;font-weight:500">${esc(p.address)}</a></td>
<td style="text-align:center"><span style="background:${scoreColor(t)};color:#fff;padding:3px 10px;border-radius:12px;font-weight:700;font-size:0.95em">${scoreStr(t)}</span></td>
<td style="text-align:center">${viewingBadge(p.viewing, T)}</td>
<td style="text-align:right">€${fmt(p.price)}</td>
<td style="text-align:right;font-size:0.88em">${eurM2Cell(p)}</td>
<td style="text-align:right;font-size:0.88em">${wozCell(p)}</td>
<td style="text-align:right">${p.area ?? '—'}</td>
<td style="text-align:center">${p.bedrooms ?? '—'}</td>
<td style="text-align:center">${p.build_year ?? '—'}</td>
<td style="text-align:center">${lbl}</td>
<td style="font-size:0.82em">${esc(T.grnd(p.ground))}</td>
<td style="text-align:right;font-size:0.88em">${vveCell(p)}</td>
<td style="text-align:center">${p.dist_emmakade_min ?? '—'}</td>
<td style="text-align:center">${p.dist_zuidas_min ?? '—'}</td>
<td style="font-size:0.8em;max-width:320px">${note}</td>
</tr>`;
}

function buildSummary(lang) {
  const T = lang === 'ru' ? STR.ru : STR.en;
  const cards = ranked.slice(0, 3).map((r, i) => card(r, i, T)).join('');
  const rows = ranked.map((r, i) => {
    // RU prefers notes_ru (with RU highlighting); falls back to the EN note if absent
    const note = lang === 'ru'
      ? (r.p.notes_ru ? noteHtmlRu(r.p.notes_ru) : noteHtml(r.p.notes))
      : noteHtml(r.p.notes);
    return row(r, i, T, note);
  }).join('');
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T.title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1a202c;padding:24px;color-scheme:light}
h1{font-size:1.6em;font-weight:800;margin-bottom:4px}
.subtitle{color:#555;margin-bottom:20px;font-size:0.95em}
.legend{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:24px;font-size:0.85em}
.legend-item{background:#fff;border:1px solid #e6e9ef;border-radius:8px;padding:5px 12px}
.legend-item strong{color:#1d4ed8}
.table-wrap{overflow-x:auto;margin-bottom:36px}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e9ef;font-size:0.875em}
th{background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:0.82em;color:#374151;white-space:nowrap;border-bottom:2px solid #e6e9ef}
td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}
.cards{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:32px}
.footer{font-size:0.82em;color:#555;border-top:1px solid #e6e9ef;padding-top:16px;line-height:1.6}
</style>
</head>
<body>
<h1>🏠 ${T.title}</h1>
<div class="subtitle">${T.subtitle(data.length)}</div>

<div class="legend">
<div class="legend-item">${T.legPrice} <strong>35%</strong></div>
<div class="legend-item">${T.legLegal} <strong>25%</strong></div>
<div class="legend-item">${T.legEmma} <strong>15%</strong></div>
<div class="legend-item">${T.legEnergy} <strong>15%</strong></div>
<div class="legend-item">${T.legZuidas} <strong>10%</strong></div>
<div class="legend-item" style="color:#888">${T.legReno}</div>
</div>

<h2 style="font-size:1.1em;font-weight:700;margin-bottom:14px">🏆 ${T.top3}</h2>
<div class="cards">${cards}</div>

<h2 style="font-size:1.1em;font-weight:700;margin-bottom:12px">📋 ${T.all}</h2>
<div class="table-wrap">
<table>
<thead>
<tr>
<th>#</th><th>${T.hAddr}</th><th>${T.hScore}</th><th>${T.hView}</th><th>${T.hPrice}</th><th>€/m²</th><th>WOZ</th><th>m²</th><th>${T.hBeds}</th><th>${T.hBuilt}</th><th>${T.hLabel}</th><th>${T.hGround}</th><th>${T.hVve}</th><th>→Emma</th><th>→Zuidas</th><th>${T.hNotes}</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>

<div class="footer">${T.footer}</div>
</body>
</html>`;
  return html;
}

// chrome strings
const STR = {
  en: {
    title: 'Dream House — Property Summary',
    subtitle: n => `Amstelveen + Amsterdam Buitenveldert · all sizes · verified vs official Funda + a second source · ${n} properties · Generated ${GEN_DATE}`,
    legPrice: 'Price &amp; €/m² vs WOZ', legLegal: 'Legal / risk', legEmma: 'Bike → Emmakade 33',
    legEnergy: 'Energy label', legZuidas: 'Bike → Zuidas', legReno: 'Renovation: deduction up to −1.5 pts',
    top3: 'Top 3', all: 'All Properties',
    hAddr: 'Address', hScore: 'Score', hView: 'Viewing', hPrice: 'Price', hBeds: 'Beds', hBuilt: 'Built',
    hLabel: 'Label', hGround: 'Ground', hVve: 'VvE/mo', hNotes: 'Notes &amp; flags',
    price: 'Price', area: 'Area', beds: 'Beds', label: 'Label', ground: 'Ground', viewing: 'Viewing',
    grnd: g => g || '—',
    no: 'No', visited: 'Visited', scheduled: 'Scheduled',
    footer: '<strong>Methodology:</strong> Weighted score out of 10: Price &amp; €/m² vs WOZ (35%), Legal risk (25%), Bike distance to Emmakade 33 (15%), Energy label (15%), Bike distance to Zuidas (10%). Renovation is a deduction: <code>−max(0, 6 − renovation_score) × 0.3</code> applied after the weighted sum (max −1.5 pts for fixers). Scores marked ~ or "est." are estimates and should be verified. WOZ values are the official 2025 Kadaster LV-WOZ assessments. Neighbourhood €/m² averages are May-2026 agent comps (no official register exists for these) — re-check at offer time. All data as of ' + GEN_DATE + '.',
  },
  ru: {
    title: 'Dream House — Сводка по объектам',
    subtitle: n => `Амстелвен + Амстердам Бёйтенвелдерт · все площади · проверено по Funda + второй источник · ${n} объекта · Сформировано ${GEN_DATE.split('-').reverse().join('.')}`,
    legPrice: 'Цена &amp; €/м² vs WOZ', legLegal: 'Юр. риск', legEmma: 'Вело → Emmakade 33',
    legEnergy: 'Энергометка', legZuidas: 'Вело → Zuidas', legReno: 'Ремонт: вычет до −1.5 балла',
    top3: 'Топ-3', all: 'Все объекты',
    hAddr: 'Адрес', hScore: 'Балл', hView: 'Просмотр', hPrice: 'Цена', hBeds: 'Спал.', hBuilt: 'Год',
    hLabel: 'Метка', hGround: 'Земля', hVve: 'VvE/мес', hNotes: 'Заметки и флаги',
    price: 'Цена', area: 'Площадь', beds: 'Спальни', label: 'Метка', ground: 'Земля', viewing: 'Просмотр',
    grnd: g => g ? (GROUND_RU[g] || g) : '—',
    no: 'Нет', visited: 'Посещён', scheduled: 'Запланирован',
    footer: '<strong>Методология:</strong> Взвешенный балл из 10: Цена &amp; €/м² vs WOZ (35%), Юр. риск (25%), Велодистанция до Emmakade 33 (15%), Энергометка (15%), Велодистанция до Zuidas (10%). Ремонт — вычет: <code>−max(0, 6 − балл_ремонта) × 0.3</code> после взвешенной суммы (макс −1.5 балла). Значения с ~ или «est.» — оценки, требуют проверки. Значения WOZ — официальные оценки Kadaster LV-WOZ за 2025 г. Средние €/м² по районам — оценки риелторов (май 2026), официального реестра нет — перепроверьте перед сделкой. Данные на ' + GEN_DATE + '.',
  },
};

// Stamp the landing page's footer with an incrementing build number + date,
// editing in place so the hand-maintained index design is preserved.
function buildIndex() {
  const file = path.join(DIR, 'index.html');
  if (!fs.existsSync(file)) return null;
  let html = fs.readFileSync(file, 'utf8');
  const m = html.match(/Build (\d+)/);
  const ver = m ? Number(m[1]) + 1 : 1;
  html = html.replace(/<p class="footer">[\s\S]*?<\/p>/,
    `<p class="footer">Build ${ver} · ${data.length} properties · Generated ${GEN_DATE}</p>`);
  fs.writeFileSync(file, html);
  return ver;
}

// ---- run ----
fs.writeFileSync(path.join(DIR, 'property_summary.html'), buildSummary('en'));
fs.writeFileSync(path.join(DIR, 'property_summary_ru.html'), buildSummary('ru'));
const buildVer = buildIndex();

// ---- self-check ----
let bad = 0;
for (const r of ranked) {
  const e = eurM2(r.p);
  if (e != null && (e < 3000 || e > 8000)) console.warn(`  €/m² out of range: ${r.p.address} = €${e}`);
  if (!/funda\.nl/.test(r.p.url || '')) { console.warn(`  non-funda url: ${r.p.address}`); bad++; }
}
const groundUnmapped = [...new Set(ranked.map(r => r.p.ground).filter(g => g && !GROUND_RU[g]))];
if (groundUnmapped.length) console.warn(`  ground not translated for RU (add to GROUND_RU): ${groundUnmapped.map(g => JSON.stringify(g)).join(', ')}`);
const ruMissing = ranked.filter(r => !r.p.notes_ru).map(r => r.p.address);
console.log(`Built ${data.length} properties (EN + RU summaries). index.html build #${buildVer}, dated ${GEN_DATE}.`);
if (ruMissing.length) console.log(`notes_ru missing for ${ruMissing.length} (RU falls back to EN note): ${ruMissing.join('; ')}`);
else console.log('notes_ru: all properties translated.');
if (bad) process.exitCode = 1;
console.log('Top 3:', ranked.slice(0, 3).map(r => `${r.p.address.split(',')[0]} ${scoreStr(r.total)}`).join(' · '));
