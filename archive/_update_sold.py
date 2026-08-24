#!/usr/bin/env python3
"""Move sold / under-bid / off-market listings to the sold pile, based on a
Funda status sweep run 2026-06-28. Also fix two data-quality items
(Laanhorn 2 back on market; Eikenrodelaan 89 == Rozenoord 91 duplicate)."""
import json, shutil, datetime, re

SRC = "property_data.json"
TODAY = "2026-06-28"

# backup
stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
shutil.copy(SRC, f"property_data.json.{stamp}.bak")

with open(SRC, encoding="utf-8") as f:
    data = json.load(f)

def fid(url):
    m = re.search(r"/(\d{6,})/?", url or "")
    return m.group(1) if m else None

# ---- status note templates (EN + RU) ----
def notes_en(code):
    return {
        "onder_bod":   f"Funda status {TODAY}: Onder bod (under bid) — moved to sold pile.",
        "verkocht_ov": f"Funda status {TODAY}: Verkocht onder voorbehoud (sold subject to conditions) — moved to sold pile.",
        "off_funda":   f"Funda status {TODAY}: no longer listed on Funda (listing page removed) — off-market, moved to sold pile.",
        "sold":        "Sold/transferred 2025-07-30 (final €500,000); now rented out (Verhuurd) by new owner.",
    }[code]
def notes_ru(code):
    return {
        "onder_bod":   f"Статус Funda {TODAY}: Onder bod (под предложением) — перенесено в проданные.",
        "verkocht_ov": f"Статус Funda {TODAY}: Verkocht onder voorbehoud (продано под условием) — перенесено в проданные.",
        "off_funda":   f"Статус Funda {TODAY}: больше нет на Funda (объявление удалено) — снято с продажи, перенесено в проданные.",
        "sold":        "Продано/передано 30-07-2025 (итог €500 000); сдаётся новым владельцем.",
    }[code]

# code -> (sold_date, sold_status code stored)
DATE = {"onder_bod": TODAY, "verkocht_ov": TODAY, "off_funda": TODAY, "sold": "2025-07-30"}

# ---- changes keyed by Funda listing ID (detail-URL listings) ----
by_id = {
    "44483907": "verkocht_ov",   # Doddendaal 151
    "44485667": "onder_bod",     # Hoeksewaard 51
    "44473188": "onder_bod",     # Burgemeester Haspelslaan 140
    "44495254": "onder_bod",     # Populierenlaan 569
    "43329748": "onder_bod",     # Pruimenlaan 42 (visited)
    "44476228": "onder_bod",     # Meander 1101
    "44489554": "onder_bod",     # Bos en Vaartlaan 119
    "44489742": "onder_bod",     # Praam 273
    "43393021": "onder_bod",     # Bolestein 13-B (visited)
    "44489591": "onder_bod",     # Van Nijenrodeweg 62
    "44492948": "onder_bod",     # Donau 88
    "43326543": "off_funda",     # Sint Philipsland 129 (visited, 404 confirmed)
    "44462070": "off_funda",     # Kiefskamp 15 (404 confirmed)
    "43983286": "sold",          # Arent Janszoon Ernststraat 795-K
}

# ---- changes keyed by exact DB address (search-URL listings) ----
# value: (code, replacement_detail_url_or_None)
by_addr = {
    "Bijdorp 11, Amstelveen": ("verkocht_ov", "https://www.funda.nl/detail/koop/amstelveen/appartement-bijdorp-11/44461903/"),
    "Merckenburg 38, Amsterdam (Buitenveldert)": ("verkocht_ov", "https://www.funda.nl/detail/koop/amsterdam/appartement-merckenburg-38/80819925/"),
    "Populierenlaan 175, Amstelveen": ("onder_bod", "https://www.funda.nl/detail/koop/amstelveen/appartement-populierenlaan-175/44476011/"),
    "Van Heuven Goedhartlaan 458, Amstelveen": ("onder_bod", "https://www.funda.nl/detail/koop/amstelveen/appartement-van-heuven-goedhartlaan-458/44454747/"),
    "Van Heuven Goedhartlaan 520, Amstelveen": ("onder_bod", "https://www.funda.nl/detail/koop/amstelveen/appartement-van-heuven-goedhartlaan-520/80814411/"),
    "De Boelelaan 305, Amsterdam (Buitenveldert)": ("onder_bod", "https://www.funda.nl/detail/koop/amsterdam/appartement-de-boelelaan-305/44458182/"),
    "Zonnesteinhof 24, Amstelveen": ("off_funda", None),
    "Haya van Somerenlaan 102, Amstelveen": ("off_funda", None),
}

