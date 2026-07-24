# Toyforthanos

[![GitHub](https://img.shields.io/badge/GitHub-Trancezzzz%2FToyforthanos-blue)](https://github.com/Trancezzzz/Toyforthanos)

Online streaming providers for [Seanime](https://seanime.nyaa.dev) — anime tracking and streaming app.

## Providers

### 🇬🇧 EN — HiAnime

- **ID:** `hianime`
- **Site:** [hianime.ms](https://hianime.ms)
- **Servers:** Ryu (megaplay.buzz), Volt (vidnest.fun), Warp (tryembed.us.cc), Ayame (vidnest.fun/animepahe)
- **Version:** Sub & Dub
- **Manifest:** [`provider/en/hianime/manifest.json`](provider/en/hianime/manifest.json)

```
https://raw.githubusercontent.com/Trancezzzz/Toyforthanos/master/provider/en/hianime/manifest.json
```

### 🇮🇹 IT — AnimeWorld

- **ID:** `animeworld`
- **Site:** [animeworld.ac](https://www.animeworld.ac)
- **Servers:** AnimeWorld, Shiva (internal API rotation)
- **Version:** Sub only
- **Manifest:** [`provider/it/animeworld/manifest.json`](provider/it/animeworld/manifest.json)

```
https://raw.githubusercontent.com/Trancezzzz/Toyforthanos/master/provider/it/animeworld/manifest.json
```

### 🇬🇧 EN — SubsPlease (Torrent)

- **ID:** `subsplease`
- **Site:** [subsplease.org](https://subsplease.org)
- **Type:** Anime Torrent Provider
- **Manifest:** [`provider/en/subsplease/manifest.json`](provider/en/subsplease/manifest.json)

```
https://raw.githubusercontent.com/Trancezzzz/Toyforthanos/master/provider/en/subsplease/manifest.json
```

### 🇬🇧 EN — MangaDex (Manga)

- **ID:** `mangadex`
- **Site:** [mangadex.org](https://mangadex.org)
- **Type:** Manga Provider
- **Manifest:** [`provider/en/mangadex/manifest.json`](provider/en/mangadex/manifest.json)

```
https://raw.githubusercontent.com/Trancezzzz/Toyforthanos/master/provider/en/mangadex/manifest.json
```

### 🇬🇧 EN — MangaFire (Manga, bypassd required)

- **ID:** `mangafire`
- **Site:** [mangafire.to](https://mangafire.to)
- **Type:** Manga Provider (requires bypassd sidecar)
- **Manifest:** [`provider/en/mangafire/manifest.json`](provider/en/mangafire/manifest.json)

```
https://raw.githubusercontent.com/Trancezzzz/Toyforthanos/master/provider/en/mangafire/manifest.json
```

### 🇬🇧 EN — MangaPark (Manga, dead domains)

- **ID:** `mangapark`
- **Site:** mangapark.net / mangapark.org (all redirect to spam landing pages)
- **Status:** Dead — redirects to MEGA/SpinzyWheel — kept for reference

```
https://raw.githubusercontent.com/Trancezzzz/Toyforthanos/master/provider/en/mangapark/manifest.json
```

## How to Install

### For most providers (HiAnime, AnimeWorld, SubsPlease, MangaDex)

1. Open **Seanime**
2. Go to **Settings → Extensions / Online Streaming Providers** (type-specific)
3. Click **Add Extension**
4. Paste the manifest URL from above
5. The provider appears in your list

### For Cloudflare-protected providers (MangaFire)

These providers need the **bypassd** stealth browser sidecar running locally.

#### Install bypassd

```bash
# From the repo root
cd bypassd
npm install
```

#### Run bypassd

```bash
# Terminal 1 — start the stealth browser proxy
cd bypassd
node server.js
# listening on :8191
```

The server launches a stealth Chrome instance and listens at `http://localhost:8191`. Keep it running while using MangaFire in Seanime — the provider calls bypassd via HTTP for all requests.

## Repo

```
https://github.com/Trancezzzz/Toyforthanos
```
