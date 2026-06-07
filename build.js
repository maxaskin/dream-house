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
// Tuned for the buyer's real brief: live-in home for one adult + a 3-yo (shared
// custody), to be sold in 5-10 years. Two clusters — livability ~55%, financial/
// resale ~45%. No renovation deduction: condition is a normal positive criterion.
const WEIGHTS = [
  { key: 'value',     label: 'Value at entry',     w: 0.20 }, // financial
  { key: 'family',    label: 'Family fit & space', w: 0.18 }, // living
  { key: 'condition', label: 'Condition',          w: 0.15 }, // living
  { key: 'location',  label: 'Location & commute', w: 0.15 }, // living
  { key: 'energy',    label: 'Energy label',       w: 0.10 }, // financial
  { key: 'tenure',    label: 'Tenure / erfpacht',  w: 0.10 }, // financial
  { key: 'outdoor',   label: 'Outdoor space',      w: 0.07 }, // living
  { key: 'legal',     label: 'Legal / title',      w: 0.05 }, // financial
];
function weightedTotal(p) {
  let sum = 0, wsum = 0;
  for (const c of WEIGHTS) {
    const v = p.scores && p.scores[c.key];
    if (v != null && v !== '' && !isNaN(v)) { sum += Number(v) * c.w; wsum += c.w; }
  }
  if (!wsum) return null;
  return sum / wsum; // blank criteria renormalise over the ones that are scored
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
  'Eigen grond (te verifieren)': 'Собственный участок (требует проверки)',
  'Erfpacht (tijdvak, te verifieren)': 'Аренда земли (срок требует проверки)',
  'Erfpacht (status te verifieren)': 'Аренда земли (статус требует проверки)',
  'Erfpacht (te verifieren)': 'Аренда земли (требует проверки)',
  'Erfpacht (afgekocht tot 2051)': 'Аренда земли (выкуплена до 2051)',
  'Erfpacht eeuwigdurend afgekocht': 'Аренда земли (вечная, выкуплена)',
  'Eigen grond (per listing)': 'Собственный участок (согласно объявлению)',
  'Erfpacht (status onbekend)': 'Аренда земли (статус неизвестен)',
  'Erfpacht (vermoedelijk lopend, ~2036)': 'Аренда земли (предположительно действующая, ~2036)',
};
// outdoor_space canonical token → Russian (exact match; falls back to original if unmapped)
const OUTDOOR_RU = {
  'none': 'нет',
  'shared': 'общий двор',
  'balcony': 'балкон',
  'loggia': 'лоджия',
  'terrace': 'терраса',
  'roof terrace': 'крыша-терраса',
  'garden': 'сад',
};
// outdoor_space is "<token>" or "<token> ~N m²"; translate the leading token for RU
function outdoorCell(p, T) {
  const o = p.outdoor_space;
  if (o == null || o === '') return '<span style="color:#b6bdc8">?</span>';
  const m = String(o).match(/^([a-z ]+?)(\s+.*)?$/i);
  const token = m ? m[1].trim() : o, rest = m && m[2] ? m[2] : '';
  return esc((T.outdoor ? (T.outdoor(token)) : token) + rest);
}
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

