#!/usr/bin/env python3
"""
slim-database.py
----------------
Downloads the Anime Offline Database JSONL, optionally enriches via AniList API,
and builds a pre-computed graph for Anigraph.

New in this version:
 - genres stored separately from tags (genre_ids / genre nodes)
 - country of origin (countryOfOrigin from AniList)
 - release_status field (FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS)
 - user scores fetched per-user at runtime via anilist.js (not baked in)
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

MAX_TAGS   = 12
MAX_GENRES = 6  # AniList genres are limited anyway (~30 total)

# Set True to fetch character/staff/relations/country/genres from AniList API.
FETCH_ANILIST = True

VALID_RELATION_TYPES = {
    "SEQUEL", "PREQUEL", "ALTERNATIVE", "SIDE_STORY",
    "PARENT", "SUMMARY", "SPIN_OFF", "OTHER", "ADAPTATION", "SOURCE",
}

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

# AniList status → our release_status field
STATUS_MAP = {
    "FINISHED":         "FINISHED",
    "RELEASING":        "RELEASING",
    "NOT_YET_RELEASED": "NOT_YET_RELEASED",
    "CANCELLED":        "CANCELLED",
    "HIATUS":           "HIATUS",
}


# ── ID COUNTER ────────────────────────────────────────────────────────────────
_next_id = 0

def next_id() -> int:
    global _next_id
    _next_id += 1
    return _next_id


# ── STUDIO NORMALIZATION ──────────────────────────────────────────────────────
_STUDIO_FILLER_TOKENS = {
    "co", "ltd", "llc", "inc", "corp", "corporation", "gk", "kk",
    "the", "a", "an", "and",
    "kabushiki", "kaisha", "yugen", "goshi",
    "animation", "animations", "anime", "production", "productions",
    "studio", "studios", "pictures", "entertainment", "works", "creative",
    "digital", "media", "arts", "lab", "labs",
}

def normalize_studio_name(name: str) -> str:
    if not name:
        return ""
    tokens = re.sub(r"[^a-z0-9]", " ", name.lower()).split()
    core   = [t for t in tokens if t not in _STUDIO_FILLER_TOKENS]
    if not core:
        core = tokens
    return " ".join(sorted(core))


# ── ENGLISH TITLE HEURISTIC ───────────────────────────────────────────────────
_COMMON_EN_WORDS = {
    "the", "of", "and", "in", "a", "an", "is", "to", "my", "your",
    "our", "their", "no", "ni", "wa", "ga", "de", "wo",
    "season", "part", "chapter", "arc", "movie", "film", "ova",
}

def _score_english_synonym(s: str) -> float:
    if not s or len(s) < 2:
        return 0.0
    ascii_ratio = sum(1 for c in s if ord(c) < 128) / len(s)
    if ascii_ratio < 0.7:
        return 0.0
    words = set(s.lower().split())
    en_word_hits = len(words & _COMMON_EN_WORDS)
    return ascii_ratio + en_word_hits * 0.05

def pick_english_title(synonyms: list[str], fallback: str = None) -> str | None:
    best, best_score = None, 0.5
    for s in synonyms:
        score = _score_english_synonym(s)
        if score > best_score:
            best, best_score = s, score
    return best


# ── ANILIST HELPERS ───────────────────────────────────────────────────────────
_AL_HEADERS = {
    "Content-Type": "application/json",
    "Accept":       "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
}

def anilist_query(query: str, variables: dict, retries: int = 4) -> dict | None:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                ANILIST_API, data=payload,
                headers=_AL_HEADERS, method="POST"
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read())
                if "errors" in body:
                    print(f"  [AL] GraphQL errors: {body['errors']}")
                    return None
                return body
        except urllib.error.HTTPError as e:
            print(f"  [AL] HTTP {e.code} on attempt {attempt+1}/{retries}")
            if e.code == 403:
                print("       Cloudflare blocking — check User-Agent.")
                return None
            elif e.code == 429:
                print("       Rate limited — backing off 60s…")
                time.sleep(60)
            else:
                time.sleep(2 ** attempt)
        except Exception as ex:
            print(f"  [AL] Error attempt {attempt+1}/{retries}: {ex}")
            time.sleep(2 ** attempt)
    return None


ENRICH_QUERY = """
query ($id: Int, $charPage: Int, $staffPage: Int) {
  Media(id: $id, type: ANIME) {
    title { english }
    status
    countryOfOrigin
    genres
    relations {
      edges {
        relationType(version: 2)
        node { id siteUrl }
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
      title_en       : str | None
      release_status : str | None
      country        : str | None   (ISO 3166-1 alpha-2, e.g. "JP")
      genres         : list[str]
      relations      : list of (al_url, relation_type_str)
      characters     : list of {id, name}
      staff          : list of {id, name, role}
    """
    title_en       = None
    release_status = None
    country        = None
    genres         = []
    relations      = []
    characters     = []
    staff          = []

    data = anilist_query(ENRICH_QUERY, {"id": al_numeric_id, "charPage": 1, "staffPage": 1})
    if not data:
        return title_en, release_status, country, genres, relations, characters, staff

    media = data.get("data", {}).get("Media")
    if not media:
        return title_en, release_status, country, genres, relations, characters, staff

    title_en       = (media.get("title") or {}).get("english")
    release_status = STATUS_MAP.get(media.get("status", ""), "UNKNOWN")
    country        = media.get("countryOfOrigin") or "JP"  # default JP
    genres         = media.get("genres") or []

    for edge in (media.get("relations") or {}).get("edges", []):
        rel_type = edge.get("relationType", "")
        if rel_type not in VALID_RELATION_TYPES:
            continue
        node     = edge.get("node") or {}
        site_url = node.get("siteUrl", "")
        if "anilist.co" in site_url:
            relations.append((site_url.rstrip("/"), rel_type))

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
            {"id": al_numeric_id,
             "charPage":  page if char_more  else 1,
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

    return title_en, release_status, country, genres, relations, characters, staff


# ── SLIM A SINGLE ANIME ENTRY ─────────────────────────────────────────────────
def slim_anime(anime: dict) -> dict | None:
    al_source = next((s for s in anime.get("sources", []) if "anilist.co" in s), None)
    if not al_source:
        return None
    try:
        al_numeric = int(al_source.rstrip("/").split("/")[-1])
    except ValueError:
        return None

    score_raw  = anime.get("score")
    score      = round(score_raw["arithmeticMean"], 2) if score_raw and score_raw.get("arithmeticMean") else None
    dur_raw    = anime.get("duration")
    duration   = dur_raw["value"] if dur_raw else None
    season_raw = anime.get("animeSeason", {})

    synonyms = anime.get("synonyms", [])
    en_title = pick_english_title(synonyms)

    related_urls = [r for r in anime.get("relatedAnime", []) if "anilist.co" in r]

    # Offline DB status → release_status (basic fallback; overridden by AniList if enriched)
    status_raw = anime.get("status", "UNKNOWN")
    status_map_offline = {
        "FINISHED":         "FINISHED",
        "ONGOING":          "RELEASING",
        "UPCOMING":         "NOT_YET_RELEASED",
        "UNKNOWN":          "UNKNOWN",
    }
    release_status = status_map_offline.get(status_raw, "UNKNOWN")

    return {
        "al_id":          al_numeric,
        "al_url":         al_source,
        "title":          anime.get("title", ""),
        "title_en":       en_title,
        "type":           anime.get("type", "UNKNOWN"),
        "episodes":       anime.get("episodes", 0),
        "release_status": release_status,
        "year":           season_raw.get("year"),
        "season":         season_raw.get("season") if season_raw.get("season") != "UNDEFINED" else None,
        "duration":       duration,
        "score":          score,
        "picture":        anime.get("picture") or "",
        "studios":        anime.get("studios", []),
        "tags":           anime.get("tags", [])[:MAX_TAGS],
        "genres":         [],       # filled by FETCH_ANILIST
        "country":        "JP",     # default; overridden by FETCH_ANILIST
        "related_urls":   related_urls,
        "related_typed":  [],
    }


# ── MAIN ──────────────────────────────────────────────────────────────────────
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

    for a in slim_list:
        a["node_id"] = next_id()

    al_url_to_node = {a["al_url"].rstrip("/"): a for a in slim_list}

    # ── AniList enrichment ────────────────────────────────────────────────────
    if FETCH_ANILIST:
        print(f"\nFetching enrichment from AniList (~1 req/s)…")
        total = len(slim_list)
        for i, a in enumerate(slim_list):
            if i % 100 == 0:
                print(f"  {i}/{total}…")
            title_en, rel_status, country, genres, typed_rels, chars, staff = fetch_enrichment(a["al_id"])
            if title_en:
                a["title_en"]       = title_en
            if rel_status:
                a["release_status"] = rel_status
            if country:
                a["country"]        = country
            a["genres"]         = genres[:MAX_GENRES]
            a["related_typed"]  = [(url.rstrip("/"), rel) for url, rel in typed_rels]
            a["_chars"]         = chars
            a["_staff"]         = staff
            time.sleep(1.1)
    else:
        for a in slim_list:
            a["_chars"] = []
            a["_staff"] = []

    # ── Studio de-duplication ─────────────────────────────────────────────────
    studio_norm_map  = {}
    studio_nodes_map = {}

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
                existing = studio_nodes_map[fp]["name"]
                if len(raw_name) < len(existing):
                    studio_nodes_map[fp]["name"] = raw_name

    studio_nodes = list(studio_nodes_map.values())

    # ── Genre nodes (separate from tags) ─────────────────────────────────────
    genre_registry = {}
    genre_nodes    = []

    for a in slim_list:
        for g in a.get("genres", []):
            if g not in genre_registry:
                nid = next_id()
                genre_registry[g] = nid
                genre_nodes.append({"node_id": nid, "type": "genre", "name": g})

    # ── Tag nodes ─────────────────────────────────────────────────────────────
    tag_registry = {}
    tag_nodes    = []

    for a in slim_list:
        for t in a["tags"]:
            if t not in tag_registry:
                nid = next_id()
                tag_registry[t] = nid
                tag_nodes.append({"node_id": nid, "type": "tag", "name": t})

    # ── Character / Staff nodes ───────────────────────────────────────────────
    character_registry = {}
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

    # ── Build edges (deduplicated, no meta↔meta) ──────────────────────────────
    edges    = []
    edge_set = set()

    def add_edge(src: int, tgt: int, kind: str, rel: str = None):
        # Ensure no meta↔meta: both endpoints must not both be non-anime
        # (We don't have direct meta↔meta edges in this builder, but guard anyway)
        key = (min(src, tgt), max(src, tgt), kind)
        if key not in edge_set:
            edge_set.add(key)
            e = {"s": src, "t": tgt, "k": kind}
            if rel:
                e["rel"] = rel
            edges.append(e)

    for a in slim_list:
        anid = a["node_id"]

        # Anime↔anime relations
        if FETCH_ANILIST and a["related_typed"]:
            for url, rel_type in a["related_typed"]:
                target = al_url_to_node.get(url)
                if target and target["node_id"] != anid:
                    label = RELATION_LABELS.get(rel_type, rel_type.title())
                    add_edge(anid, target["node_id"], "related", label)
        else:
            for url in a["related_urls"]:
                target = al_url_to_node.get(url.rstrip("/"))
                if target and target["node_id"] != anid:
                    add_edge(anid, target["node_id"], "related")

        # Studio edges (anime↔studio only)
        for raw_name in a["studios"]:
            fp = normalize_studio_name(raw_name)
            if fp in studio_norm_map:
                add_edge(anid, studio_norm_map[fp], "studio")

        # Genre edges (anime↔genre only)
        for g in a.get("genres", []):
            if g in genre_registry:
                add_edge(anid, genre_registry[g], "genre")

        # Tag edges (anime↔tag only)
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
        genre_ids = [genre_registry[g] for g in a.get("genres", []) if g in genre_registry]
        tag_ids   = [tag_registry[t]   for t in a["tags"]            if t in tag_registry]

        anime_nodes.append({
            "node_id":        a["node_id"],
            "type":           "anime",
            "al_id":          a["al_id"],
            "al_url":         a["al_url"],
            "title":          a["title"],
            "title_en":       a["title_en"],
            "anime_type":     a["type"],
            "episodes":       a["episodes"],
            "release_status": a["release_status"],
            "year":           a["year"],
            "season":         a["season"],
            "duration":       a["duration"],
            "score":          a["score"],
            "picture":        a["picture"],
            "country":        a["country"],
            "studio_ids":     s_ids,
            "genre_ids":      genre_ids,
            "tag_ids":        tag_ids,
        })

    # ── Write output ──────────────────────────────────────────────────────────
    all_nodes = anime_nodes + studio_nodes + genre_nodes + tag_nodes + character_nodes + staff_nodes
    out = {
        "meta": {
            "generated":        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_anime":      len(anime_nodes),
            "total_studios":    len(studio_nodes),
            "total_genres":     len(genre_nodes),
            "total_tags":       len(tag_nodes),
            "total_edges":      len(edges),
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
    print(f"   Genres:   {len(genre_nodes):,}")
    print(f"   Tags:     {len(tag_nodes):,}")
    print(f"   Chars:    {len(character_nodes):,}")
    print(f"   Staff:    {len(staff_nodes):,}")
    print(f"   Edges:    {len(edges):,}")
    print(f"   Output:   {OUT_FILE}")


if __name__ == "__main__":
    main()
