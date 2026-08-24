# SCORING RUBRIC — canonical v5 score schema (updated 01-08-2026)

**Single source of truth for how every current and future entry in `property_data.json` is scored.** The model itself (weights, computed criteria, veto gates) lives in `build.js`; this file defines the **data contract** every flow — daily digest, enrichment, doc reviews, manual edits — must respect. The 31-07-2026 QA migration (`QA_release_review_2026-07-31.md`) brought all entries onto this schema; do not regress it.

## 1. The `scores` object: manual judgments ONLY

`scores` may contain **only** these keys, each an integer 1–10 (10 = best):

| Key | Meaning | When to set |
|---|---|---|
| `value` | Price/value judgment vs comps, WOZ, renovation need (per the **v4 value rubric**; set `value_v4: true`) | Only after real analysis (doc review / valuation). Never default it. |
| `condition` | State of the property (10 turnkey ↔ 1 structural work) | Only after docs/photos/viewing evidence. |
| `legal` | Title/ownership risk (eigen grond clean ≈ 7–8 · erfpacht afgekocht ≈ 5–7 · running canon / VvE issues / unverified ≤ 4) | May be set from register data (kadaster). |

**An honest gap beats an invented score.** If there is no basis for `value`/`condition`, leave the key **absent** — build.js renormalises and prints the entry on the worklist. (47 entries are in this state by design.)

## 2. NEVER put computed criteria into `scores`

`energy`, `dist_emmakade`, `dist_zuidas`, `price`, `renovation`, tenure/outdoor keys **must not appear in `scores`**. build.js computes these criteria from the raw fields below; a manual key with the same name acts as a **hard override** and silently mis-ranks the entry (the exact defect QA removed on 31-07: ~48 override warnings, a flattered #1).

Feed the computed criteria through **data fields** instead:

- `energy_label` (+ `energy_upgrade`: `easy` / `moderate` / `hard`, with `energy_upgrade_note`)
- `dist_emmakade_min`, `dist_zuidas_min` (bike minutes)
- `ground` (must match a `TENURE_SCORE` string in build.js — if you introduce a new tenure wording, add it to `TENURE_SCORE` + `GROUND_RU` in the same change)
- `price`, `woz`, `woz_year`, `area` (price-efficiency)
- `outdoor_space` (record after every viewing)

## 3. Legacy scores

Anything that predates this schema goes **wholesale** into `scores_legacy` (one key project-wide; `scores_legacy_v2` is retired). Never resurrect archived dicts into `scores`; 49 entries currently carry an archive.

## 4. Merge rule for the daily digest (data-loss guard)

Match entries by `url`. Then:

1. **Never replace an entry whose `status_checked` is newer than the digest's data date** — enrich, don't clobber.
2. Never downgrade a `*_verified: true` field to an estimate; never touch `docs_received`, `doc_review*`, `second_check*`, `disclosure_*` blocks.
3. New digest entries ship **raw fields only** — at most a `legal` score if register-based; no `value`/`condition` guesses, no computed keys (see §2).
4. Snapshot to `backups/property_data.json.<YYYYMMDD_HHMMSS>.bak` before writing; write the full 154+-entry set, never a subset.

**Incident log:** on 01-08-2026 a stale-lineage write reduced the DB from 154 → 144 entries and reverted Noorderkroon 32 to pre-doc-review placeholders (second occurrence that day; first at 08:44, repeat at ~18:00 and 18:40). Restored from `property_data.json.20260801_175924.bak`. The stale writes carried **zero** new information (verified by field-level diff). Root cause is on the machine side (a stale digest session state and/or iCloud version flapping — the whole folder briefly reverted to its pre-QA layout on the morning of 01-08): if it recurs, check which device/session wrote the file and re-sync before trusting `property_data.json`.

## 5. Sanity checks after any bulk write

- JSON valid, entry count **never decreases**, no duplicate `url`s
- Every `scores` ⊆ {value, condition, legal}, ints 1–10
- `git diff --stat` before committing the folder's git repo — a shrinking file is a red flag

---
*RU: Схема v5 — единственная действующая. В `scores` только ручные оценки `value` / `condition` / `legal` (целые 1–10); отсутствие оценки честнее выдуманной. Вычисляемые критерии (энергия, расстояния, цена, tenure) задаются полями данных (`energy_label`, `dist_*_min`, `ground`, `price`/`woz`) — записывать их в `scores` ЗАПРЕЩЕНО: это перекрывает расчёт build.js. Старые схемы — целиком в `scores_legacy`. Дайджест сливает по `url` и не перезаписывает записи с более свежим `status_checked` (инцидент 01-08-2026: база сжалась 154 → 144 и потеряла проверенные данные; восстановлено из бэкапа 17:59).*
