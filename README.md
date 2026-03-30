# 星座 Anime Constellation

A giant interactive 3D relation graph of every anime in the [Anime Offline Database](https://github.com/manami-project/anime-offline-database) (~40,000+ titles), visualized in your browser.

## ✨ Features

- **40,000+ anime nodes** rendered via WebGL 3D force-directed graph
- **Edges** connect related anime (sequels, prequels, spin-offs) using the `relatedAnime` field
- **Color modes**: by Genre/Tag, Studio, Release Year, or Anime Type
- **Filters**: Type (TV/Movie/OVA/ONA/Special), Release Year range, Episode count range, Total length range (default ≥30 min), Genre, Studio
- **Anime list integration**: Enter your AniList or MyAnimeList username to fetch your completed anime and filter the graph down to only your watched titles
- **Click any node** to open its MAL/AniList page
- **Hover** for a tooltip with title, type, episodes, studio, score, and tags

## 🚀 Usage (GitHub Pages)

1. Fork or clone this repo
2. Go to **Settings → Pages**
3. Set source to **`main` branch, `/ (root)`**
4. Visit `https://yourusername.github.io/anime-constellation`

The app loads the database directly from the Anime Offline Database's GitHub Releases — no backend needed.

## 🛠 Tech Stack

- [3D Force Graph](https://github.com/vasturiano/3d-force-graph) — WebGL node graph
- [Three.js](https://threejs.org/) — 3D rendering
- [AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs/) — anime list fetching (no auth required for public lists)
- [Jikan API](https://jikan.moe/) — MyAnimeList proxy (no auth required)
- [Anime Offline Database](https://github.com/manami-project/anime-offline-database) — data source (ODbL license)

## 📄 License

App code: MIT  
Database: [ODbL-1.0](https://github.com/manami-project/anime-offline-database/blob/master/LICENSE)