# data-quality: update URL for a still-available search-URL listing
url_fix = {
    "Mr. Troelstralaan 30, Amstelveen": "https://www.funda.nl/detail/koop/amstelveen/appartement-mr-troelstralaan-30/43335143/",
}

def apply_sold(p, code):
    p["sold"] = True
    p["sold_status"] = code
    p["sold_date"] = DATE[code]
    p["status_checked"] = TODAY
    en, ru = notes_en(code), notes_ru(code)
    p["notes"] = (p.get("notes","").rstrip() + " | " + en).lstrip(" |") if p.get("notes") else en
    p["notes_ru"] = (p.get("notes_ru","").rstrip() + " | " + ru).lstrip(" |") if p.get("notes_ru") else ru

changed, unmatched = [], []
matched_ids = set(); matched_addrs = set()

for p in data:
    pid = fid(p.get("url",""))
    addr = p.get("address","")
    if pid in by_id and not p.get("sold"):
        apply_sold(p, by_id[pid]); changed.append((addr, by_id[pid])); matched_ids.add(pid)
    elif addr in by_addr and not p.get("sold"):
        code, newurl = by_addr[addr]
        if newurl: p["url"] = newurl
        apply_sold(p, code); changed.append((addr, code)); matched_addrs.add(addr)
    elif addr in url_fix:
        p["url"] = url_fix[addr]

# report unmatched targets
for i in by_id:
    if i not in matched_ids: unmatched.append(("id", i, by_id[i]))
for a in by_addr:
    if a not in matched_addrs: unmatched.append(("addr", a, by_addr[a][0]))

# ---- Laanhorn 2: back on market -> reactivate ----
laanhorn = None
for p in data:
    if p.get("address","").startswith("Laanhorn 2,"):
        laanhorn = p
        old = p.get("sold_date")
        p["sold"] = False
        p.pop("sold_status", None)
        p["status_checked"] = TODAY
        note = (f"FLAG {TODAY}: live Funda shows 'Beschikbaar' (available), listed 13-5-2026, 4,376 views. "
                f"Previously marked sold {old} — sale appears to have fallen through or was premature. Reactivated to active list.")
        note_ru = (f"ФЛАГ {TODAY}: на Funda статус 'Beschikbaar' (доступно), выставлено 13-5-2026, 4376 просмотров. "
                   f"Ранее отмечено как продано {old} — сделка, видимо, сорвалась или отметка преждевременна. Возвращено в активные.")
        p["sold_date"] = None
        p["notes"] = (p.get("notes","") + " | " + note).lstrip(" |") if p.get("notes") else note
        p["notes_ru"] = (p.get("notes_ru","") + " | " + note_ru).lstrip(" |") if p.get("notes_ru") else note_ru

# ---- duplicate: Eikenrodelaan 89 (same Funda ID as Rozenoord 91) -> remove ----
dup_removed = None
before = len(data)
new = []
for p in data:
    if p.get("address","").startswith("Eikenrodelaan 89") and fid(p.get("url","")) == "44494003":
        dup_removed = p.get("address"); continue
    new.append(p)
data = new

# ---- detect any remaining duplicate Funda IDs ----
from collections import defaultdict
idmap = defaultdict(list)
for p in data:
    pid = fid(p.get("url",""))
    if pid: idmap[pid].append(p.get("address"))
dups = {k:v for k,v in idmap.items() if len(v) > 1}

with open(SRC, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"Backup: property_data.json.{stamp}.bak")
print(f"Moved to sold: {len(changed)}")
for a,c in changed: print(f"   [{c:11}] {a}")
print(f"Reactivated: {'Laanhorn 2' if laanhorn else 'NONE'}")
print(f"Duplicate removed: {dup_removed}")
print(f"Records: {before} -> {len(data)}")
print(f"Unmatched targets: {unmatched if unmatched else 'none'}")
print(f"Remaining duplicate Funda IDs: {dups if dups else 'none'}")
print(f"Total sold now: {sum(1 for p in data if p.get('sold'))} | active: {sum(1 for p in data if not p.get('sold'))}")
