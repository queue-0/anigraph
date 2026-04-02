#!/usr/bin/env python3
"""
slim-database.py
----------------
Downloads the Anime Offline Database JSONL, then optionally enriches it
via the AniList API (characters, staff, relation types) and builds a
pre-computed graph structure (nodes + edges) for Anigraph.

Key improvements over v1:
 - Studio de-duplication uses token-fingerprint normalization (MAPPA ≡ MAPPA co., LLC)
 - Relation type is stored per edge (sequel, prequel, spin_off, etc.)
   Edges with kind "CHARACTER" are excluded (no meaningful graph link).
 - English title detection uses AniList API when FETCH_ANILIST=True,
   falling back to a heuristic that checks ALL synonyms more carefully.
 - Character/staff fetching uses the same fetch pattern as anilist.js
   (browser-compatible headers, POST to graphql.anilist.co) to avoid 403s.
"""

import json
import urllib.request
import urllib.parse
import urllib.error
import os
import sys
import time
import re

RELEASE_URL = (
    "https://github.com/manami-project/anime-offline-database"
    "/releases/latest/download/anime-offline-database.jsonl"
)
ANILIST_API = "https://graphql.anilist.co"

OUT_DIR  = "data"
OUT_FILE = os.path.join(OUT_DIR, "anime-graph.json")

MAX_TAGS = 99

# Set True to fetch character/staff/relations from AniList API.
# Significantly slower (rate-limited) — run overnight for full dataset.
FETCH_ANILIST = False

# AniList relation types that imply a meaningful anime↔anime graph edge.
# "CHARACTER" is intentionally excluded (a character appearing in two shows
# doesn't create a narrative link worth showing).
VALID_RELATION_TYPES = {
    "SEQUEL", "PREQUEL", "ALTERNATIVE", "SIDE_STORY",
    "PARENT", "SUMMARY", "SPIN_OFF", "OTHER", "ADAPTATION", "SOURCE",
}

# Human-readable labels for edge relation types (shown on graph edge lines)
RELATION_LABELS = {
    "SEQUEL":      "Sequel",
    "PREQUEL":     "Prequel",
    "ALTERNATIVE": "Alt.",
    "SIDE_STORY":  "Side Story",
    "PARENT":      "Parent",
    "SUMMARY":     "Summary",
    "SPIN_OFF":    "Spin-off",
    "OTHER":       "Related",
    "ADAPTATION":  "Adaptation",
    "SOURCE":      "Source",
}


# ── ID COUNTER ────────────────────────────────────────────────────────────────
_next_id = 0

def next_id() -> int:
    global _next_id
    _next_id += 1
    return _next_id


# ── STUDIO NORMALIZATION ──────────────────────────────────────────────────────
# Strategy: tokenize, remove generic business suffixes, sort remaining tokens,
# join into a canonical fingerprint.  This correctly merges:
#   "MAPPA"  /  "MAPPA Co., Ltd."  /  "MAPPA co., LLC"
#   "Sunrise"  /  "Sunrise Inc."
#   "A-1 Pictures"  /  "A-1 Pictures Inc."

_STUDIO_FILLER_TOKENS = {
    "co", "ltd", "llc", "inc", "corp", "corporation", "gk", "kk",
    "the", "a", "an", "and",
    # Japanese business entity suffixes romanized
    "kabushiki", "kaisha", "yugen", "goshi",
    # Descriptive terms that commonly vary
    "animation", "animations", "anime", "production", "productions",
    "studio", "studios", "pictures", "entertainment", "works", "creative",
    "digital", "media", "arts", "lab", "labs",
}

def normalize_studio_name(name: str) -> str:
    if not name:
        return ""
    # Lowercase, replace punctuation with spaces, split into tokens
    tokens = re.sub(r"[^a-z0-9]", " ", name.lower()).split()
    # Remove filler tokens
    core = [t for t in tokens if t not in _STUDIO_FILLER_TOKENS]
    # Fallback: keep original tokens if we filtered everything
    if not core:
        core = tokens
    # Sort tokens so "Pictures A-1" and "A-1 Pictures" collapse together
    # but keep single-token names as-is (sorting a 1-element list is safe)
    return " ".join(sorted(core))


