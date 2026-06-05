# Dream House — Evaluation Report

_Generated 2026-05-31. Covers the three requested stages: (1) evaluate the ranking system, (2) detect sources & verify, (3) improvements. Data set: **22 properties** in `property_data.json` (the plan said 25; the actual count is 22 — see Finding D-0)._

---

> ## Addendum 2026-06-05 — scoring model redesigned
>
> The 5-criterion model documented below (price 35 / legal 25 / dist_emmakade 15 / energy 15 / dist_zuidas 10, minus a renovation deduction) has been **superseded**. It was re-tuned for the buyer's actual brief — a **live-in home for one adult + a 3-yo (shared custody), to be sold in 5–10 years** — into eight criteria in two clusters (livability ~55% / financial ~45%):
>
> | Criterion | key | weight | | Criterion | key | weight |
> |---|---|---|---|---|---|---|
> | Value at entry | `value` | 20% | | Energy label | `energy` | 10% |
> | Family fit & space | `family` | 18% | | Tenure / erfpacht | `tenure` | 10% |
> | Condition | `condition` | 15% | | Outdoor space | `outdoor` | 7% |
> | Location & commute | `location` | 15% | | Legal / title | `legal` | 5% |
>
> Key changes: bedrooms/space and outdoor space are now scored (the child finally counts); value-vs-WOZ and erfpacht are split out of the old "price"/"legal" buckets; the two correlated commute distances are **merged into one `location` score** (resolving the double-count caveat in Stage 3 below); and the renovation deduction is gone — `condition` is a normal positive criterion. Canonical definition lives in `build.js` `WEIGHTS`; rubric in `INSTRUCTIONS_build_summary_html.md`. The Stage-1 table and rankings below reflect the **old** model and are kept for history.

---

## Stage 1 — Ranking-system evaluation

### The model (confirmed correct & internally consistent)
Engine in `property_ranking.html` (`WEIGHTS`, `weightedTotal`) and the spec now agree:

| Criterion | weight |
|---|---|
| Price & €/m² vs WOZ | 35% |
| Legal / risk | 25% |
| Bike → Emmakade 33 | 15% |
| Energy label | 15% |
| Bike → Zuidas | 10% |

`total = Σ(score×weight) / Σ(weight of scored criteria) − renoDeduct`, where `renoDeduct = max(0, 6 − renovation) × 0.3` (fixers lose up to 1.5 pts; move-in-ready loses nothing). Blank criteria renormalize.

### Recomputed ranking (all 22, canonical model)

| # | Total | Property | €/m² |
|--:|--:|---|--:|
| 1 | 7.70 | Catharina van Clevepark 40 | 5.706 |
| 2 | 7.60 | Laanhorn 2 | 6.908 |
| 3 | 7.00 | Ferdinand Bolweg 35 | 5.449 |
| 4 | 6.65 | Meander 1101 | 3.950 |
| 5 | 6.60 | Onstein 134 | 6.091 |
| 6 | 6.45 | Haya van Somerenlaan 102 | 5.495 |
| 7 | 6.15 | Sint Philipsland 101 | 5.443 |
| 8 | 6.10 | Wedderborg 25 | 7.388 |
| 9 | 5.70 | Pruimenlaan 42 | 5.438 |
| 10 | 5.65 | Zonnesteinhof 24 | 5.592 |
| 11 | 5.65 | Arent Janszoon Ernststraat 795-K | 6.875 |
| 12 | 5.55 | Schierstins 56 | 7.090 |
| 13 | 5.45 | Kiefskamp 15 | 7.610 |
| 14 | 5.35 | Bolestein 13-B | 7.596 |
| 15 | 5.20 | Populierenlaan 175 | 4.938 |
| 16 | 5.20 | Mr. Troelstralaan 30 | 6.180 |
| 17 | 5.10 | Bijdorp 11 | 6.000 |
| 18 | 4.95 | De Boelelaan 305 | 5.357 |
| 19 | 4.75 | Van Heuven Goedhartlaan 458 | 6.377 |
| 20 | 4.60 | Lindenlaan 559 | 6.056 |
| 21 | 4.40 | Van Heuven Goedhartlaan 520 | 6.077 |
| 22 | 4.20 | Merckenburg 38 | 6.385 |

### Defects found

| ID | Severity | Finding | Status |
|---|---|---|---|
| **D-0** | info | Project carries **22** properties, not 25 (JSON, SEED, both summaries all agree at 22). | noted |
| **D-1** | **high** | Ranking **form + rubric labels read 30% / 20%** (sum 80%) while the engine uses **35% / 25%**. Anyone scoring a new property by hand was mis-weighting it. | **fixed** |
| **D-2** | medium | Three `notes` embedded a hard-coded **"Weighted score X"** that disagreed with the live engine: Meander 1101 said 7.1 (actual **6.65**), Onstein 134 said 7.1 (actual **6.60**), Kiefskamp 15 said 6.2 (actual **5.45**). These strings propagated into the summaries. | **fixed** (stripped) |
| **D-3** | low | Spec `INSTRUCTIONS…md` listed a `location` key in `scores` that was removed from the model. | **fixed** |
| **D-4** | **high** | The four artifacts were kept in sync **by hand** — the structural risk behind D-1/D-2. The summaries are statically rendered HTML with no shared generator. | **fixed** via `build.js` |
| **D-5** | info | Score pills already matched the engine in both summaries (no display mismatch) — the drift was confined to the note text and the form labels. | verified |

