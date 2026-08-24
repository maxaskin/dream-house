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

// ---- canonical scoring model v4 (must match INSTRUCTIONS_build_summary_html.md) ----
// Tuned for the buyer's real brief: live-in home for one adult + a 3-yo (shared
// custody), to be sold in 5-10 years. Two clusters — livability ~51%, financial/
// resale ~49%.
// v3 (2026-06-09): six criteria are COMPUTED at build time from measured fields
// (family, location, energy, tenure, costs, outdoor); only value/condition/legal
// stay hand-scored.
// v4 (2026-06-28): price signal rebalanced so €/m² outweighs the raw WOZ premium.
//   - NEW computed `relvalue` (9%): asking/WOZ premium centred on the property's
//     city median → objective "price vs local €/m²" (WOZ used only as the
//     location/size-aware normaliser, not as a stale absolute anchor).
//   - `value` (manual) trimmed 16→10% and re-scoped to a condition-adjusted
//     judgment overlay (over-priced-for-condition, bidding-war temper).
//   - `costs` now includes the WOZ-driven owner taxes (OZB per gemeente +
//     eigenwoningforfait drag), so a higher WOZ correctly raises carrying cost.
const WEIGHTS = [
  { key: 'family',    label: 'Family fit & space', w: 0.17 },               // living  (computed)
  { key: 'value',     label: 'Value (judgment)',   w: 0.10, manual: true }, // financial
  { key: 'relvalue',  label: 'Price vs local €/m²', w: 0.09 },              // financial (computed)
  { key: 'location',  label: 'Location & commute', w: 0.15 },               // living  (computed)
  { key: 'condition', label: 'Condition',          w: 0.13, manual: true }, // living
  { key: 'energy',    label: 'Energy label',       w: 0.10 },               // financial (computed)
  { key: 'tenure',    label: 'Tenure / erfpacht',  w: 0.07 },               // financial (computed)
  { key: 'costs',     label: 'Running costs',      w: 0.08 },               // financial (computed)
  { key: 'outdoor',   label: 'Outdoor space',      w: 0.06 },               // living  (computed)
  { key: 'legal',     label: 'Legal / title',      w: 0.05, manual: true }, // financial
];
const clamp10 = v => Math.max(1, Math.min(10, v));