# ── ENGLISH TITLE HEURISTIC ───────────────────────────────────────────────────
# AniList stores English titles natively; the Anime Offline Database only
# provides a flat synonyms list.  Strategy:
#  1. If FETCH_ANILIST=True, use the API title.english field (most accurate).
#  2. Otherwise, score each synonym:
#     - % of ASCII characters (high → likely Latin-script / English)
#     - Prefer synonyms that look like proper English sentences
#       (contain common English words)
#  This is strictly a heuristic fallback; AniList data is preferred.

_COMMON_EN_WORDS = {
    "the", "of", "and", "in", "a", "an", "is", "to", "my", "your",
    "our", "their", "no", "ni", "wa", "ga", "de", "wo",  # last few are JP particles
    "season", "part", "chapter", "arc", "movie", "film", "ova",
}

def _score_english_synonym(s: str) -> float:
    if not s or len(s) < 2:
        return 0.0
    # Ratio of ASCII printable characters
    ascii_ratio = sum(1 for c in s if ord(c) < 128) / len(s)
    if ascii_ratio < 0.7:
        return 0.0
    # Boost if it contains common English words
    words = set(s.lower().split())
    en_word_hits = len(words & _COMMON_EN_WORDS)
    return ascii_ratio + en_word_hits * 0.05

def pick_english_title(synonyms: list[str], fallback: str = None) -> str | None:
    """Return the most likely English title from a synonyms list."""
    best, best_score = None, 0.5  # minimum threshold
    for s in synonyms:
        score = _score_english_synonym(s)
        if score > best_score:
            best, best_score = s, score
    return best


# ── ANILIST HELPERS ───────────────────────────────────────────────────────────
# Using identical headers to what the browser sends in anilist.js to avoid 403.

def anilist_query(query: str, variables: dict, retries: int = 4) -> dict | None:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    headers = {
        "Content-Type": "application/json",
        "Accept":       "application/json",
        # Minimal headers — no Origin, no Referer — mirrors anilist.js fetch
    }
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                ANILIST_API, data=payload, headers=headers, method="POST"
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read())
                if "errors" in body:
                    print(f"  [AL] GraphQL errors: {body['errors']}")
                    return None
                return body
        except urllib.error.HTTPError as e:
            print(f"  [AL] HTTP {e.code} on attempt {attempt+1}/{retries}")
            if e.code == 429:
                # Rate limited — back off longer
                time.sleep(60)
            else:
                time.sleep(2 ** attempt)
        except Exception as ex:
            print(f"  [AL] Error attempt {attempt+1}/{retries}: {ex}")
            time.sleep(2 ** attempt)
    return None


# Fetches: English title, characters, staff, AND typed relations
ENRICH_QUERY = """
query ($id: Int, $charPage: Int, $staffPage: Int) {
  Media(id: $id, type: ANIME) {
    title { english }
    relations {
      edges {
        relationType(version: 2)
        node {
          id
          siteUrl
        }
      }
    }
    characters(page: $charPage, perPage: 25, role: MAIN) {
      pageInfo { hasNextPage }
      edges { node { id name { full } } }
    }
    staff(page: $staffPage, perPage: 25) {
      pageInfo { hasNextPage }
      edges {
        node { id name { full } }
        role
      }
    }
  }
}
"""