// ---- verification confidence (reads the documentary `sources` block + *_estimated/*_verified flags) ----
// Decision-critical fields whose provenance drives whether a ranking can be trusted.
const KEY_FIELDS = ['price', 'area', 'woz', 'energy_label', 'ground', 'bedrooms'];
// Per-field state: 'verified' | 'estimated' | 'conflict' | 'unknown' | 'assumed'.
function fieldState(p, f) {
  const s = p.sources && p.sources[f];
  if (s && s.status) {
    if (s.status === 'verified' || s.status === 'corrected') return 'verified';
    if (s.status === 'conflict') return 'conflict';
    if (s.status === 'unconfirmed') return 'estimated';
  }
  if (p[f + '_verified'] === true) return 'verified';
  if (p[f + '_estimated'] === true) return 'estimated';
  if (f === 'ground' && p.ground == null) return 'unknown';
  if ((f === 'price' || f === 'woz' || f === 'area' || f === 'bedrooms') && p[f] == null) return 'unknown';
  return 'assumed'; // value present but no provenance recorded → not independently verified
}
function verifyConfidence(p) {
  const conflicts = [], unverified = [];
  let verified = 0;
  for (const f of KEY_FIELDS) {
    const st = fieldState(p, f);
    if (st === 'verified') verified++;
    else if (st === 'conflict') conflicts.push(f);
    else unverified.push(f); // estimated | unknown | assumed (value present but no independent source)
  }
  return { pct: verified / KEY_FIELDS.length, verified, total: KEY_FIELDS.length, conflicts, unverified };
}
function confColor(pct) { return pct >= 0.8 ? '#15803d' : pct >= 0.5 ? '#d97706' : '#dc2626'; }
function confCell(p) {
  const c = verifyConfidence(p);
  const warn = c.conflicts.length ? '⚠ ' : '';
  const tip = [c.conflicts.length ? 'conflict: ' + c.conflicts.join(', ') : '',
               c.unverified.length ? 'unverified: ' + c.unverified.join(', ') : '']
              .filter(Boolean).join(' · ') || 'all key fields verified';
  return `<span title="${esc(tip)}" style="background:${confColor(c.pct)};color:#fff;padding:2px 7px;border-radius:9px;font-size:0.8em;font-weight:600;white-space:nowrap">${warn}✓${c.verified}/${c.total}</span>`;
}
// most recent purchase/sold entry from sale_history (for the "prior sale" line)
function priorSale(p) {
  if (!Array.isArray(p.sale_history)) return null;
  const past = p.sale_history.filter(h => (h.event === 'purchase' || h.event === 'sold') && h.price != null);
  if (!past.length) return null;
  return past.reduce((a, b) => (String(b.date) > String(a.date) ? b : a));
}
function priorSaleText(p, T) {
  const h = priorSale(p);
  if (!h) return '—';
  const yr = String(h.date).slice(0, 4);
  const verb = h.event === 'purchase' ? T.bought : T.sold2;
  let delta = '';
  if (p.price && h.price) {
    const pct = Math.round((p.price - h.price) / h.price * 100);
    const col = pct >= 0 ? '#888' : '#15803d';
    delta = ` <small style="color:${col}">${pct >= 0 ? '+' : ''}${pct}% ${T.toAsk}</small>`;
  }
  return `${verb} €${fmt(h.price)} (${yr})${delta}`;
}
function compsText(p, T) {
  if (!Array.isArray(p.comps) || !p.comps.length) return '';
  return p.comps.slice(0, 2).map(c => {
    const kind = c.kind === 'sold' ? T.sold2 : T.asked;
    return `€${fmt(c.price)} <small style="color:#888">(${esc(String(c.address).replace(/,.*$/, '').replace(/^.*\s(\S+)$/, '$1'))}, ${kind})</small>`;
  }).join(' · ');
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

// Sold listings stay in the database but are pulled out of the active ranking;
// they reappear in a footer stats block as reference comps.
const sold   = data.filter(p => p.sold);
const active = data.filter(p => !p.sold);

const ranked = active
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
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.hOutdoor}</td><td style="font-size:0.9em">${outdoorCell(p, T)}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">→ Emmakade</td><td>${p.dist_emmakade_min} min</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">→ Zuidas</td><td>${p.dist_zuidas_min} min</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.viewing}</td><td>${esc(p.viewing || 'No')}</td></tr>
<tr><td style="color:#666;padding:2px 8px 2px 0">${T.hConf}</td><td>${confCell(p)}</td></tr>
${priorSale(p) ? `<tr><td style="color:#666;padding:2px 8px 2px 0">${T.priorSale}</td><td>${priorSaleText(p, T)}</td></tr>` : ''}
${(p.comps && p.comps.length) ? `<tr><td style="color:#666;padding:2px 8px 2px 0">${T.comps}</td><td style="font-size:0.92em">${compsText(p, T)}</td></tr>` : ''}
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
<td style="text-align:center">${confCell(p)}</td>
<td style="text-align:center">${viewingBadge(p.viewing, T)}</td>
<td style="text-align:right">€${fmt(p.price)}</td>
<td style="text-align:right;font-size:0.88em">${eurM2Cell(p)}</td>
<td style="text-align:right;font-size:0.88em">${wozCell(p)}</td>
<td style="text-align:right">${p.area ?? '—'}</td>
<td style="text-align:center">${p.bedrooms ?? '—'}</td>
<td style="text-align:center">${p.build_year ?? '—'}</td>
<td style="text-align:center">${lbl}</td>
<td style="font-size:0.82em">${esc(T.grnd(p.ground))}</td>
<td style="font-size:0.82em">${outdoorCell(p, T)}</td>
<td style="text-align:right;font-size:0.88em">${vveCell(p)}</td>
<td style="text-align:center">${p.dist_emmakade_min ?? '—'}</td>
<td style="text-align:center">${p.dist_zuidas_min ?? '—'}</td>
<td style="font-size:0.8em;max-width:320px">${note}</td>
</tr>`;
}

// Compact reference row for a sold listing (no score; dimmed; "Sold" badge).
function soldRow(p, T) {
  const lbl = p.energy_label
    ? `<span style="background:${labelColor(p.energy_label)};color:#fff;padding:2px 8px;border-radius:8px;font-weight:700;font-size:0.9em">${p.energy_label}</span>` : '—';
  const badge = `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:9px;font-size:0.8em;font-weight:600">${T.soldStatus}${p.sold_date ? ' ' + p.sold_date : ''}</span>`;
  return `<tr style="opacity:0.72">
<td><a href="${p.url}" target="_blank" style="color:#1d4ed8;text-decoration:none;font-weight:500">${esc(p.address)}</a></td>
<td style="text-align:center">${badge}</td>
<td style="text-align:right">€${fmt(p.price)}</td>
<td style="text-align:right;font-size:0.88em">${eurM2Cell(p)}</td>
<td style="text-align:right;font-size:0.88em">${wozCell(p)}</td>
<td style="text-align:center">${p.area ?? '—'}</td>
<td style="text-align:center">${p.bedrooms ?? '—'}</td>
<td style="text-align:center">${p.build_year ?? '—'}</td>
<td style="text-align:center">${lbl}</td>
<td style="text-align:center">${p.dist_emmakade_min ?? '—'}</td>
</tr>`;
}

