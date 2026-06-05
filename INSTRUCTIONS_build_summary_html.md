# Instructions — build the property "summary" HTML

Reusable spec for (re)generating `property_summary.html`: a single, self-contained, printable page that ranks every evaluated property. Follow this whenever `property_data.json` changes or a fresh summary is requested.

## Goal

One standalone `.html` file (opens in any browser, no server, no external assets) showing all properties ranked by weighted score, with a full detail table + top-3 cards + a methodology footer. Save it to the project folder as `property_summary.html`.

## Data source

Read from `property_data.json` (the single source of truth). Each property object uses these fields:

- `address` (string, "Street nr, City") · `url` (Funda link ONLY)
- `price` (€, int) · `area` (m², int or null) · `bedrooms` (int)
- `woz` (€ or null) · `build_year` (int) · `energy_label` ("A"–"G")
- `ground` (free-text NL string, e.g. "Eigen grond" / "Erfpacht afgekocht" / "Erfpacht lopend" / "Erfpacht (status onbekend)" | null) — **every distinct value must have a matching key in `GROUND_RU` in `build.js`** (see "Keep in sync")
- `vve_costs` (€/mo or null) · `*_estimated` flags (bool) where a value is an estimate
- `dist_emmakade_min`, `dist_zuidas_min` (bike minutes, int) — feed the `location` score
- `outdoor_space` (string or absent) — canonical token + optional size, e.g. `"balcony ~7 m²"`, `"terrace (west)"`, `"garden ~15 m²"`. Token must be one of `none | shared | balcony | loggia | terrace | roof terrace | garden` and **have a matching key in `OUTDOOR_RU` in `build.js`** (same discipline as `GROUND_RU`). Omit the field when the listing gives no outdoor info — the `outdoor` score is then left unscored and renormalises (don't guess).
- `scores`: `{ value, family, condition, location, energy, tenure, outdoor, legal }` each 1–10. `outdoor` is optional (omit when unknown); `tenure` is omitted when `ground` is null.
- `sale_history` (array, optional): structured prior transactions/relistings — `[{ date:"YYYY-MM[-DD]", price:int|null, event, src }]`, `event ∈ purchase | listed | relisted | withdrawn | under_offer | sold | price_change`. Rendered in the "Sales history & comparable prices" appendix; `purchase`/`sold` entries also drive the top-3 "Prior sale" line. Migrate from `notes` rather than leaving sale data only in prose.
- `comps` (array, optional): comparable sold/asking units — `[{ address, price:int, date, area:int|null, kind:"sold"|"asking", note }]`. Rendered in the appendix + top-3 cards.
- `notes` (string) · optional `heritage` (string) · `date_found`, `source`
- `sources` (object, optional) — per-field provenance; now **read by `build.js`** to compute verification confidence (see "Verification confidence & triggers").

## Scoring model (must match the artifact and the agents)

Weighted total out of 10, tuned for the buyer's real brief: a **live-in home for one adult + a 3-yo (shared custody), to be sold in 5–10 years**. Two clusters — livability ~55%, financial/resale ~45%.

| Criterion | key | weight | cluster | Rubric (1–10) |
|---|---|---|---|---|
| Value at entry | `value` | 20% | financial | From asking-vs-WOZ premium + €/m² vs local comps. ≤WOZ & cheap €/m² → 9–10; +5–10% → 6; +18–28% → 4; >28% or overpriced-for-condition → 3. Temper for low-ask bidding-war listings. |
| Family fit & space | `family` | 18% | living | ≥3 bed & ≥85 m² → 10; 2 bed ≥75 m² → 8; 2 bed 55–65 m² → 6; 1 bed → 3; studio → 2. **Age-restricted (55+) → 1** (a child can't live there). |
| Condition / move-in ready | `condition` | 15% | living | Fully renovated/move-in → 9; modernised → 7–8; dated → 4–5; full gut needed → 2–3. |
| Location & commute | `location` | 15% | living | Blend bike→Emmakade (≤7 min →10) ~60% + bike→Zuidas (≤6 min →10) ~40%; then ±1 for neighbourhood family-friendliness (quiet/green +, busy arterial −). |
| Energy label | `energy` | 10% | financial | A=10 · B=9 · C=7 · D=5 · E=4 · F=3 · G=2. |
| Tenure / erfpacht | `tenure` | 10% | financial | Eigen grond → 10; erfpacht eeuwigdurend afgekocht → 9; afgekocht fixed-term → 7; lopend (canon, future revision) → 4–5; status onbekend/te verifieren → 3. Omit if `ground` is null. |
| Outdoor space | `outdoor` | 7% | living | Garden → 9–10; large terrace → 8; terrace → 7; balcony → 5–6; loggia → 5; none/shared → 2–3. Omit (renormalise) if unknown. |
| Legal / title risk | `legal` | 5% | financial | Residual **non-erfpacht** risk only. Start ~8; deduct for VvE problems, disclosure conflicts, missing splitsingsakte, heritage limits, 55+ ballotage, structural/pile risk, ex-rental clauses. |

Livability = 18+15+15+7 = 55%; financial = 20+10+10+5 = 45%. **No renovation deduction** — condition is now a normal positive criterion. (Earlier models used `price/legal/dist_emmakade/dist_zuidas/renovation`; that scheme is retired.)

`total = Σ(score × weight) / Σ(weight of scored criteria)` — i.e. blank criteria (e.g. unknown `outdoor`/`tenure`) renormalise over the ones that are scored. Round to 2 decimals for display. Sort descending.

## Layout (top to bottom)

1. **Header**: title "Dream House — Property Summary"; subtitle line (segment list: "Amstelveen + Amsterdam Buitenveldert · all sizes · verified vs official Funda + a second source · <count> properties"). No bedroom limit.
2. **Weights legend**: the eight criteria with their percentages, plus a one-line cluster note (livability ~55% / financial ~45%).
3. **Detail table** (one row per property, sorted by score), columns:
   `# · Address (Funda link) · Score (colored pill) · Viewing (badge) · Price · €/m² · WOZ · m² · Beds · Built · Label (colored) · Ground · Outdoor · VvE · Bike→Emma · Bike→Zuidas · Notes & flags`

   Viewing badge: value is "No" (muted), "Scheduled YYYY-MM-DD" (amber), or "Visited YYYY-MM-DD" (green). WOZ cell also shows the asking-vs-WOZ premium (e.g. "+43% ask", green if ≤0). Outdoor cell shows `outdoor_space` ("?" when absent), RU-translated via `OUTDOOR_RU`.
4. **Top-3 detail cards**: the three highest scores, each with price, €/m², area, beds, label, ground, outdoor, bike times. Highlight rank 1 (2px border).
5. **Footer**: one paragraph on methodology + the estimate caveat.

## Visual conventions

- Self-contained: inline CSS, no external fonts/scripts. Light mode (`color-scheme: light`), white surfaces, 1px `#e6e9ef` borders, radius 12px cards.
- **Score pill color** (by total): `≥7.5` green `#15803d` · `≥6.5` blue `#2563eb` · `≥5.5` amber `#d97706` · `<5.5` red `#dc2626`.
- **Energy label color**: A `#15803d` · B `#65a30d` · C `#84a017` · D `#d97706` · E `#ea7317` · F `#dc2626` · G `#b91c1c`.
- **€/m²** = `round(price / area)`; show "—" when area is null.
- **VvE cell**: prefix `~` when estimated, show `n/a` for houses (no VvE), `?` when unknown.
- Numbers formatted `nl-NL` (e.g. €485.000). Round every displayed number.
- Highlight `FLAG`/`FLAGS`/`CONFLICT`/`CORRECTED` words in notes (e.g. amber/red emphasis).
- **Links: Funda only.** Use the property's official Funda detail URL; fall back to a Funda street-search URL only if no detail page is known.

## Build steps

1. Read `property_data.json`; embed the records inline in a `<script>` `DATA = [...]` array (so the file is fully self-contained), OR fetch-and-render if kept dynamic. Embedding is preferred for a portable file.
2. Compute totals with the weights above; sort descending; render table + cards + footer.
3. Mark estimated fields (`~`, "est", "verify") from the `*_estimated` flags / notes.
4. Save to `/property_summary.html` in the project folder.

## Verification (always do before finishing)

- JSON parses; row count matches `property_data.json`.
- Each row's displayed `total` equals the recomputed weighted score (diff < 0.001).
- No `€/m²` outliers slip through unexplained (sanity-check < €3,000 or > €8,000).
- Every `url` is on `funda.nl` (no other domains).
- Confirm the file renders, then present it to the user with the file-sharing tool.

## Keep in sync — use `build.js`

`property_data.json` is the single source of truth. **Do not hand-edit the HTML** — run the build script:

```
node build.js            # regenerates property_summary.html + property_summary_ru.html,
                         # and stamps index.html footer with an incrementing build # + today's date
BUILD_DATE=2026-06-05 node build.js   # override the "Generated" date
```

`build.js` defines the weight model in ONE place and recomputes every total, so `property_summary.html` and `property_summary_ru.html` can no longer drift. Edit `property_data.json`, then rebuild.

**Ground lease (RU):** the `ground` field is free-text Dutch, and the RU summary translates it via the `GROUND_RU` map in `build.js`. Whenever you add a property — or edit a property's `ground` — with a Dutch value not already a key in `GROUND_RU`, **add its Russian translation to `GROUND_RU` in the same change**. `build.js` logs `ground not translated for RU` for any unmapped value; treat that warning as a build failure to fix, not a value to leave as untranslated Dutch in the RU output. (Same discipline as `notes_ru` below.)

**Outdoor space (RU):** `outdoor_space` uses a canonical English token (`none | shared | balcony | loggia | terrace | roof terrace | garden`) optionally followed by a size/side (e.g. `"balcony ~7 m²"`). The RU summary translates the leading token via the `OUTDOOR_RU` map. Any new token must get an `OUTDOOR_RU` entry in the same change — `build.js` logs `outdoor_space token not translated for RU`; treat as a build failure.

**Scores (per property):** when adding/editing a property, set the six required scores (`value, family, condition, location, energy, legal`) plus `tenure` when `ground` is known and `outdoor` when outdoor info exists, per the rubric in "Scoring model". `build.js` logs `missing scores [...]` for any required key it can't find — treat as a build failure.

**Russian summary:** each property carries a `notes_ru` field (plain Russian text). `build.js` renders the RU summary from `notes_ru`, applying the same flag highlighting to the Russian tokens `ПРОВЕРЕНО · ИСПРАВЛЕНО · РАСХОЖДЕНИЕ · КОНФЛИКТ · ФЛАГ · РИСК`. If a new property has no `notes_ru`, the RU summary falls back to the English `notes` and `build.js` logs which are missing — so add a `notes_ru` alongside `notes` for every new entry.

### Optional `sources` provenance block

Each property may carry an additive `sources` object documenting where each field was verified (back-compatible; the renderer ignores unknown keys):

```json
"sources": {
  "energy_label": { "value": "A", "src": "EP-Online", "url": "https://ep-online.nl", "checked": "2026-05-31", "status": "verified" }
}
```

`status` ∈ `verified | corrected | unconfirmed | conflict`. Authoritative public registers: **BAG** (bagviewer.kadaster.nl — area + build year), **EP-Online** (ep-online.nl — energy label), **WOZ-waardeloket** (wozwaardeloket.nl — WOZ), **Kadaster**/Amsterdam erfpacht map (ground lease), **Kadaster koopsom** (transaction history → `sale_history`). Note: Funda and most registers are bot-/JS-gated, so automated scraping is unreliable — treat aggregator (kadasterdata/huispedia) figures as a second opinion that can show stale or building-level data, and confirm against the authoritative register before relying on a value.

## Verification confidence & triggers

`build.js` reads the `sources` block + `*_estimated`/`*_verified` flags to score each property's **data confidence** over six decision-critical `KEY_FIELDS` = `price, area, woz, energy_label, ground, bedrooms`. Per field, `fieldState()` resolves to `verified` (source `status: verified`/`corrected`, or a `*_verified:true` flag), `conflict` (`status: conflict`), `estimated` (`status: unconfirmed` or `*_estimated:true`), `unknown` (value null), else `assumed` (a value with **no** independent source — e.g. taken from the listing only; counts as *not* verified). The summary shows a **`Conf.` pill** `✓N/6` (green ≥5 · amber ≥3 · red <3; `⚠` on any conflict; hover for the unverified fields).

**Tiered verification policy** — rigor scales with how serious a property is; `build.js` warns when a tier's expectations aren't met:

| Tier | Trigger | Verify (independent source) | build.js warning |
|---|---|---|---|
| **0 — Intake** | every property added | Funda listing; WOZ (WOZ-waardeloket); EP-Online if a label is registered | — |
| **1 — Shortlist** | viewing scheduled/visited, or a high score | BAG area; EP-Online label; **Amsterdam erfpacht** register (ground/tenure); Kadaster *koopsom* (→ `sale_history`); 2–3 `comps` | `TIER-1 …: unverified ground, area, energy_label` for any viewed/scheduled property whose those fields aren't `verified` |
| **2 — Pre-offer** | offer contemplated | full seller-document due diligence (the 18-doc set: vragenlijst, akte, splitsingsakte, MJOP, VvE notulen/balans, NEN2580, energielabel, opstalpolis, funderingsattest…) | — |

Other verification warnings `build.js` emits: `CONFLICT …` (any field `status: conflict`), `STALE …` (a source `checked` > 180 days before the build date), `STALE-WOZ …` (WOZ `peildatum` older than its own history), `LOW-CONF #n …` (a top-10 property with < 50% of key fields verified). Treat these as a worklist of what to fetch next — they do **not** fail the build.
