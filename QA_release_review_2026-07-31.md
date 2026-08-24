# QA / Release-Readiness Review — Dream House project

**Date:** 31-07-2026 · **Scope:** build.js logic, property_data.json (154 entries), workspace hygiene
**Verdict: PASS.** One scoring model (v5) now applies to all 154 entries; zero schema warnings; workspace reorganised non-destructively.

---

## 1. What was wrong

### 1a. Two scoring schemas coexisted (the main defect)
**47 entries** still carried the retired **v2 score schema** (`price / dist_emmakade / energy / dist_zuidas / renovation`, scored **1–5**). Under the current v5 model this had two silent effects:

1. The legacy `energy` key (1–5 scale) **collided with** the v5 computed `energy` criterion (1–10 scale) and acted as a hard override — e.g. a label-B home scored energy 6/10 instead of the computed 9/10.
2. `value` and `condition` (23% of total weight) were **absent and renormalised away**, so these 47 entries were ranked on a partially different model than the other 107.

The build's own self-check had been flagging every one of these (`OVERRIDE … manual value on computed criteria [energy]`) — ~48 warnings per build, drowning the signal.

### 1b. Unmapped tenure strings (criterion silently dropped)
5 `ground` string variants were absent from `TENURE_SCORE` and `GROUND_RU`, so for ~9 entries the tenure criterion (7%) was dropped entirely and the RU summaries showed untranslated Dutch.

### 1c. Inconsistent archive key
Two names for the same concept: `scores_legacy` (Ferdinand Bolweg 81) vs `scores_legacy_v2` (Noorderkroon 32, introduced yesterday).

### 1d. Workspace clutter
34 timestamped `.bak` files, 8 scratch/test files, a one-off script, a v4-era CSV export and a superseded doc review in the project root; a stale `.git/index.lock` (0 bytes, 21-07) blocking git commits.

## 2. What was changed

| # | Change | Detail |
|---|---|---|
| 1 | **Migrated all 47 legacy entries** | Full old dict archived to `scores_legacy`; `scores` now holds only the still-valid manual `legal`. `value`/`condition` left honestly unscored (renormalise + appear on the build worklist) rather than invented |
| 2 | **Unified archive key** | `scores_legacy_v2` → `scores_legacy` (one convention project-wide; 49 entries now carry an archive) |
| 3 | **build.js: +5 `TENURE_SCORE` mappings** | `Eigen grond (aanname, te verifieren)` → 8 · `Eigen grond (aanname, niet geverifieerd)` → 8 · `…o.b.v. buurpand 422…` → 8 · `Erfpacht (afgekocht t/m 30-06-2035)` → 7 · `Erfpacht (aanname, status niet bevestigd)` → 3 — all scored by analogy with existing variants |
| 4 | **build.js: +5 `GROUND_RU` translations** | Same strings; RU summaries now fully translated |
| 5 | **Troelstralaan 30 `outdoor_space`** | Recorded from the 21-07 viewing notes: `balcony (rear + French front, no garden)` — clears its VISITED-NO-OUTDOOR flag |
| 6 | **Workspace** | `backups/` (44 .bak files, incl. today's pre-migration snapshot) · `archive/` (EVALUATION_REPORT.md, ranking_v4.csv, _update_sold.py, superseded doc_review_DrEykmanstraat26.md — none referenced anywhere) · `_to_delete/` (test/scratch files + stale git locks — **empty this folder yourself**; I can move but not delete on your disk) |
| 7 | **Git unblocked** | Stale `.git/index.lock` + `objects/maintenance.lock` moved out |
| 8 | Rebuilt | All three summaries + index.html (build #128, dated 2026-07-31) |

Nothing was deleted; every removed assessment is preserved in `scores_legacy` or `backups/`/`archive/`.

## 3. Ranking impact (expected and correct)

22 of 69 active entries moved ≥0.02. All movements trace to exactly two mechanisms: legacy energy override removed (score now follows the label table), or a previously-dropped tenure/outdoor criterion restored.

| Biggest movers | Before → After | Cause |
|---|---|---|
| Rosa Spierlaan 426 | 5.42 → 5.96 | tenure was unmapped (dropped), now 8/10 |
| Holy 31 | 5.44 → 5.88 | tenure unmapped, now 7/10 |
| **Donau 122** | 7.57 → **7.85 (new #1)** | label B: override 6 → computed 9 |
| Van Nijenrodeweg 421 | 7.01 → 7.29 | same mechanism |
| Kringloop 55 | 7.81 → 7.67 (now #2) | label D: override 6 → computed 5 — the old #1 was **flattered** by its legacy override |
| Mr. Troelstralaan 30 | 6.68 → 6.58 | outdoor now honestly scored (balcony, no garden) |

Top 3 now: **Donau 122 (7.85) · Kringloop 55 (7.67) · Mr. F.A. van Hallweg 114 (7.56)**. Noorderkroon 32 unchanged at 7.13 (#15) — it was migrated yesterday. No bid advice in any doc review is affected: those are document-based judgments, not model outputs.

## 4. Verified clean

- JSON valid, 154 entries, no duplicates, no legacy keys left in any `scores`, no mixed schemas
- Build: **0** OVERRIDE, **0** TENURE-UNMAPPED, **0** untranslated-ground warnings (was ~61 combined)
- All `.md` files referenced from the database exist on disk
- notes_ru coverage: all 154 translated
- Veto gates (budget/legal/LIB/55+) fire correctly on 4 entries — by design

## 5. Remaining known items (deliberate, not defects)

1. **30 active entries lack hand `value`/`condition` scores** — the honest worklist the build prints; scoring them requires per-property judgment (docs/viewings), not cleanup. They renormalise meanwhile.
2. **VALUE-RUBRIC (top-15):** Meander 37 and Bosboom-Toussaintlaan 43 carry pre-v4 `value` scores — re-score per the v4 rubric when convenient.
3. **STALE-WOZ Meander 407:** peildatum 01-01-2024 on file while a 2026 aanslag (peildatum 2025) should exist — re-fetch from wozwaardeloket.
4. **Haya van Somerenlaan 102:** visited 02-06 but no outdoor_space recorded and ground/area/label unverified (TIER-1) — nothing in the notes to fill it from.
5. **15 CONFLICT + 1 LOW-CONF flags** — intentional data-conflict tracking in `sources`; each lists its resolution path.
6. **€/m² out-of-range warning** (Van Heenvlietlaan 250-D, €10,435/m²) — legitimate: it's a 23 m² studio, not a data error.
7. **Cloud placeholders:** `setup.sh`, `.gitignore`, `INSTRUCTIONS_build_summary_html.md`, root `email_docs_request_Catharina40.md` are iCloud-evicted (not downloadable through the bridge) — inspected none, changed none. Open them once in Finder if you want them re-audited.
8. ⚠️ **Security note for "general release":** `.git/.git-credentials` sits inside the project's git dir. If this folder is ever shared or the repo re-hosted, remove that file and rotate the credential — a plaintext token should not travel with the project.
9. `_to_delete/` (11 items) awaits your manual delete.