// sale_history event → bilingual label
const EV = {
  purchase:    { en: 'bought',       ru: 'куплен' },
  sold:        { en: 'sold',         ru: 'продан' },
  listed:      { en: 'listed',       ru: 'выставлен' },
  relisted:    { en: 'relisted',     ru: 'перевыставлен' },
  withdrawn:   { en: 'withdrawn',    ru: 'снят с продажи' },
  under_offer: { en: 'under offer',  ru: 'под предложением' },
  price_change:{ en: 'price change', ru: 'смена цены' },
};
// "Sales history & comparable prices" appendix — surfaces structured sale_history/comps
// for every property that has them, regardless of rank (answers "history of sales").
function salesHistorySection(T, lang, activeList) {
  const withData = activeList.filter(p => (p.sale_history && p.sale_history.length) || (p.comps && p.comps.length));
  if (!withData.length) return '';
  const blocks = withData.map(p => {
    const timeline = (p.sale_history || []).map(h => {
      const ev = (EV[h.event] && EV[h.event][lang]) || h.event;
      const price = h.price != null ? `€${fmt(h.price)} ` : '';
      const mo = String(h.date || '').length > 4 ? String(h.date).slice(0, 7) : String(h.date || '');
      return `<span style="white-space:nowrap">${price}<small style="color:#888">${ev}${mo ? ' ' + mo : ''}</small></span>`;
    }).join(' <span style="color:#bbb">→</span> ');
    const comps = (p.comps || []).map(c => {
      const kind = c.kind === 'sold' ? T.sold2 : T.asked;
      const a = esc(String(c.address).replace(/,.*$/, ''));
      return `€${fmt(c.price)} <small style="color:#888">(${a}${c.area ? ', ' + c.area + ' m²' : ''}, ${kind})</small>`;
    }).join(' · ');
    return `<div style="padding:8px 0;border-bottom:1px solid #f1f5f9">
<a href="${p.url}" target="_blank" style="color:#1d4ed8;text-decoration:none;font-weight:600">${esc(p.address)}</a>
${timeline ? `<div style="margin-top:3px;font-size:0.9em">${timeline}</div>` : ''}
${comps ? `<div style="margin-top:3px;font-size:0.9em">${T.comps}: ${comps}</div>` : ''}
</div>`;
  }).join('');
  return `
<h2 style="font-size:1.1em;font-weight:700;margin:8px 0 8px">🕑 ${T.salesTitle}</h2>
<div class="subtitle" style="margin-bottom:8px">${T.salesNote}</div>
<div style="background:#fff;border:1px solid #e6e9ef;border-radius:12px;padding:6px 16px;margin-bottom:36px">${blocks}</div>`;
}