// energy: fixed label table − 1 if the label is only estimated/conflicted,
// + upgrade bonus when an easy/moderate path to a better label is documented.
const ENERGY_SCORE = { 'A+++': 10, 'A++': 10, 'A+': 10, A: 10, B: 9, C: 7, D: 5, E: 4, F: 3, G: 2 };
function calcEnergy(p) {
  if (!p.energy_label) return null;
  let s = ENERGY_SCORE[p.energy_label] ?? ENERGY_SCORE[(p.energy_label || '').charAt(0)];
  if (s == null) return null;
  const st = fieldState(p, 'energy_label');
  if (st === 'estimated' || st === 'conflict') s -= 1;
  if (p.energy_upgrade === 'easy') s += 1;
  else if (p.energy_upgrade === 'moderate') s += 0.5;
  return clamp10(s);
}
// tenure: exact `ground` string → score (same sync discipline as GROUND_RU;
// unmapped values warn at build time).
const TENURE_SCORE = {
  'Eigen grond': 10,
  'Eigen grond (per listing)': 8,
  'Eigen grond (te verifieren)': 8,
  'Erfpacht eeuwigdurend afgekocht': 9,
  'Erfpacht voortdurend (AB 1994), canon afgekocht tot 31-05-2088': 8,
  'Erfpacht (afgekocht tot 2051)': 7,
  'Erfpacht afgekocht': 7,
  'Erfpacht (afkoop aangevraagd)': 5,
  'Erfpacht lopend (vastgeklikt €1.865/jr na 2036)': 5,
  'Erfpacht lopend': 4,
  'Erfpacht (tijdvak tot 2039)': 4,
  'Erfpacht (vermoedelijk lopend, ~2036)': 4,
  'Erfpacht (tijdvak, te verifieren)': 3,
  'Erfpacht (status te verifieren)': 3,
  'Erfpacht (te verifieren)': 3,
  'Erfpacht (status onbekend)': 3,
};
function calcTenure(p) {
  if (p.ground == null) return null;
  return TENURE_SCORE[p.ground] ?? null; // null → renormalises; warned in self-check
}
// family: bedrooms × area bands; 55+/ballotage → 1; explicit `family_adj`
// (±, with `family_adj_reason`) for documented potential (e.g. attic room).
function calcFamily(p) {
  if (p.age_restricted) return 1; // a child can't live there
  const b = p.bedrooms, a = p.area || 0;
  if (b == null) return null;
  let s;
  if (b === 0) s = 2;
  else if (b === 1) s = 3;
  else if (b === 2) s = a >= 85 ? 9 : a >= 75 ? 8 : a >= 65 ? 7 : a >= 55 ? 6 : 4;
  else s = a >= 85 ? 10 : a >= 70 ? 9 : 8;
  return clamp10(s + (p.family_adj || 0));
}
// location: bike-minute decay (Emmakade 60% / Zuidas 40%), ±1 neighbourhood
// adjustment via `location_adj` (quiet/green + · busy arterial −).
function calcLocation(p) {
  const e = p.dist_emmakade_min, z = p.dist_zuidas_min;
  if (e == null && z == null) return null;
  const se = e == null ? null : (e <= 7 ? 10 : Math.max(2, 10 - 0.6 * (e - 7)));
  const sz = z == null ? null : (z <= 6 ? 10 : Math.max(2, 10 - 0.5 * (z - 6)));
  const base = (se != null && sz != null) ? 0.6 * se + 0.4 * sz : (se ?? sz);
  return clamp10(base + (p.location_adj || 0));
}
// costs: full owner monthly — VvE + heating advance + WOZ-driven owner taxes — banded 1–10.
// monthlyAllIn stays VvE+heating (what the "VvE/mo" column shows); the cost SCORE adds
// the WOZ taxes via ownershipMonthly, so a pricey WOZ is penalised on carrying cost.
const OZB_RATE = { Amstelveen: 0.00063, Amsterdam: 0.000577 }; // 2025 owner (eigenaar) OZB tariffs, per gemeente
const FORFAIT_RATE = 0.0035;   // eigenwoningforfait 2025/26, WOZ ≤ €1.33M (national)
const MARGINAL_RATE = 0.37;    // assumed box-1 low-bracket rate for the forfait cash drag; set 0 for OZB-only
function cityOf(p) { return /amsterdam/i.test(p.address || '') ? 'Amsterdam' : 'Amstelveen'; }
function wozTaxMonthly(p) {
  if (p.woz == null) return 0;
  const ozb = p.woz * (OZB_RATE[cityOf(p)] ?? OZB_RATE.Amstelveen);
  return (ozb + p.woz * FORFAIT_RATE * MARGINAL_RATE) / 12;
}
function monthlyAllIn(p) { return p.vve_costs == null ? null : p.vve_costs + (p.heating_advance || 0); }
function ownershipMonthly(p) { const m = monthlyAllIn(p); return m == null ? null : m + wozTaxMonthly(p); }
function calcCosts(p) {
  const m = ownershipMonthly(p);
  if (m == null) return null;
  return m <= 160 ? 10 : m <= 210 ? 9 : m <= 260 ? 8 : m <= 320 ? 7 : m <= 380 ? 6 : m <= 450 ? 5 : m <= 540 ? 4 : 3;
}
// relvalue: asking/WOZ premium centred on the property's city median. Because WOZ is the
// gemeente's location+size-aware assessment, price/WOZ ≈ actual €/m² ÷ "fair" €/m²;
// centring on the city median cancels the shared WOZ peildatum lag and yields a robust
// relative-value signal (cheaper-than-local-peers → higher score). 92/93 coverage.
function premium(p) { return (p.price && p.woz) ? p.price / p.woz : null; }
function median(xs) { const a = xs.filter(v => v != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
let _premBase = null;
function premBaseline() {
  if (_premBase) return _premBase;
  const byCity = {};
  for (const p of active) { const pr = premium(p); if (pr == null) continue; (byCity[cityOf(p)] = byCity[cityOf(p)] || []).push(pr); }
  const med = {}, cnt = {};
  for (const c in byCity) { med[c] = median(byCity[c]); cnt[c] = byCity[c].length; }
  _premBase = { med, cnt, all: median(active.map(premium)) };
  return _premBase;
}
function relBase(p) { const b = premBaseline(), c = cityOf(p); return (b.cnt[c] >= 8 ? b.med[c] : b.all) || b.all; }
function calcRelValue(p) {
  const pr = premium(p);
  if (pr == null) return null;
  return clamp10(6 - (pr / relBase(p) - 1) * 14); // K=14, neutral 6 at the city median
}
// outdoor: canonical token → score; balcony +1 if ≥5 m², +1 if south/west (cap 7).
const OUTDOOR_SCORE = { garden: 9, 'roof terrace': 8, terrace: 7, balcony: 5, loggia: 5, shared: 3, none: 2 };
function calcOutdoor(p) {
  const o = p.outdoor_space;
  if (o == null || o === '') return null;
  const m = String(o).match(/^([a-z ]+?)(\s+.*|\s*\(.*)?$/i);
  const token = (m ? m[1] : String(o)).trim().toLowerCase(), rest = (m && m[2]) || '';
  let s = OUTDOOR_SCORE[token];
  if (s == null) return null;
  if (token === 'balcony') {
    const size = rest.match(/(\d+(?:[.,]\d+)?)\s*m/);
    if (size && parseFloat(size[1].replace(',', '.')) >= 5) s += 1;
    if (/south|west|zuid|west/i.test(rest)) s += 1;
    s = Math.min(7, s);
  }
  return clamp10(s);
}
// effective scores: computed criteria + the three manual ones; a manual value
// for a computed key acts as an explicit override (surfaced in the self-check).
function effectiveScores(p) {
  const man = p.scores || {};
  const calc = { family: calcFamily(p), location: calcLocation(p), energy: calcEnergy(p),
                 tenure: calcTenure(p), costs: calcCosts(p), outdoor: calcOutdoor(p),
                 relvalue: calcRelValue(p) };
  const scores = {}, overridden = [];
  for (const c of WEIGHTS) {
    if (c.manual) { scores[c.key] = (man[c.key] != null && !isNaN(man[c.key])) ? Number(man[c.key]) : null; continue; }
    scores[c.key] = calc[c.key];
    if (man[c.key] != null && !isNaN(man[c.key])) { scores[c.key] = Number(man[c.key]); overridden.push(c.key); }
  }
  return { scores, overridden };
}
function weightedTotal(p) {
  const { scores } = effectiveScores(p);
  let sum = 0, wsum = 0;
  for (const c of WEIGHTS) {
    const v = scores[c.key];
    if (v != null && !isNaN(v)) { sum += Number(v) * c.w; wsum += c.w; }
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
  const all = monthlyAllIn(p);
  const base = (p.vve_estimated ? '~€' : '€') + fmt(p.vve_costs);
  if (!p.heating_advance) return base;
  return `<span title="VvE €${fmt(p.vve_costs)} + heating €${fmt(p.heating_advance)}">${(p.vve_estimated ? '~€' : '€')}${fmt(all)}*</span>`;
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
  .map(p => ({ p, total: weightedTotal(p), eff: effectiveScores(p) }))
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
<div style="margin-top:12px;border-top:1px solid #f1f5f9;padding-top:8px">
<div style="font-size:0.78em;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">${T.breakdown}</div>
${breakdownHtml(r, T)}
</div>
</div>`;
}

// per-criterion inputs shown under the breakdown bars (why the computed score is what it is)
function critDetail(p, key, T) {
  switch (key) {
    case 'family': {
      const bits = [`${p.bedrooms ?? '?'} ${T.beds.toLowerCase()} · ${p.area ?? '?'} m²`];
      if (p.age_restricted) bits.push(T.ageRestricted);
      if (p.family_adj) bits.push(`${p.family_adj > 0 ? '+' : ''}${p.family_adj}${p.family_adj_reason ? ': ' + p.family_adj_reason : ''}`);
      return bits.join(' · ');
    }
    case 'location': {
      const bits = [`${p.dist_emmakade_min ?? '?'}′ Emmakade · ${p.dist_zuidas_min ?? '?'}′ Zuidas`];
      if (p.location_adj) bits.push(`${p.location_adj > 0 ? '+' : ''}${p.location_adj} ${T.neigh}`);
      return bits.join(' · ');
    }
    case 'energy': {
      const bits = [p.energy_label || '?'];
      const st = fieldState(p, 'energy_label');
      if (st === 'estimated' || st === 'conflict') bits.push(`−1 ${T.unverifiedLbl}`);
      if (p.energy_upgrade) bits.push(`+${p.energy_upgrade === 'easy' ? '1' : '0.5'} ${T.upgrade}`);
      return bits.join(' · ');
    }
    case 'tenure': return p.ground || '';
    case 'costs': {
      const m = monthlyAllIn(p);
      if (m == null) return '';
      const tax = Math.round(wozTaxMonthly(p));
      const vve = p.heating_advance ? `VvE €${fmt(p.vve_costs)} + ${T.heat} €${fmt(p.heating_advance)}` : `VvE €${fmt(p.vve_costs)}`;
      return `€${fmt(Math.round(m + wozTaxMonthly(p)))}${T.allIn} (${vve}${tax ? ` + ${T.tax} €${fmt(tax)}` : ''})`;
    }
    case 'relvalue': {
      const pr = premium(p);
      if (pr == null) return '';
      const ask = Math.round((pr - 1) * 100), rel = Math.round((pr / relBase(p) - 1) * 100);
      return `${ask >= 0 ? '+' : ''}${ask}% ${T.vsWoz} · ${rel >= 0 ? '+' : ''}${rel}% ${T.vsMedian}`;
    }
    case 'outdoor': return p.outdoor_space || '';
    default: return '';
  }
}
function breakdownHtml(r, T) {
  const p = r.p, s = r.eff.scores;
  const rows = WEIGHTS.map(c => {
    const v = s[c.key];
    const name = `${T.leg[c.key]} <small style="color:#94a3b8">${Math.round(c.w * 100)}%${c.manual ? '' : ' · ' + T.auto}</small>`;
    if (v == null) return `<div class="bd-row"><div class="bd-name">${name}</div><div class="bd-bar"><span class="bd-na">${T.unscored}</span></div><div class="bd-val">—</div></div>`;
    const detail = c.manual ? '' : critDetail(p, c.key, T);
    return `<div class="bd-row" ${detail ? `title="${esc(detail)}"` : ''}>
<div class="bd-name">${name}${detail ? `<div class="bd-detail">${esc(detail)}</div>` : ''}</div>
<div class="bd-bar"><i style="width:${v * 10}%;background:${scoreColor(v)}"></i></div>
<div class="bd-val">${(Math.round(v * 10) / 10)}</div></div>`;
  }).join('');
  return `<div class="bd">${rows}</div>`;
}
function sourcesHtml(p, T) {
  if (!p.sources) return '';
  const STATUS_BG = { verified: '#dcfce7;color:#166534', corrected: '#dcfce7;color:#166534', unconfirmed: '#fef3c7;color:#92400e', conflict: '#fee2e2;color:#991b1b' };
  const items = Object.entries(p.sources).map(([f, s]) => {
    if (!s || !s.src) return '';
    const chip = s.status ? `<span style="background:${STATUS_BG[s.status] || '#f1f5f9;color:#475569'};padding:1px 6px;border-radius:6px;font-size:0.85em">${s.status}</span>` : '';
    const src = s.url ? `<a href="${esc(s.url)}" target="_blank" style="color:#1d4ed8;text-decoration:none">${esc(s.src)}</a>` : esc(s.src);
    return `<li><strong>${esc(f)}</strong>: ${src} ${chip}${s.checked ? ` <small style="color:#94a3b8">${s.checked}</small>` : ''}</li>`;
  }).filter(Boolean).join('');
  return items ? `<div class="dt-block"><div class="dt-title">${T.sources}</div><ul class="dt-src">${items}</ul></div>` : '';
}
// letter label → sortable rank (A best)
function labelRank(l) { const i = 'ABCDEFG'.indexOf((l || '').charAt(0)); return i < 0 ? 99 : i; }
function propGroup(r, rank, T, lang) {
  const p = r.p, t = r.total;
  const lbl = p.energy_label
    ? `<span style="background:${labelColor(p.energy_label)};color:#fff;padding:2px 8px;border-radius:8px;font-weight:700;font-size:0.9em">${p.energy_label}${p.energy_upgrade ? '<span title="' + T.upgrade + '" style="font-size:0.85em">↑</span>' : ''}</span>` : '—';
  const note = lang === 'ru' ? (p.notes_ru ? noteHtmlRu(p.notes_ru) : noteHtml(p.notes)) : noteHtml(p.notes);
  const c = verifyConfidence(p);
  const city = /,\s*Amstelveen\b/i.test(p.address) ? 'amstelveen' : 'amsterdam';
  const visited = /^visited/i.test(p.viewing || '') ? 1 : 0;
  const histo = (p.sale_history && p.sale_history.length) || (p.comps && p.comps.length);
  const timeline = (p.sale_history || []).map(h => {
    const ev = (EV[h.event] && EV[h.event][lang]) || h.event;
    const mo = String(h.date || '').length > 4 ? String(h.date).slice(0, 7) : String(h.date || '');
    return `<span style="white-space:nowrap">${h.price != null ? '€' + fmt(h.price) + ' ' : ''}<small style="color:#888">${ev}${mo ? ' ' + mo : ''}</small></span>`;
  }).join(' <span style="color:#bbb">→</span> ');
  const comps = (p.comps || []).map(cc => {
    const kind = cc.kind === 'sold' ? T.sold2 : T.asked;
    return `€${fmt(cc.price)} <small style="color:#888">(${esc(String(cc.address).replace(/,.*$/, ''))}${cc.area ? ', ' + cc.area + ' m²' : ''}, ${kind})</small>`;
  }).join(' · ');
  return `<tbody class="prop" data-addr="${esc(p.address.toLowerCase())}" data-city="${city}" data-beds="${p.bedrooms ?? ''}" data-price="${p.price ?? ''}"
 data-score="${t ?? ''}" data-conf="${c.verified}" data-eurm2="${eurM2(p) ?? ''}" data-woz="${p.woz ?? ''}" data-m2="${p.area ?? ''}" data-built="${p.build_year ?? ''}"
 data-labelrank="${labelRank(p.energy_label)}" data-costs="${monthlyAllIn(p) ?? ''}" data-emma="${p.dist_emmakade_min ?? ''}" data-zuidas="${p.dist_zuidas_min ?? ''}" data-visited="${visited}">
<tr class="main" title="${T.clickHint}">
<td style="text-align:center;font-weight:700;color:#555" class="rk">${rank + 1}</td>
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
<td style="font-size:0.8em;max-width:320px"><div class="note-clamp">${note}</div></td>
</tr>
<tr class="detail"><td colspan="18">
<div class="dt-grid">
<div class="dt-block"><div class="dt-title">${T.breakdown}</div>${breakdownHtml(r, T)}</div>
<div>
<div class="dt-block"><div class="dt-title">${T.hNotes}</div><div class="dt-note">${note}</div></div>
${histo ? `<div class="dt-block"><div class="dt-title">${T.salesTitle}</div>${timeline ? `<div style="font-size:0.9em;margin-bottom:4px">${timeline}</div>` : ''}${comps ? `<div style="font-size:0.9em">${T.comps}: ${comps}</div>` : ''}</div>` : ''}
${sourcesHtml(p, T)}
</div>
</div>
</td></tr>
</tbody>`;
}

// Compact reference row for a sold listing (no score; dimmed; "Sold" badge).
function soldRow(p, T) {
  const lbl = p.energy_label
    ? `<span style="background:${labelColor(p.energy_label)};color:#fff;padding:2px 8px;border-radius:8px;font-weight:700;font-size:0.9em">${p.energy_label}</span>` : '—';
  const SOLD_LABELS = {
    onder_bod:   { en: 'Under bid',    ru: 'Под предложением' },
    verkocht_ov: { en: 'Sold (cond.)', ru: 'Продано (усл.)' },
    off_funda:   { en: 'Off-market',   ru: 'Снято с продажи' },
    sold:        { en: 'Sold',         ru: 'Продано' },
  };
  const isRu = T.soldStatus === 'продан';
  const sl = p.sold_status && SOLD_LABELS[p.sold_status] ? SOLD_LABELS[p.sold_status][isRu ? 'ru' : 'en'] : T.soldStatus;
  const badgeBg = p.sold_status === 'onder_bod' ? '#fef3c7;color:#92400e'
                : p.sold_status === 'verkocht_ov' ? '#fed7aa;color:#9a3412'
                : '#fee2e2;color:#991b1b';
  const badge = `<span style="background:${badgeBg};padding:2px 8px;border-radius:9px;font-size:0.8em;font-weight:600">${sl}${p.sold_date ? ' ' + p.sold_date : ''}</span>`;
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
  const rows = rk.map((r, i) => propGroup(r, i, T, lang)).join('');
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
.table-wrap{overflow-x:auto;margin-bottom:36px;max-height:80vh;overflow-y:auto;border-radius:12px;border:1px solid #e6e9ef}
table{border-collapse:collapse;width:100%;background:#fff;font-size:0.875em}
th{background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:0.82em;color:#374151;white-space:nowrap;border-bottom:2px solid #e6e9ef;position:sticky;top:0;z-index:2}
th.s{cursor:pointer;user-select:none}
th.s:hover{background:#e2e8f0}
th.s.asc::after{content:" ▲";font-size:0.8em;color:#2563eb}
th.s.desc::after{content:" ▼";font-size:0.8em;color:#2563eb}
td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
tbody.prop tr.main{cursor:pointer}
tbody.prop tr.main:hover td{background:#f8fafc}
tbody.prop tr.detail{display:none}
tbody.prop.open tr.detail{display:table-row}
tbody.prop.open tr.main td{background:#eff6ff}
tr.detail>td{background:#fbfdff;border-bottom:2px solid #dbeafe;padding:14px 16px}
.note-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;max-width:320px}
tbody.prop.open .note-clamp{color:#94a3b8}
.dt-grid{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:20px}
@media(max-width:800px){.dt-grid{grid-template-columns:1fr}}
.dt-title{font-weight:700;font-size:0.85em;color:#374151;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px}
.dt-block{margin-bottom:14px}
.dt-note{font-size:0.92em;line-height:1.55;max-width:70ch}
.dt-src{margin:0;padding-left:18px;font-size:0.9em;line-height:1.7}
.bd-row{display:grid;grid-template-columns:1fr 110px 30px;gap:8px;align-items:center;padding:3px 0}
.bd-name{font-size:0.86em}
.bd-detail{font-size:0.82em;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}
.bd-bar{height:9px;background:#eef2f7;border-radius:5px;overflow:hidden}
.bd-bar i{display:block;height:100%;border-radius:5px}
.bd-na{font-size:0.75em;color:#b6bdc8;line-height:9px}
.bd-val{font-weight:700;font-size:0.86em;text-align:right}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.toolbar input[type=search]{padding:6px 10px;border:1px solid #e6e9ef;border-radius:8px;min-width:200px;font-size:0.9em;background:#fff}
.toolbar select{padding:6px 8px;border:1px solid #e6e9ef;border-radius:8px;font-size:0.9em;background:#fff}
.chip{border:1px solid #e6e9ef;background:#fff;border-radius:999px;padding:5px 12px;font-size:0.85em;cursor:pointer}
.chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
.chips{display:inline-flex;gap:4px}
.chk{font-size:0.85em;display:inline-flex;align-items:center;gap:5px;background:#fff;border:1px solid #e6e9ef;border-radius:999px;padding:5px 12px;cursor:pointer}
.count{font-size:0.82em;color:#64748b;margin-left:auto}
.hint{font-size:0.78em;color:#94a3b8;margin-bottom:8px}
.cards{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:32px}
.footer{font-size:0.82em;color:#555;border-top:1px solid #e6e9ef;padding-top:16px;line-height:1.6}
@media print{
  .toolbar,.hint{display:none}
  .table-wrap{max-height:none;overflow:visible;border:none}
  tbody.prop tr.detail{display:none !important}
  body{padding:0}
}
</style>
</head>
<body>
<h1>🏠 ${title}</h1>
<div class="subtitle">${(subtitleFn || T.subtitle)(activeF.length)}</div>

<div class="legend">
${WEIGHTS.map(c => `<div class="legend-item">${T.leg[c.key]} <strong>${Math.round(c.w * 100)}%</strong></div>`).join('\n')}
</div>
<div class="subtitle" style="margin:-16px 0 24px;font-size:0.85em">${T.legClusters}</div>
<div class="subtitle" style="margin:-16px 0 24px;font-size:0.85em">${T.legConf}</div>

<h2 style="font-size:1.1em;font-weight:700;margin-bottom:14px">🏆 ${T.top3}</h2>
<div class="cards">${cards}</div>

<h2 style="font-size:1.1em;font-weight:700;margin-bottom:12px">📋 ${T.all}</h2>
<div class="toolbar">
<input id="q" type="search" placeholder="${T.search}" autocomplete="off">
<span class="chips" id="city">
<button class="chip on" data-v="">${T.fAll}</button><button class="chip" data-v="amstelveen">Amstelveen</button><button class="chip" data-v="amsterdam">Amsterdam</button>
</span>
<select id="beds"><option value="">${T.fBeds}</option><option value="1">≥1</option><option value="2">≥2</option><option value="3">≥3</option></select>
<select id="price"><option value="">${T.fPrice}</option><option value="400000">≤ €400k</option><option value="450000">≤ €450k</option><option value="500000">≤ €500k</option><option value="550000">≤ €550k</option></select>
<label class="chk"><input id="vis" type="checkbox"> ${T.fVisited}</label>
<button class="chip" id="reset">${T.fReset}</button>
<span id="count" class="count"></span>
</div>
<div class="hint">${T.clickHint} · ${T.sortHint}</div>
<div class="table-wrap">
<table id="tbl">
<thead>
<tr>
<th>#</th><th class="s" data-k="addr" data-t="s">${T.hAddr}</th><th class="s" data-k="score">${T.hScore}</th><th class="s" data-k="conf">${T.hConf}</th><th>${T.hView}</th><th class="s" data-k="price">${T.hPrice}</th><th class="s" data-k="eurm2">€/m²</th><th class="s" data-k="woz">WOZ</th><th class="s" data-k="m2">m²</th><th class="s" data-k="beds">${T.hBeds}</th><th class="s" data-k="built">${T.hBuilt}</th><th class="s" data-k="labelrank" data-a="1">${T.hLabel}</th><th>${T.hGround}</th><th>${T.hOutdoor}</th><th class="s" data-k="costs" data-a="1">${T.hVve}</th><th class="s" data-k="emma" data-a="1">→Emma</th><th class="s" data-k="zuidas" data-a="1">→Zuidas</th><th>${T.hNotes}</th>
</tr>
</thead>
${rows}
</table>
</div>
<script>
(function(){
var tbl=document.getElementById('tbl');
var groups=[].slice.call(tbl.querySelectorAll('tbody.prop'));
var q=document.getElementById('q'),beds=document.getElementById('beds'),price=document.getElementById('price'),vis=document.getElementById('vis'),count=document.getElementById('count');
var cityWrap=document.getElementById('city'),city='';
function apply(){
  var n=0,qs=(q.value||'').toLowerCase();
  groups.forEach(function(g){
    var d=g.dataset,show=true;
    if(qs&&d.addr.indexOf(qs)<0)show=false;
    if(city&&d.city!==city)show=false;
    if(beds.value&&(+d.beds||0)<+beds.value)show=false;
    if(price.value&&(+d.price||9e9)>+price.value)show=false;
    if(vis.checked&&d.visited!=='1')show=false;
    g.style.display=show?'':'none';
    if(show)n++;
  });
  count.textContent="${T.showing}".replace('{n}',n).replace('{m}',groups.length);
  renumber();
}
function renumber(){
  var i=0;
  groups.forEach(function(g){ if(g.style.display!=='none'){ i++; g.querySelector('.rk').textContent=i; } });
}
cityWrap.addEventListener('click',function(e){
  var b=e.target.closest('.chip'); if(!b)return;
  city=b.dataset.v;
  [].slice.call(cityWrap.querySelectorAll('.chip')).forEach(function(x){x.classList.toggle('on',x===b)});
  apply();
});
[q,beds,price,vis].forEach(function(el){ el.addEventListener('input',apply); el.addEventListener('change',apply); });
document.getElementById('reset').addEventListener('click',function(){
  q.value='';beds.value='';price.value='';vis.checked=false;city='';
  [].slice.call(cityWrap.querySelectorAll('.chip')).forEach(function(x,i){x.classList.toggle('on',i===0)});
  apply();
});
// row click → expand breakdown (ignore link clicks)
tbl.addEventListener('click',function(e){
  if(e.target.closest('a')||e.target.closest('thead'))return;
  var g=e.target.closest('tbody.prop'); if(!g)return;
  g.classList.toggle('open');
});
// sortable headers
var curK='score',curAsc=false;
[].slice.call(tbl.querySelectorAll('th.s')).forEach(function(th){
  th.addEventListener('click',function(){
    var k=th.dataset.k, defAsc=th.dataset.a==='1'||th.dataset.t==='s';
    if(curK===k){curAsc=!curAsc}else{curK=k;curAsc=defAsc}
    var isStr=th.dataset.t==='s';
    groups.sort(function(a,b){
      var x=a.dataset[k],y=b.dataset[k],r;
      if(isStr){r=x<y?-1:x>y?1:0}
      else{x=x===''?null:+x;y=y===''?null:+y;
        if(x===null&&y===null)r=0;else if(x===null)r=1;else if(y===null)r=-1;else r=x-y;}
      return curAsc?r:-r;
    });
    groups.forEach(function(g){tbl.appendChild(g)});
    [].slice.call(tbl.querySelectorAll('th.s')).forEach(function(x){x.classList.remove('asc','desc')});
    th.classList.add(curAsc?'asc':'desc');
    renumber();
  });
});
apply();
})();
</script>

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
    leg: { value: 'Value (judgment)', family: 'Family fit &amp; space', condition: 'Condition',
           location: 'Location &amp; commute', energy: 'Energy label', tenure: 'Tenure / erfpacht',
           costs: 'Running costs', outdoor: 'Outdoor space', legal: 'Legal / title',
           relvalue: 'Price vs local €/m²' },
    legClusters: 'Livability ~51% (family, location, condition, outdoor) · Financial / resale ~49% (price vs local €/m², value judgment, energy, running costs, tenure, legal). Tuned for a live-in home for one adult + a 3-yo, sold in 5–10 years. Price vs local €/m², family, location, energy (incl. upgrade-potential bonus), tenure, running costs and outdoor are computed from the data; value (a condition-adjusted judgment), condition and legal are scored by hand.',
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
    search: 'Search address…', fAll: 'All', fBeds: 'Beds', fPrice: 'Max price', fVisited: 'visited only', fReset: 'Reset',
    showing: 'showing {n} of {m}', clickHint: 'Click a row for the score breakdown, full notes & sources', sortHint: 'click a column header to sort',
    breakdown: 'Score breakdown', sources: 'Verified sources', auto: 'auto', unscored: 'not scored (renormalised)',
    neigh: 'neighbourhood', upgrade: 'upgrade potential', unverifiedLbl: 'label unverified', allIn: '/mo all-in', heat: 'heating', ageRestricted: '55+ restricted', tax: 'WOZ tax', vsWoz: 'vs WOZ', vsMedian: 'vs city median',
    footer: '<strong>Methodology (model v4):</strong> Weighted score out of 10, tuned for a live-in home for one adult + a 3-yo (shared custody), sold in 5–10 years. Two clusters — <em>livability ~51%</em>: Family fit &amp; space (17%), Location &amp; commute (15%), Condition (13%), Outdoor space (6%); <em>financial / resale ~49%</em>: Price vs local €/m² (9%), Value judgment (10%), Energy label (10%), Running costs (8%), Tenure / erfpacht (7%), Legal / title risk (5%). <strong>v4 change:</strong> €/m² now outweighs the raw WOZ premium — <em>Price vs local €/m²</em> is the asking-vs-WOZ premium centred on the property\'s city median, so WOZ serves only as the location/size-aware normaliser, not a stale absolute anchor. <em>Running costs</em> are the full owner monthly = VvE + heating advance + WOZ-driven owner taxes (OZB ≈0.063% Amstelveen / ≈0.058% Amsterdam + eigenwoningforfait 0.35% × ~37% box-1), so a higher WOZ raises carrying cost. Price vs €/m², family, location, energy, tenure, running costs and outdoor are <em>computed</em> from the underlying data; value (a condition-adjusted judgment overlay: over-priced-for-condition, bidding-war temper), condition and legal are scored by hand against the rubric. Blank criteria renormalise over the ones that are scored. WOZ values are the official 2025 Kadaster LV-WOZ assessments; OZB/forfait are 2025 rates (tunable) — re-check at offer time. All data as of ' + GEN_DATE + '.',
  },
  ru: {
    title: 'Dream House — Сводка по объектам',
    subtitle: n => `Амстелвен + Амстердам Бёйтенвелдерт · все площади · проверено по Funda + второй источник · ${n} объекта · Сформировано ${GEN_DATE.split('-').reverse().join('.')}`,
    leg: { value: 'Цена (экспертно)', family: 'Для семьи &amp; площадь', condition: 'Состояние',
           location: 'Локация &amp; дорога', energy: 'Энергометка', tenure: 'Земля / эрфпахт',
           costs: 'Расходы/мес', outdoor: 'Открытое пространство', legal: 'Юр. / титул',
           relvalue: 'Цена vs €/м² (р-н)' },
    legClusters: 'Для жизни ~51% (семья, локация, состояние, открытое пространство) · Финансы / перепродажа ~49% (цена vs €/м² по району, экспертная цена, энергия, расходы/мес, земля, юр.). Настроено под жильё для одного взрослого + ребёнка 3 лет, с продажей через 5–10 лет. Цена vs €/м², семья, локация, энергия (с бонусом за потенциал), земля, расходы и открытое пространство считаются из данных; цена (экспертная поправка на состояние), состояние и юр. — экспертная оценка.',
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
    search: 'Поиск по адресу…', fAll: 'Все', fBeds: 'Спальни', fPrice: 'Цена до', fVisited: 'только посещённые', fReset: 'Сброс',
    showing: 'показано {n} из {m}', clickHint: 'Кликните по строке — разбор балла, полные заметки и источники', sortHint: 'клик по заголовку колонки — сортировка',
    breakdown: 'Разбор балла', sources: 'Проверенные источники', auto: 'авто', unscored: 'не оценено (перенормировано)',
    neigh: 'район', upgrade: 'потенциал улучшения', unverifiedLbl: 'метка не проверена', allIn: '/мес всего', heat: 'отопление', ageRestricted: 'только 55+', tax: 'налог WOZ', vsWoz: 'к WOZ', vsMedian: 'к медиане города',
    footer: '<strong>Методология (модель v4):</strong> Взвешенный балл из 10, настроен под жильё для одного взрослого + ребёнка 3 лет (совместная опека), с продажей через 5–10 лет. Два кластера — <em>для жизни ~51%</em>: Для семьи &amp; площадь (17%), Локация &amp; дорога (15%), Состояние (13%), Открытое пространство (6%); <em>финансы / перепродажа ~49%</em>: Цена vs €/м² по району (9%), Экспертная цена (10%), Энергометка (10%), Расходы/мес (8%), Земля / эрфпахт (7%), Юр. / титул (5%). <strong>Изменение v4:</strong> €/м² теперь весит больше «надбавки к WOZ» — <em>Цена vs €/м² по району</em> = надбавка цена/WOZ, центрированная по медиане города, поэтому WOZ служит лишь нормализатором по локации/площади, а не устаревшим абсолютным якорем. <em>Расходы/мес</em> — полные месячные расходы владельца = VvE + аванс за отопление + налоги от WOZ (OZB ≈0,063% Амстелвен / ≈0,058% Амстердам + eigenwoningforfait 0,35% × ~37% box-1), поэтому высокий WOZ повышает стоимость владения. Цена vs €/м², семья, локация, энергия, земля, расходы и открытое пространство <em>вычисляются</em> из данных; цена (экспертная поправка на состояние: переоценка под состояние, поправка на «торги»), состояние и юр. — экспертная оценка по рубрике. Незаполненные критерии перенормируются по заполненным. Значения WOZ — официальные оценки Kadaster LV-WOZ за 2025 г.; ставки OZB/forfait — 2025 г. (настраиваемые) — перепроверьте перед сделкой. Данные на ' + GEN_DATE + '.',
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
  (()=>{})(file, html);
  return ver;
}

// ---- run ----
// Amstelveen-only view: match the city segment of "Street nr, City" (Buitenveldert
// entries end in ", Amsterdam"), not a bare substring.
const isAmstelveen = p => /,\s*Amstelveen\b/i.test(p.address || '');
(()=>{})(path.join(DIR, 'property_summary.html'), buildSummary('en'));
(()=>{})(path.join(DIR, 'property_summary_ru.html'), buildSummary('ru'));
(()=>{})(path.join(DIR, 'property_summary_amstelveen.html'),
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
// v3: only the three manual score keys are required; the rest are computed.
const REQUIRED_KEYS = ['value', 'condition', 'legal'];
for (const r of ranked) {
  const s = r.p.scores || {};
  const missing = REQUIRED_KEYS.filter(k => s[k] == null);
  if (missing.length) console.warn(`  ${r.p.address}: missing manual scores [${missing.join(', ')}]`);
  // a hand value on a computed criterion is an explicit override — keep it visible
  if (r.eff.overridden.length) console.warn(`  OVERRIDE ${r.p.address}: manual value on computed criteria [${r.eff.overridden.join(', ')}]`);
  // ground string present but not in the tenure map → criterion silently renormalises
  if (r.p.ground != null && TENURE_SCORE[r.p.ground] == null)
    console.warn(`  TENURE-UNMAPPED ${r.p.address}: "${r.p.ground}" (add to TENURE_SCORE)`);
  // after a physical viewing the outdoor space is observable — record it
  if (/^visited/i.test(r.p.viewing || '') && !r.p.outdoor_space)
    console.warn(`  VISITED-NO-OUTDOOR ${r.p.address}: record outdoor_space from the viewing`);
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

// ---- APPENDED: rating dump (reuses weightedTotal/data/active above) ----
(function(){
  const idOf = u => { if(!u) return null; const m=(u.match(/\d{6,}/g)||[]); return m.length?m[m.length-1]:null; };
  const rows = data.map(p => ({ addr:p.address, sold:p.sold===true, ss:p.sold_status||'', rating:weightedTotal(p), id:idOf(p.url), url:p.url }));
  const sold = rows.filter(r=>r.sold).sort((a,b)=>(b.rating||0)-(a.rating||0));
  console.log('=== SOLD listings rating (desc) ===');
  sold.forEach(r=> console.log((r.rating==null?'  NA':r.rating.toFixed(2))+'  '+(r.ss).padEnd(11)+'  '+r.addr));
  console.log('\n=== SOLD with rating > 7.0 (reactivation re-check scope) ===');
  const over = sold.filter(r=> r.rating!=null && r.rating>7.0);
  over.forEach(r=> console.log(r.rating.toFixed(2)+'  '+(r.ss).padEnd(11)+'  '+r.addr+'  ||  '+r.url));
  console.log('COUNT_OVER7 = '+over.length);
})();
