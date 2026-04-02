#!/usr/bin/env python3
"""
slim-database.py
----------------
Downloads the Anime Offline Database JSONL, optionally enriches via AniList API,
and builds a pre-computed graph for Anigraph.

What this version does:
 - Uses offline DB "status" field directly for release_status (FINISHED/ONGOING/UPCOMING)
 - Splits well-known genre names out of tags into a separate "genre" type
 - Relations fetched with type labels from AniList when FETCH_ANILIST=True
 - country / character / staff commented out (not in offline DB / API too slow)
"""

import json
import urllib.request
import urllib.parse
import urllib.error
import os
import time
import re

RELEASE_URL = (
    "https://github.com/manami-project/anime-offline-database"
    "/releases/latest/download/anime-offline-database.jsonl"
)
ANILIST_API = "https://graphql.anilist.co"

OUT_DIR  = "data"
OUT_FILE = os.path.join(OUT_DIR, "anime-graph.json")

MAX_TAGS = 12

# Set True to fetch typed relation labels from AniList API (~1 req/s — slow).
# Offline DB relations are used either way; this just adds Sequel/Prequel labels.
FETCH_ANILIST = False

VALID_RELATION_TYPES = {
    "SEQUEL", "PREQUEL", "ALTERNATIVE", "SIDE_STORY",
    "PARENT", "SUMMARY", "SPIN_OFF", "OTHER", "ADAPTATION", "SOURCE",
}
RELATION_LABELS = {
    "SEQUEL": "Sequel", "PREQUEL": "Prequel", "ALTERNATIVE": "Alt.",
    "SIDE_STORY": "Side Story", "PARENT": "Parent", "SUMMARY": "Summary",
    "SPIN_OFF": "Spin-off", "OTHER": "Related", "ADAPTATION": "Adaptation",
    "SOURCE": "Source",
}

# Tags in the offline DB that are treated as genres
GENRE_TAGS = {
    "Action", "Adventure", "Comedy", "Ecchi", "Fantasy", "Horror",
    "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological",
    "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
}

# Offline DB status → release_status field
STATUS_MAP_OFFLINE = {
    "FINISHED": "FINISHED",
    "ONGOING":  "RELEASING",
    "UPCOMING": "NOT_YET_RELEASED",
    "UNKNOWN":  "UNKNOWN",
}

# ── COUNTRY — commented out (not in offline DB; AniList fetch too slow) ───────
# Re-enable when a faster enrichment strategy is available.
# COUNTRY_FETCH = False

# ── CHARACTER / STAFF — commented out (AniList fetch too slow) ────────────────
# Re-enable when a faster enrichment strategy is available.
# CHARACTER_FETCH = False


# ── ID COUNTER ────────────────────────────────────────────────────────────────
_next_id = 0

def next_id():
    global _next_id
    _next_id += 1
    return _next_id


# ── STUDIO NORMALIZATION ──────────────────────────────────────────────────────
_STUDIO_FILLER_TOKENS = {
    "co", "ltd", "llc", "inc", "corp", "corporation", "gk", "kk",
    "the", "a", "an", "and", "kabushiki", "kaisha", "yugen", "goshi",
    "animation", "animations", "anime", "production", "productions",
    "studio", "studios", "pictures", "entertainment", "works", "creative",
    "digital", "media", "arts", "lab", "labs",
}

def normalize_studio_name(name):
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
    "our", "their", "no", "season", "part", "chapter", "arc", "movie", "film", "ova",
}

def _score_english_synonym(s):
    if not s or len(s) < 2:
        return 0.0
    ascii_ratio = sum(1 for c in s if ord(c) < 128) / len(s)
    if ascii_ratio < 0.7:
        return 0.0
    words = set(s.lower().split())
    return ascii_ratio + len(words & _COMMON_EN_WORDS) * 0.05

def pick_english_title(synonyms):
    best, best_score = None, 0.5
    for s in synonyms:
        score = _score_english_synonym(s)
        if score > best_score:
            best, best_score = s, score
    return best