### Model commentary (design notes, not changed)
- **Renovation as a one-sided penalty** means a pristine, fully-renovated flat earns *nothing* for condition — it only avoids a deduction. If move-in-ready quality should be rewarded, consider a small symmetric bonus. Current behaviour is internally consistent and intentional per the spec.
- **Location weight is effectively 25%** split across two correlated distances (Emmakade 15% + Zuidas 10%). For the Zuidas-centric brief this is reasonable, but the two are correlated, so a property near one tends to score the other — worth being aware of when reading totals. _(Resolved 2026-06-05: merged into a single `location` criterion — see the addendum at the top.)_

---

## Stage 2 — Sources & verification

### 2a. Provenance map (where today's values came from)
Every record's origin is encoded in `source` + the `notes` prose:

| `source` tag | meaning | count | typical fields backed |
|---|---|--:|---|
| `funda` | live official Funda listing | 3 | price, area, beds, label, ground, VvE (strong) |
| `digest` | daily e-mail digest → makelaar microsite | 5 | price + microsite details |
| `reaction` | Max reacted to a (now often delisted) listing | 14 | price from reaction; other fields back-filled from Kadasterdata/Huispedia/comparables (weaker) |

Per-field confidence flags already in the data: `bedrooms_verified`, `ground_verified`, `area_estimated`, `energy_estimated`, `vve_estimated`, plus `woz: null` on 4 records (Bolestein 13-B, Wedderborg 25, Onstein 134, Kiefskamp 15).

### 2b. Authoritative public registers (added to the spec)
| Field | Register | URL |
|---|---|---|
| area + build year | BAG viewer (Kadaster) | bagviewer.kadaster.nl |
| energy label | EP-Online (RVO) | ep-online.nl |
| WOZ | WOZ-waardeloket | wozwaardeloket.nl |
| ground / erfpacht | Kadaster + Amsterdam erfpacht map | kadaster.nl · maps.amsterdam.nl |
| price / status / VvE | Funda | funda.nl |

### 2c. Live verification — what actually happened (honest result)
**Full automated re-verification of 22 × ~7 fields is not achievable with the available tooling, and no values were fabricated.** Live attempts on 2026-05-31:

- **Funda** → returns a bot **security interstitial**; not scrapeable.
- **Huispedia** → **HTTP 403**.
- **EP-Online / WOZ-loket / BAG viewer** → JavaScript single-page apps; no static content to fetch. (The data's own notes already record "WOZ not retrievable via loket (JS)".)
- **Kadasterdata** → fetchable, but returns **building-level / stale** figures that conflict with the Funda-verified unit data.
- **WebSearch** → returns synthesized snippets (sometimes correct, e.g. confirmed Catharina 40 WOZ €418k / label A) but is not an authoritative source.

**Genuine finding from the spot-check (logged in the data):** for **Catharina van Clevepark 40**, kadasterdata.nl shows **98 m² / WOZ €309.000 (2020)** versus the Funda-verified **85 m² / WOZ €418.000** in our data. This is almost certainly the aggregator showing a gross/building figure and a stale 2020 WOZ — but it is exactly the kind of conflict to resolve at the viewing. Captured in `property_data.json` under that property's new `sources` block with `status: "conflict"/"unconfirmed"`.

**Conclusion:** the reliable verification path for this project is **manual confirmation against the authoritative register per address** (the existing Funda-verified records are already the best available). `build.js` + the `sources` schema give a place to record each such check with a URL, date, and status, so verification accrues over time instead of being re-litigated in prose.

---

## Stage 3 — Improvements delivered

1. **Fixed scoring inconsistencies (D-1, D-2, D-3).** Ranking form + rubric now read 35% / 25%; stale "Weighted score X" strings removed from the three notes; spec `scores` field list corrected.
2. **Added source provenance.** Optional, back-compatible `sources` block (schema documented in `INSTRUCTIONS…md`). Populated as a real worked example on Catharina van Clevepark 40, including the live conflict above.
3. **Filled gaps — framework, not fabrication.** The register list + `sources.status` give a repeatable way to resolve the 4 null-WOZ and the `*_estimated` fields. Values are **not** invented; each must be confirmed against the authoritative register (see 2c).
4. **Single build script (`build.js`).** One canonical weight model; regenerates `property_ranking.html` (SEED + `SEED_VERSION`), `property_summary.html`, and `property_summary_ru.html` from `property_data.json`. RU keeps its existing translated notes (keyed by address). This removes the manual 4-file sync that caused D-1/D-2/D-4.

### Verification of this change
- `node build.js` → 22 properties; `SEED_VERSION` bumped; top 3 = Catharina 7.7 · Laanhorn 7.6 · Ferdinand Bolweg 7.0.
- Cross-file check: JSON / EN summary / RU summary / SEED all **22 rows**; **0** score-pill mismatches vs the engine; **0** stale per-property "Weighted score" strings; RU notes preserved (Cyrillic intact); no `(30%)/(20%)` labels remain; every `url` on `funda.nl`; no unexplained €/m² outside €3.000–€8.000.

## Recommended follow-ups
- ~~Add `notes_ru` to the schema so the RU summary is fully regenerable.~~ **Done** — all 22 properties now carry `notes_ru`; `build.js` renders RU from it with Russian flag highlighting and falls back to the EN note (logging any gaps) for new entries.
- Render a small source indicator in the summary's flags column once `sources` is populated more widely.
- Resolve the 4 `woz: null` records and all `*_estimated` fields by manual register checks, recording each in `sources`.
- Re-confirm reaction-only (delisted) listings or mark them stale; 14 of 22 are reaction-sourced.
