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

### 🌐 Multi — Nyaa+ (Torrent)

- **ID:** `nyaa-plus`
- **Site:** [nyaa.si](https://nyaa.si)
- **Type:** Anime Torrent Provider — improved drop-in for the stock Island Nyaa provider
- **Lang:** Multi (English / Romaji / Japanese titles searched automatically)
- **Manifest:** [`provider/en/nyaa/manifest.json`](provider/en/nyaa/manifest.json)

```
https://raw.githubusercontent.com/Trancezzzz/Toyforthanos/master/provider/en/nyaa/manifest.json
```

What's better than the stock provider:
- **All smart-search options show in the UI** — batch, episode number, resolution, query *and* best releases (the stock one is missing `bestReleases`)
- **Instant magnets** — built straight from the RSS info hash, no torrent-page scraping (stock fetches every page)
- **Accurate season/episode handling** — explicit-marker extraction that never misfires on numeric titles (`86`, `91 Days`), season/part verification, multi-season packs, absolute episode numbering via `absoluteSeasonOffset`
- **AniList-derived episode offsets (v2.1+)** — later seasons get their absolute offset computed live from AniList, so SubsPlease-style continuing numbering (`Jujutsu Kaisen - 29` = S2E5) now matches. v2.3 extends this to **markerless sequels** (`Kaguya-sama: Love Is War? Ultra Romantic`) via AniList's relation graph. Cached 24h.
- **Quality preferences (v2.3)** — `preferredResolution` (e.g. `1080`) and `preferDualAudio` config fields steer which release `bestReleases` picks: preferred resolution dominates, then dual-audio (~2 resolution tiers), then raw resolution, then HEVC
- **Freshness ordering (v2.3)** — for *airing* shows, the newest release of the episode sorts first (no more stale high-seed retimes on top); finished shows stay seeders-first
- **Mirror failover (v2.1)** — `apiUrl` accepts a comma-separated list (`https://nyaa.si,https://nyaa.iss.one`); dead mirrors are rotated automatically and the working one is remembered
- **8 public trackers** — on every magnet, better swarm survival
- **Query precedence fix (v2.1)** — episode/batch terms are ANDed onto *every* title variant, not just the last one
- **Multi-language queries** — English, Romaji and Japanese synonyms are all queried and matched
- **Performance** — parallel query fan-out, 3-min TTL cache, dedupe by info hash, results capped & sorted by seeders

> Tip: if you also have the built-in *Nyaa* provider installed, disable it in Settings → Extensions so `Nyaa+` is the default.

**Testing:** a goja-compatible harness lives in [`provider/en/nyaa/tests/`](provider/en/nyaa/tests/) (stubbed `fetch`/`$habari`/`$scannerUtils`, live nyaa.si + graphql.anilist.co). Run from that directory:

```
npm test
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