# ── ANILIST HELPERS (relation types only) ────────────────────────────────────
_AL_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}

def anilist_query(query, variables, retries=4):
    payload = json.dumps({"query": query, "variables": variables}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(ANILIST_API, data=payload,
                                          headers=_AL_HEADERS, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read())
                if "errors" in body:
                    return None
                return body
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(60)
            elif e.code == 403:
                return None
            else:
                time.sleep(2 ** attempt)
        except Exception:
            time.sleep(2 ** attempt)
    return None

RELATIONS_QUERY = """
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    title { english }
    relations {
      edges {
        relationType(version: 2)
        node { siteUrl }
      }
    }
  }
}
"""

def fetch_relations(al_id):
    """Returns (title_en_or_None, list_of_(url, rel_type))"""
    data = anilist_query(RELATIONS_QUERY, {"id": al_id})
    if not data:
        return None, []
    media = (data.get("data") or {}).get("Media")
    if not media:
        return None, []
    title_en = (media.get("title") or {}).get("english")
    rels = []
    for edge in (media.get("relations") or {}).get("edges", []):
        rt = edge.get("relationType", "")
        if rt not in VALID_RELATION_TYPES:
            continue
        url = (edge.get("node") or {}).get("siteUrl", "")
        if "anilist.co" in url:
            rels.append((url.rstrip("/"), rt))
    return title_en, rels


# ── SLIM A SINGLE ANIME ENTRY ─────────────────────────────────────────────────
def slim_anime(anime):
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

    en_title      = pick_english_title(anime.get("synonyms", []))
    related_urls  = [r for r in anime.get("relatedAnime", []) if "anilist.co" in r]
    release_status = STATUS_MAP_OFFLINE.get(anime.get("status", "UNKNOWN"), "UNKNOWN")

    all_tags   = anime.get("tags", [])
    genre_list = [t for t in all_tags if t in GENRE_TAGS]
    tag_list   = [t for t in all_tags if t not in GENRE_TAGS][:MAX_TAGS]

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
        "genres":         genre_list,
        "tags":           tag_list,
        # "country": None,      # commented out — not in offline DB
        "related_urls":   related_urls,
        "related_typed":  [],
    }


# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("Downloading Anime Offline Database…")

    slim_list, line_num = [], 0
    with urllib.request.urlopen(RELEASE_URL) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8").strip()
            if not line or line_num == 0:
                line_num += 1
                continue
            try:
                slimmed = slim_anime(json.loads(line))
                if slimmed:
                    slim_list.append(slimmed)
            except Exception:
                pass
            line_num += 1

    print(f"  Loaded {len(slim_list)} AniList-linked anime entries.")

    for a in slim_list:
        a["node_id"] = next_id()
    al_url_to_node = {a["al_url"].rstrip("/"): a for a in slim_list}

    # ── Optional: fetch relation type labels from AniList ─────────────────────
    if FETCH_ANILIST:
        print(f"\nFetching relation types from AniList (~1 req/s)…")
        total = len(slim_list)
        for i, a in enumerate(slim_list):
            if i % 100 == 0:
                print(f"  {i}/{total}…")
            title_en, typed_rels = fetch_relations(a["al_id"])
            if title_en:
                a["title_en"] = title_en
            a["related_typed"] = [(url, rel) for url, rel in typed_rels]
            time.sleep(1.1)

    # ── CHARACTER / STAFF nodes — commented out ───────────────────────────────
    # character_nodes, staff_nodes = [], []
    # (re-enable with faster enrichment strategy)

    # ── Studio de-duplication ─────────────────────────────────────────────────
    studio_norm_map, studio_nodes_map = {}, {}
    for a in slim_list:
        for raw_name in a["studios"]:
            fp = normalize_studio_name(raw_name)
            if not fp:
                continue
            if fp not in studio_norm_map:
                nid = next_id()
                studio_norm_map[fp] = nid
                studio_nodes_map[fp] = {"node_id": nid, "type": "studio", "name": raw_name}
            elif len(raw_name) < len(studio_nodes_map[fp]["name"]):
                studio_nodes_map[fp]["name"] = raw_name
    studio_nodes = list(studio_nodes_map.values())

    # ── Genre nodes ───────────────────────────────────────────────────────────
    genre_registry, genre_nodes = {}, []
    for a in slim_list:
        for g in a["genres"]:
            if g not in genre_registry:
                nid = next_id()
                genre_registry[g] = nid
                genre_nodes.append({"node_id": nid, "type": "genre", "name": g})

    # ── Tag nodes ─────────────────────────────────────────────────────────────
    tag_registry, tag_nodes = {}, []
    for a in slim_list:
        for t in a["tags"]:
            if t not in tag_registry:
                nid = next_id()
                tag_registry[t] = nid
                tag_nodes.append({"node_id": nid, "type": "tag", "name": t})

    # ── COUNTRY nodes — commented out ─────────────────────────────────────────
    # country_registry, country_nodes = {}, []

    # ── Build edges ───────────────────────────────────────────────────────────
    edges, edge_set = [], set()

    def add_edge(src, tgt, kind, rel=None):
        key = (min(src, tgt), max(src, tgt), kind)
        if key not in edge_set:
            edge_set.add(key)
            e = {"s": src, "t": tgt, "k": kind}
            if rel:
                e["rel"] = rel
            edges.append(e)

    for a in slim_list:
        anid = a["node_id"]

        if FETCH_ANILIST and a["related_typed"]:
            for url, rel_type in a["related_typed"]:
                target = al_url_to_node.get(url)
                if target and target["node_id"] != anid:
                    add_edge(anid, target["node_id"], "related", RELATION_LABELS.get(rel_type))
        else:
            for url in a["related_urls"]:
                target = al_url_to_node.get(url.rstrip("/"))
                if target and target["node_id"] != anid:
                    add_edge(anid, target["node_id"], "related")

        for raw_name in a["studios"]:
            fp = normalize_studio_name(raw_name)
            if fp in studio_norm_map:
                add_edge(anid, studio_norm_map[fp], "studio")

        for g in a["genres"]:
            if g in genre_registry:
                add_edge(anid, genre_registry[g], "genre")

        for t in a["tags"]:
            if t in tag_registry:
                add_edge(anid, tag_registry[t], "tag")

        # CHARACTER / STAFF edges — commented out
        # for cnid in a.get("_char_ids", []):
        #     add_edge(anid, cnid, "character")

    # ── Build final anime node objects ────────────────────────────────────────
    anime_nodes = []
    for a in slim_list:
        s_ids     = list(set(
            studio_norm_map[normalize_studio_name(s)]
            for s in a["studios"] if normalize_studio_name(s) in studio_norm_map
        ))
        genre_ids = [genre_registry[g] for g in a["genres"] if g in genre_registry]
        tag_ids   = [tag_registry[t]   for t in a["tags"]   if t in tag_registry]

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
            # "country":      None,   # commented out
            "studio_ids":     s_ids,
            "genre_ids":      genre_ids,
            "tag_ids":        tag_ids,
        })

    # ── Write output ──────────────────────────────────────────────────────────
    all_nodes = anime_nodes + studio_nodes + genre_nodes + tag_nodes
    # + character_nodes + staff_nodes   (commented out)

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
    print(f"   Anime:   {len(anime_nodes):,}")
    print(f"   Studios: {len(studio_nodes):,}  (de-duplicated)")
    print(f"   Genres:  {len(genre_nodes):,}  (split from tags)")
    print(f"   Tags:    {len(tag_nodes):,}")
    print(f"   Edges:   {len(edges):,}")
    print(f"   Output:  {OUT_FILE}")


if __name__ == "__main__":
    main()