def fetch_enrichment(al_numeric_id: int):
    """
    Returns:
      title_en   : str | None
      relations  : list of (al_url, relation_type_str)
      characters : list of {id, name}
      staff      : list of {id, name, role}
    """
    title_en   = None
    relations  = []
    characters = []
    staff      = []

    # Page 1 — also grabs title and relations (which are not paginated)
    data = anilist_query(ENRICH_QUERY, {"id": al_numeric_id, "charPage": 1, "staffPage": 1})
    if not data:
        return title_en, relations, characters, staff

    media = data.get("data", {}).get("Media")
    if not media:
        return title_en, relations, characters, staff

    # English title from AniList (most reliable source)
    title_en = (media.get("title") or {}).get("english")

    # Relations — skip CHARACTER relation type
    for edge in (media.get("relations") or {}).get("edges", []):
        rel_type = edge.get("relationType", "")
        if rel_type not in VALID_RELATION_TYPES:
            continue
        node     = edge.get("node") or {}
        site_url = node.get("siteUrl", "")
        if "anilist.co" in site_url:
            relations.append((site_url.rstrip("/"), rel_type))

    # Characters page 1
    def _add_chars(media_data):
        for edge in (media_data.get("characters") or {}).get("edges", []):
            node = edge.get("node")
            if node:
                characters.append({"id": node["id"], "name": node["name"]["full"]})

    def _add_staff(media_data):
        for edge in (media_data.get("staff") or {}).get("edges", []):
            node = edge.get("node")
            if node:
                staff.append({"id": node["id"], "name": node["name"]["full"], "role": edge.get("role", "")})

    _add_chars(media)
    _add_staff(media)

    char_more  = (media.get("characters") or {}).get("pageInfo", {}).get("hasNextPage", False)
    staff_more = (media.get("staff")      or {}).get("pageInfo", {}).get("hasNextPage", False)
    page = 2

    while char_more or staff_more:
        time.sleep(1.1)
        data2 = anilist_query(
            ENRICH_QUERY,
            {"id": al_numeric_id, "charPage": page if char_more else 1,
             "staffPage": page if staff_more else 1}
        )
        if not data2:
            break
        m2 = data2.get("data", {}).get("Media", {})
        if char_more:
            _add_chars(m2)
            char_more = (m2.get("characters") or {}).get("pageInfo", {}).get("hasNextPage", False)
        if staff_more:
            _add_staff(m2)
            staff_more = (m2.get("staff") or {}).get("pageInfo", {}).get("hasNextPage", False)
        page += 1

    return title_en, relations, characters, staff


# ── SLIM A SINGLE ANIME ENTRY ─────────────────────────────────────────────────

def slim_anime(anime: dict) -> dict | None:
    al_source = next((s for s in anime.get("sources", []) if "anilist.co" in s), None)
    if not al_source:
        return None
    try:
        al_numeric = int(al_source.rstrip("/").split("/")[-1])
    except ValueError:
        return None

    score_raw = anime.get("score")
    score     = round(score_raw["arithmeticMean"], 2) if score_raw and score_raw.get("arithmeticMean") else None
    dur_raw   = anime.get("duration")
    duration  = dur_raw["value"] if dur_raw else None
    season_raw = anime.get("animeSeason", {})

    # English title: heuristic from synonyms (overridden later if FETCH_ANILIST)
    synonyms = anime.get("synonyms", [])
    en_title = pick_english_title(synonyms)

    # Relations from the offline DB (URL-only, no type info yet)
    related_urls = [r for r in anime.get("relatedAnime", []) if "anilist.co" in r]

    return {
        "al_id":      al_numeric,
        "al_url":     al_source,
        "title":      anime.get("title", ""),
        "title_en":   en_title,
        "type":       anime.get("type", "UNKNOWN"),
        "episodes":   anime.get("episodes", 0),
        "status":     anime.get("status", "UNKNOWN"),
        "year":       season_raw.get("year"),
        "season":     season_raw.get("season") if season_raw.get("season") != "UNDEFINED" else None,
        "duration":   duration,
        "score":      score,
        "picture":    anime.get("picture") or "",
        "studios":    anime.get("studios", []),
        "tags":       anime.get("tags", [])[:MAX_TAGS],
        # Relations as list of URL strings (typed relations added later if API used)
        "related_urls":   related_urls,
        "related_typed":  [],   # list of (url, relation_type) — filled by FETCH_ANILIST
    }


# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("Downloading Anime Offline Database…")

    slim_list = []
    line_num  = 0

    with urllib.request.urlopen(RELEASE_URL) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8").strip()
            if not line or line_num == 0:
                line_num += 1
                continue
            try:
                anime   = json.loads(line)
                slimmed = slim_anime(anime)
                if slimmed:
                    slim_list.append(slimmed)
            except Exception:
                pass
            line_num += 1

    print(f"  Loaded {len(slim_list)} AniList-linked anime entries.")

    # ── Assign node IDs ───────────────────────────────────────────────────────
    for a in slim_list:
        a["node_id"] = next_id()

    al_url_to_node = {a["al_url"].rstrip("/"): a for a in slim_list}

    # ── Optional AniList enrichment ───────────────────────────────────────────
    if FETCH_ANILIST:
        print(f"\nFetching enrichment from AniList (this is slow — ~1 req/s)…")
        total = len(slim_list)
        for i, a in enumerate(slim_list):
            if i % 100 == 0:
                print(f"  {i}/{total}…")
            title_en, typed_rels, chars, staff = fetch_enrichment(a["al_id"])
            if title_en:
                a["title_en"] = title_en
            a["related_typed"]  = [(url.rstrip("/"), rel) for url, rel in typed_rels]
            a["_chars"]         = chars
            a["_staff"]         = staff
            time.sleep(1.1)  # stay well under rate limit
    else:
        for a in slim_list:
            a["_chars"] = []
            a["_staff"] = []

    # ── Studio de-duplication (improved normalization) ────────────────────────
    # norm_fingerprint → {node_id, canonical_name, all_raw_names}
    studio_norm_map  = {}  # fingerprint → node_id
    studio_nodes_map = {}  # fingerprint → {node_id, type, name}

    for a in slim_list:
        for raw_name in a["studios"]:
            fp = normalize_studio_name(raw_name)
            if not fp:
                continue
            if fp not in studio_norm_map:
                nid = next_id()
                studio_norm_map[fp]  = nid
                studio_nodes_map[fp] = {"node_id": nid, "type": "studio", "name": raw_name}
            else:
                # Keep the shorter, cleaner display name
                existing = studio_nodes_map[fp]["name"]
                if len(raw_name) < len(existing):
                    studio_nodes_map[fp]["name"] = raw_name

    studio_nodes = list(studio_nodes_map.values())

    # ── Tag nodes ─────────────────────────────────────────────────────────────
    tag_registry = {}  # tag_name → node_id
    tag_nodes    = []

    for a in slim_list:
        for t in a["tags"]:
            if t not in tag_registry:
                nid = next_id()
                tag_registry[t] = nid
                tag_nodes.append({"node_id": nid, "type": "tag", "name": t})

    # ── Character / Staff nodes ───────────────────────────────────────────────
    character_registry = {}  # str(al_id) → node_id
    staff_registry     = {}
    character_nodes    = []
    staff_nodes        = []

    if FETCH_ANILIST:
        for a in slim_list:
            char_ids  = []
            staff_ids = []
            for ch in a.get("_chars", []):
                key = str(ch["id"])
                if key not in character_registry:
                    nid = next_id()
                    character_registry[key] = nid
                    character_nodes.append({"node_id": nid, "type": "character",
                                            "name": ch["name"], "al_id": ch["id"]})
                char_ids.append(character_registry[key])
            for st in a.get("_staff", []):
                key = str(st["id"])
                if key not in staff_registry:
                    nid = next_id()
                    staff_registry[key] = nid
                    staff_nodes.append({"node_id": nid, "type": "staff",
                                        "name": st["name"], "al_id": st["id"]})
                staff_ids.append({"node_id": staff_registry[key], "role": st["role"]})
            a["_char_ids"]  = char_ids
            a["_staff_ids"] = staff_ids
    else:
        for a in slim_list:
            a["_char_ids"]  = []
            a["_staff_ids"] = []

    # ── Build edges ───────────────────────────────────────────────────────────
    edges    = []
    edge_set = set()

    def add_edge(src: int, tgt: int, kind: str, rel: str = None):
        key = (min(src, tgt), max(src, tgt), kind)
        if key not in edge_set:
            edge_set.add(key)
            e = {"s": src, "t": tgt, "k": kind}
            if rel:
                e["rel"] = rel
            edges.append(e)

    al_id_to_node = {a["al_id"]: a for a in slim_list}

    for a in slim_list:
        anid = a["node_id"]

        # Anime↔anime relations (typed, from AniList if available)
        if FETCH_ANILIST and a["related_typed"]:
            for url, rel_type in a["related_typed"]:
                target = al_url_to_node.get(url)
                if target and target["node_id"] != anid:
                    label = RELATION_LABELS.get(rel_type, rel_type.title())
                    add_edge(anid, target["node_id"], "related", label)
        else:
            # Fallback: URL-only relations from offline DB (no type info)
            for url in a["related_urls"]:
                target = al_url_to_node.get(url.rstrip("/"))
                if target and target["node_id"] != anid:
                    add_edge(anid, target["node_id"], "related")

        # Studio edges
        for raw_name in a["studios"]:
            fp = normalize_studio_name(raw_name)
            if fp in studio_norm_map:
                add_edge(anid, studio_norm_map[fp], "studio")

        # Tag edges
        for t in a["tags"]:
            if t in tag_registry:
                add_edge(anid, tag_registry[t], "tag")

        # Character / staff edges
        for cnid in a.get("_char_ids", []):
            add_edge(anid, cnid, "character")
        for st in a.get("_staff_ids", []):
            add_edge(anid, st["node_id"], "staff")

    # ── Build final anime node objects ────────────────────────────────────────
    anime_nodes = []
    for a in slim_list:
        s_ids = list(set(
            studio_norm_map[normalize_studio_name(s)]
            for s in a["studios"]
            if normalize_studio_name(s) in studio_norm_map
        ))
        anime_nodes.append({
            "node_id":    a["node_id"],
            "type":       "anime",
            "al_id":      a["al_id"],
            "al_url":     a["al_url"],
            "title":      a["title"],
            "title_en":   a["title_en"],
            "anime_type": a["type"],
            "episodes":   a["episodes"],
            "status":     a["status"],
            "year":       a["year"],
            "season":     a["season"],
            "duration":   a["duration"],
            "score":      a["score"],
            "picture":    a["picture"],
            "studio_ids": s_ids,
            "tag_ids":    [tag_registry[t] for t in a["tags"] if t in tag_registry],
        })

    # ── Write output ──────────────────────────────────────────────────────────
    all_nodes = anime_nodes + studio_nodes + tag_nodes + character_nodes + staff_nodes
    out = {
        "meta": {
            "generated":      time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_anime":    len(anime_nodes),
            "total_studios":  len(studio_nodes),
            "total_tags":     len(tag_nodes),
            "total_edges":    len(edges),
            "anilist_enriched": FETCH_ANILIST,
        },
        "nodes": all_nodes,
        "edges": edges,
    }

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n✅ Done!")
    print(f"   Anime:    {len(anime_nodes):,}")
    print(f"   Studios:  {len(studio_nodes):,}  (de-duplicated)")
    print(f"   Tags:     {len(tag_nodes):,}")
    print(f"   Chars:    {len(character_nodes):,}")
    print(f"   Staff:    {len(staff_nodes):,}")
    print(f"   Edges:    {len(edges):,}")
    print(f"   Output:   {OUT_FILE}")


if __name__ == "__main__":
    main()
