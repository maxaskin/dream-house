# Instructions — build the property "summary" HTML

Reusable spec for (re)generating `property_summary.html`: a single, self-contained, printable page that ranks every evaluated property. Follow this whenever `property_data.json` changes or a fresh summary is requested.

## Goal

One standalone `.html` file (opens in any browser, no server, no external assets) showing all properties ranked by weighted score, with a full detail table + top-3 cards + a methodology footer. Save it to the project folder as `property_summary.html`.

## Data source

Read from `property_data.json` (the single source of truth). Each property object uses these fields:

- `address` (string, "Street nr, City") · `url` (Funda link ONLY)
- `price` (€, int) · `area` (m², int or null) · `bedrooms` (int)
- `woz` (€ or null) · `build_year` (int) · `energy_label` ("A"–"G")
- `ground` ("Eigen grond" | "Erfpacht afgekocht" | "Erfpacht lopend" | null)
- `vve_costs` (€/mo or null) · `*_estimated` flags (bool) where a value is an estimate
- `dist_emmakade_min`, `dist_zuidas_min` (bike minutes, int)
- `scores`: `{ price, legal, dist_emmakade, location, energy, dist_zuidas }` each 1–10
- `notes` (string) · optional `heritage` (string) · `date_found`, `source`

## Scoring model (must match the artifact and the agents)

Weighted total, out of 10. Weights:

| Criterion | key | weight |
|---|---|---|
| Price & €/m² vs WOZ | price | 35% |
| Legal / risk | legal | 25% |
| Distance to Emmakade 33 | dist_emmakade | 15% |
| Energy label (+ upgrade upside) | energy | 15% |
| Distance to Zuidas | dist_zuidas | 10% |

Base weights sum to 100%. **Renovation is a deduction, not a positive weight**: still scored 1–10 (move-in ready high, fixer low), then applied as `total -= max(0, 6 − renovation) × 0.3` — decent/move-in-ready places lose nothing; fixers lose up to ~1.5 pts. (Location was removed from the model.)

`total = Σ(score × weight) / Σ(weight of scored criteria)` — i.e. blank criteria renormalise over the ones that are scored. Round to 2 decimals for display. Sort descending.

## Layout (top to bottom)

1. **Header**: title "Dream House — Property Summary"; subtitle line (segment list: "Amstelveen + Amsterdam Buitenveldert · all sizes · verified vs official Funda + a second source · <count> properties"). No bedroom limit.
2. **Weights legend**: the six criteria with their percentages.
3. **Detail table** (one row per property, sorted by score), columns:
   `# · Address (Funda link) · Score (colored pill) · Viewing (badge) · Price · €/m² · WOZ · m² · Beds · Built · Label (colored) · Ground · VvE · Bike→Emma · Bike→Zuidas · Notes & flags`

   Viewing badge: value is "No" (muted), "Scheduled YYYY-MM-DD" (amber), or "Visited YYYY-MM-DD" (green). WOZ cell also shows the asking-vs-WOZ premium (e.g. "+43% ask", green if ≤0).
4. **Top-3 detail cards**: the three highest scores, each with price, €/m², area, beds, label, ground, bike times. Highlight rank 1 (2px border).
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

## Keep in sync

`property_summary.html` (this page), `property_ranking.html` (the live artifact, with its own `SEED` array + `SEED_VERSION` bump on data changes), and `property_data.json` must all carry the same numbers. When data changes: update the JSON first, then regenerate this summary and bump the artifact's `SEED_VERSION`.