function buildSummary(lang, filter, subtitleFn, titleOverride) {
  const T = lang === 'ru' ? STR.ru : STR.en;
  const title = titleOverride || T.title;
  // Optional per-page filter (e.g. Amstelveen-only); no filter → full dataset.
  const rk = filter ? ranked.filter(r => filter(r.p)) : ranked;
  const activeF = filter ? active.filter(filter) : active;
  const soldF = filter ? sold.filter(filter) : sold;
  const cards = rk.slice(0, 3).map((r, i) => card(r, i, T)).join('');
  const rows = rk.map((r, i) => {
    // RU prefers notes_ru (with RU highlighting); falls back to the EN note if absent
    const note = lang === 'ru'
      ? (r.p.notes_ru ? noteHtmlRu(r.p.notes_ru) : noteHtml(r.p.notes))
      : noteHtml(r.p.notes);
    return row(r, i, T, note);
  }).join('');
  const soldSection = soldF.length ? `
<h2 style="font-size:1.1em;font-weight:700;margin:8px 0 12px">📊 ${T.soldTitle}</h2>
<div class="subtitle" style="margin-bottom:12px">${T.soldNote}</div>
<div class="table-wrap">
<table>
<thead>
<tr>
<th>${T.hAddr}</th><th>${T.hStatus}</th><th>${T.hPrice}</th><th>€/m²</th><th>WOZ</th><th>m²</th><th>${T.hBeds}</th><th>${T.hBuilt}</th><th>${T.hLabel}</th><th>→Emma</th>
</tr>
</thead>
<tbody>
${soldF.map(p => soldRow(p, T)).join('')}
</tbody>
</table>
</div>
` : '';
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
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
<h1>🏠 ${title}</h1>
<div class="subtitle">${(subtitleFn || T.subtitle)(activeF.length)}</div>

<div class="legend">
<div class="legend-item">${T.legValue} <strong>20%</strong></div>
<div class="legend-item">${T.legFamily} <strong>18%</strong></div>
<div class="legend-item">${T.legCondition} <strong>15%</strong></div>
<div class="legend-item">${T.legLocation} <strong>15%</strong></div>
<div class="legend-item">${T.legEnergy} <strong>10%</strong></div>
<div class="legend-item">${T.legTenure} <strong>10%</strong></div>
<div class="legend-item">${T.legOutdoor} <strong>7%</strong></div>
<div class="legend-item">${T.legLegal} <strong>5%</strong></div>
</div>
<div class="subtitle" style="margin:-16px 0 24px;font-size:0.85em">${T.legClusters}</div>
<div class="subtitle" style="margin:-16px 0 24px;font-size:0.85em">${T.legConf}</div>

<h2 style="font-size:1.1em;font-weight:700;margin-bottom:14px">🏆 ${T.top3}</h2>
<div class="cards">${cards}</div>

<h2 style="font-size:1.1em;font-weight:700;margin-bottom:12px">📋 ${T.all}</h2>
<div class="table-wrap">
<table>
<thead>
<tr>
<th>#</th><th>${T.hAddr}</th><th>${T.hScore}</th><th>${T.hConf}</th><th>${T.hView}</th><th>${T.hPrice}</th><th>€/m²</th><th>WOZ</th><th>m²</th><th>${T.hBeds}</th><th>${T.hBuilt}</th><th>${T.hLabel}</th><th>${T.hGround}</th><th>${T.hOutdoor}</th><th>${T.hVve}</th><th>→Emma</th><th>→Zuidas</th><th>${T.hNotes}</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>

${salesHistorySection(T, lang, activeF)}
${soldSection}
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
    legValue: 'Value at entry', legFamily: 'Family fit &amp; space', legCondition: 'Condition',
    legLocation: 'Location &amp; commute', legEnergy: 'Energy label', legTenure: 'Tenure / erfpacht',
    legOutdoor: 'Outdoor space', legLegal: 'Legal / title',
    legClusters: 'Livability ~55% (family, condition, location, outdoor) · Financial / resale ~45% (value, energy, tenure, legal). Tuned for a live-in home for one adult + a 3-yo, sold in 5–10 years.',
    legConf: '<strong>Conf.</strong> = data-verification confidence: how many of 6 key fields (price, area, WOZ, energy label, ground/tenure, beds) are verified against an independent source. ✓N/6, green ≥5 · amber ≥3 · red &lt;3; ⚠ = a source conflict. Hover for which fields are unverified.',
    top3: 'Top 3', all: 'All Properties',
    hAddr: 'Address', hScore: 'Score', hConf: 'Conf.', hView: 'Viewing', hPrice: 'Price', hBeds: 'Beds', hBuilt: 'Built',
    hLabel: 'Label', hGround: 'Ground', hOutdoor: 'Outdoor', hVve: 'VvE/mo', hNotes: 'Notes &amp; flags', hStatus: 'Status',
    priorSale: 'Prior sale', bought: 'bought', sold2: 'sold', toAsk: 'to ask', comps: 'Comps', asked: 'asking',
    salesTitle: 'Sales history &amp; comparable prices',
    salesNote: 'Prior transactions, relistings and comparable sold/asking prices — extracted from the notes. WOZ history (in the table) is annual tax assessment, not sales.',
    soldTitle: 'Sold — reference comps', soldStatus: 'Sold',
    soldNote: 'Kept in the database for statistics only — excluded from the active ranking above.',
    price: 'Price', area: 'Area', beds: 'Beds', label: 'Label', ground: 'Ground', viewing: 'Viewing',
    grnd: g => g || '—',
    outdoor: t => t,
    no: 'No', visited: 'Visited', scheduled: 'Scheduled',
    footer: '<strong>Methodology:</strong> Weighted score out of 10, tuned for a live-in home for one adult + a 3-yo (shared custody), sold in 5–10 years. Two clusters — <em>livability ~55%</em>: Family fit &amp; space (18%), Condition (15%), Location &amp; commute (15%), Outdoor space (7%); <em>financial / resale ~45%</em>: Value at entry vs WOZ &amp; €/m² (20%), Energy label (10%), Tenure / erfpacht (10%), Legal / title risk (5%). Blank criteria renormalise over the ones that are scored (no renovation deduction — condition is now a positive criterion). Scores marked ~ or "est." are estimates and should be verified. WOZ values are the official 2025 Kadaster LV-WOZ assessments. Neighbourhood €/m² averages are May-2026 agent comps (no official register exists for these) — re-check at offer time. All data as of ' + GEN_DATE + '.',
  },
  ru: {
    title: 'Dream House — Сводка по объектам',
    subtitle: n => `Амстелвен + Амстердам Бёйтенвелдерт · все площади · проверено по Funda + второй источник · ${n} объекта · Сформировано ${GEN_DATE.split('-').reverse().join('.')}`,
    legValue: 'Цена входа vs WOZ', legFamily: 'Для семьи &amp; площадь', legCondition: 'Состояние',
    legLocation: 'Локация &amp; дорога', legEnergy: 'Энергометка', legTenure: 'Земля / эрфпахт',
    legOutdoor: 'Открытое пространство', legLegal: 'Юр. / титул',
    legClusters: 'Для жизни ~55% (семья, состояние, локация, открытое пространство) · Финансы / перепродажа ~45% (цена входа, энергия, земля, юр.). Настроено под жильё для одного взрослого + ребёнка 3 лет, с продажей через 5–10 лет.',
    legConf: '<strong>Дост.</strong> = достоверность данных: сколько из 6 ключевых полей (цена, площадь, WOZ, энергометка, земля/эрфпахт, спальни) проверены по независимому источнику. ✓N/6, зелёный ≥5 · янтарный ≥3 · красный &lt;3; ⚠ = конфликт источников. Наведите курсор, чтобы увидеть непроверенные поля.',
    top3: 'Топ-3', all: 'Все объекты',
    hAddr: 'Адрес', hScore: 'Балл', hConf: 'Дост.', hView: 'Просмотр', hPrice: 'Цена', hBeds: 'Спал.', hBuilt: 'Год',
    hLabel: 'Метка', hGround: 'Земля', hOutdoor: 'Двор/балкон', hVve: 'VvE/мес', hNotes: 'Заметки и флаги', hStatus: 'Статус',
    priorSale: 'Пред. сделка', bought: 'куплен', sold2: 'продан', toAsk: 'к цене', comps: 'Аналоги', asked: 'запрос',
    salesTitle: 'История продаж и цены аналогов',
    salesNote: 'Прошлые сделки, перевыставления и сопоставимые цены продаж/запроса — извлечены из заметок. История WOZ (в таблице) — это ежегодная оценка для налога, не сделки.',
    soldTitle: 'Проданные — для статистики', soldStatus: 'Продано',
    soldNote: 'Оставлено в базе только для статистики — исключено из активного рейтинга выше.',
    price: 'Цена', area: 'Площадь', beds: 'Спальни', label: 'Метка', ground: 'Земля', viewing: 'Просмотр',
    grnd: g => g ? (GROUND_RU[g] || g) : '—',
    outdoor: t => OUTDOOR_RU[t] || t,
    no: 'Нет', visited: 'Посещён', scheduled: 'Запланирован',
    footer: '<strong>Методология:</strong> Взвешенный балл из 10, настроен под жильё для одного взрослого + ребёнка 3 лет (совместная опека), с продажей через 5–10 лет. Два кластера — <em>для жизни ~55%</em>: Для семьи &amp; площадь (18%), Состояние (15%), Локация &amp; дорога (15%), Открытое пространство (7%); <em>финансы / перепродажа ~45%</em>: Цена входа vs WOZ &amp; €/м² (20%), Энергометка (10%), Земля / эрфпахт (10%), Юр. / титул (5%). Незаполненные критерии перенормируются по заполненным (вычета за ремонт больше нет — состояние теперь обычный критерий). Значения с ~ или «est.» — оценки, требуют проверки. Значения WOZ — официальные оценки Kadaster LV-WOZ за 2025 г. Средние €/м² по районам — оценки риелторов (май 2026), официального реестра нет — перепроверьте перед сделкой. Данные на ' + GEN_DATE + '.',
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
    `<p class="footer">Build ${ver} · ${active.length} properties · Generated ${GEN_DATE}</p>`);
  fs.writeFileSync(file, html);
  return ver;
}

