# Anigraph

A giant interactive relation graph of every anime in the [Anime Offline Database](https://github.com/manami-project/anime-offline-database) (~40,000+ titles), visualized in your browser via WebGL. Built for AniList users.

## 🚀 Setup (one-time, ~60 seconds)

The raw database is ~45 MB — too large for GitHub. The included script downloads it, strips out unnecessary fields, and produces a compact `data/anime-graph.json` (~4–6 MB) that commits cleanly.

### Step 1 — Run the slim script

```bash
python3 slim-database.py
```

This will:
- Download `anime-offline-database.jsonl` from the official GitHub Releases
- Strip synonyms, producers, MAL/anidb/kitsu sources, duplicate related-anime links
- Keep only AniList URLs, top 12 tags, studios, score, duration, etc.
- De-duplicate studios using token fingerprinting (e.g. "MAPPA" and "MAPPA Co., Ltd." become one node)
- Write `data/anime-graph.json` (~4–6 MB)

**Optional — AniList enrichment** (much slower, run overnight):

Set `FETCH_ANILIST = True` in `slim-database.py` before running. This fetches:
- Accurate English titles from AniList's `title.english` field
- Relation types per edge (Sequel, Prequel, Spin-off, etc.) — shown as edge labels when zoomed in
- Characters and staff per anime

### Step 2 — Commit and push

```bash
git add data/anime-graph.json
git commit -m "Add anime graph database"
git push
```

### Step 3 — Enable GitHub Pages

Go to **Settings → Pages → Source: main branch / root** → Save.

Your app: `https://<yourusername>.github.io/<reponame>/`

---

## 🔄 Updating the database

The upstream database updates weekly. To refresh:

```bash
python3 slim-database.py
git add data/anime-graph.json
git commit -m "Update anime database $(date +%Y-%m-%d)"
git push
```

---

## ✨ Features

- **20,000+ AniList-sourced anime** rendered as WebGL nodes
- **Edges** connect related anime (sequels, prequels, spin-offs) via AniList relation links
  - With `FETCH_ANILIST=True`, edge labels show relation type (Sequel, Prequel, etc.) when zoomed in
- **Color modes** — Node Type, Anime Type, Release Year, Completion Status (when list loaded)
- **Filters** — Type, Release Year range, Episode count, Total length, Tag, Studio, Character, Staff
  - All filter sections are **collapsible** to save space
- **AniList list integration** — Enter your AniList username to filter to your list
  - Filter by status: Completed, Watching, Planning, On-Hold, Dropped, Rewatching
  - Color by completion status when a list is loaded
- **Node selection** — Click any node to highlight it and all its connections; click again to deselect
- **Click any anime node** → opens AniList page
- **Hover** → tooltip with title, type, episodes, studio, score, tags, completion status
- **Tag performance** — tag edges are capped per node to keep the graph smooth
- **Studio de-duplication** — "MAPPA" and "MAPPA Co., Ltd." correctly merge into one node
- **Meta node colors** — Studios, Tags, Characters, Staff always use distinct, fixed colors

## 🛠 Tech Stack

- [Force Graph](https://github.com/vasturiano/force-graph) — 2D WebGL node graph
- [AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs/) — anime list fetching & enrichment
- [Anime Offline Database](https://github.com/manami-project/anime-offline-database) — base data (ODbL license)

## 📁 File Structure

```
anigraph/
├── index.html          # Main app shell
├── slim-database.py    # Database builder script
├── css/
│   └── style.css       # All styles
├── js/
│   ├── anilist.js      # AniList user list fetching
│   ├── filters.js      # Filter logic & color assignment
│   ├── graph.js        # Force-graph instance & rendering
│   └── app.js          # Entry point, loader, event wiring
└── data/
    └── anime-graph.json  # Generated — run slim-database.py
```

## 📄 License

App code: MIT | Database: [ODbL-1.0](https://github.com/manami-project/anime-offline-database/blob/master/LICENSE)
