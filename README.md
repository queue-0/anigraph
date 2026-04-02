# 星座 Anime Constellation

A giant interactive 3D relation graph of every anime in the [Anime Offline Database](https://github.com/manami-project/anime-offline-database) (~40,000+ titles), visualized in your browser via WebGL.

## 🚀 Setup (one-time, ~60 seconds)

The raw database is ~45 MB — too large for GitHub. The included script downloads it, strips out unnecessary fields (synonyms, producers, non-AniList sources/links), and produces a compact `data/anime-slim.json` that's **~4–6 MB** and commits cleanly.

### Step 1 — Run the slim script

```bash
python3 slim-database.py
```

This will:
- Download `anime-offline-database.jsonl` from the official GitHub Releases
- Strip synonyms, producers, MAL/anidb/kitsu sources, duplicate related-anime links
- Keep only AniList URLs, top 12 tags, studios, score, duration, etc.
- Write `data/anime-slim.json` (~4–6 MB)

### Step 2 — Commit and push

```bash
git add data/anime-slim.json
git commit -m "Add slimmed anime database"
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
git add data/anime-slim.json
git commit -m "Update anime database $(date +%Y-%m-%d)"
git push
```

---

## ✨ Features

- **~20,000+ AniList-sourced anime** rendered as WebGL nodes in 3D space
- **Edges** connect related anime (sequels, prequels, spin-offs) via AniList relation links
- **Color modes** — Genre/Tag, Studio, Release Year, Anime Type
- **Filters** — Type, Release Year range, Episode count, Total length (default ≥ 30 min), Genre, Studio
- **Anime list integration** — Enter your AniList or MyAnimeList username to filter the graph to only your completed anime
- **Click any node** → opens AniList page
- **Hover** → tooltip with title, type, episodes, studio, score, tags

## 🛠 Tech Stack

- [3D Force Graph](https://github.com/vasturiano/3d-force-graph) — WebGL node graph
- [Three.js](https://threejs.org/) — 3D rendering
- [AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs/) — anime list fetching
- [Jikan API](https://jikan.moe/) — MyAnimeList proxy
- [Anime Offline Database](https://github.com/manami-project/anime-offline-database) — data (ODbL license)

## 📄 License

App code: MIT | Database: [ODbL-1.0](https://github.com/manami-project/anime-offline-database/blob/master/LICENSE)