// ---- run ----
// Amstelveen-only view: match the city segment of "Street nr, City" (Buitenveldert
// entries end in ", Amsterdam"), not a bare substring.
const isAmstelveen = p => /,\s*Amstelveen\b/i.test(p.address || '');
fs.writeFileSync(path.join(DIR, 'property_summary.html'), buildSummary('en'));
fs.writeFileSync(path.join(DIR, 'property_summary_ru.html'), buildSummary('ru'));
fs.writeFileSync(path.join(DIR, 'property_summary_amstelveen.html'),
  buildSummary('en', isAmstelveen,
    n => `Amstelveen only · all sizes · verified vs official Funda + a second source · ${n} properties · Generated ${GEN_DATE}`,
    'Dream House — Amstelveen'));
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
// outdoor_space tokens must be RU-mapped (same discipline as ground)
const outdoorTokens = [...new Set(ranked.map(r => r.p.outdoor_space).filter(Boolean)
  .map(o => (String(o).match(/^([a-z ]+?)(\s+.*)?$/i) || [,o])[1].trim()))];
const outdoorUnmapped = outdoorTokens.filter(t => !(t in OUTDOOR_RU));
if (outdoorUnmapped.length) console.warn(`  outdoor_space token not translated for RU (add to OUTDOOR_RU): ${outdoorUnmapped.map(t => JSON.stringify(t)).join(', ')}`);
// Required score keys must be present; tenure & outdoor are conditional:
//   - tenure: only expected when `ground` is known (null ground → tenure renormalises)
//   - outdoor: always optional (null outdoor_space legitimately means "unknown")
const REQUIRED_KEYS = ['value', 'family', 'condition', 'location', 'energy', 'legal'];
for (const r of ranked) {
  const s = r.p.scores || {};
  const missing = REQUIRED_KEYS.filter(k => s[k] == null);
  if (r.p.ground != null && s.tenure == null) missing.push('tenure (ground is known)');
  if (missing.length) console.warn(`  ${r.p.address}: missing scores [${missing.join(', ')}]`);
}
// ---- verification self-check (reads the `sources` block) ----
const STALE_DAYS = 180;
const genMs = new Date(GEN_DATE).getTime();
const vWarn = [];
for (const r of ranked) {
  const p = r.p, c = verifyConfidence(p);
  // 1. source conflicts
  for (const f of c.conflicts) vWarn.push(`CONFLICT ${p.address}: ${f} (${p.sources[f].note || 'see sources'})`);
  // 2. stale `checked` dates + WOZ peildatum not latest
  if (p.sources) for (const [f, s] of Object.entries(p.sources)) {
    if (s && s.checked) {
      const ageDays = (genMs - new Date(s.checked).getTime()) / 86400000;
      if (ageDays > STALE_DAYS) vWarn.push(`STALE ${p.address}: ${f} checked ${s.checked} (${Math.round(ageDays)}d ago)`);
    }
    if (f === 'woz' && s && s.history) {
      const years = (s.history.match(/(\d{4}):/g) || []).map(x => +x.slice(0, 4));
      const latest = Math.max(...years, 0);
      if (s.peildatum && latest && +s.peildatum.slice(0, 4) < latest)
        vWarn.push(`STALE-WOZ ${p.address}: peildatum ${s.peildatum} but history runs to ${latest}`);
    }
  }
  // 3. Tier-1: a viewed/scheduled property should have its key fields verified
  const serious = /^(visited|scheduled)/i.test(p.viewing || '');
  if (serious) {
    const unver = ['ground', 'area', 'energy_label'].filter(f => fieldState(p, f) !== 'verified');
    if (unver.length) vWarn.push(`TIER-1 ${p.address} (${p.viewing}): unverified ${unver.join(', ')}`);
  }
}
// 4. ranks high on thin data
ranked.slice(0, 10).forEach((r, i) => {
  const c = verifyConfidence(r.p);
  if (c.pct < 0.5) vWarn.push(`LOW-CONF #${i + 1} ${r.p.address}: only ${c.verified}/${c.total} key fields verified`);
});
if (vWarn.length) console.warn(`  verification (${vWarn.length}):\n    ${vWarn.join('\n    ')}`);

const ruMissing = ranked.filter(r => !r.p.notes_ru).map(r => r.p.address);
console.log(`Built ${data.length} properties (EN + RU summaries). index.html build #${buildVer}, dated ${GEN_DATE}.`);
if (ruMissing.length) console.log(`notes_ru missing for ${ruMissing.length} (RU falls back to EN note): ${ruMissing.join('; ')}`);
else console.log('notes_ru: all properties translated.');
if (bad) process.exitCode = 1;
console.log('Top 3:', ranked.slice(0, 3).map(r => `${r.p.address.split(',')[0]} ${scoreStr(r.total)}`).join(' · '));
