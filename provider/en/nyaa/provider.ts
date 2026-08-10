/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

// Nyaa+ — improved Nyaa anime torrent provider for Seanime
// ------------------------------------------------------------------
// vs. the stock island.clap.ing Nyaa provider:
//  - Advertises ALL smart search filters (batch, episodeNumber, resolution,
//    query, bestReleases) so every option shows up in the search drawer.
//  - bestReleases fully implemented (marks + filters top-resolution picks).
//  - Magnet links built directly from RSS info hashes — zero page scraping,
//    instant magnet retrieval (stock provider scrapes every torrent page).
//  - Season/part extraction that never misfires on numeric titles (86, 91
//    Days, 3-gatsu no Lion, 5-toubun...) — explicit markers only.
//  - Episode parsing with strong fallbacks (habari -> regex chain).
//  - Multi-language queries: English, Romaji, Japanese synonyms all tried.
//  - Per-query TTL cache, parallel query fan-out, dedupe by info hash,
//    seeders/quality sorting, result caps.
//  - Absolute episode offsets derived live from AniList (graphql.anilist.co
//    is whitelisted in Seanime's fetch runtime) — cracks SubsPlease-style
//    continuing numbering ("Jujutsu Kaisen - 29" = S2E5). Cached 24h.
//  - Mirror failover: apiUrl accepts a comma-separated list; failed mirrors
//    are rotated and remembered.
//  - Quality preferences (preferredResolution, preferDualAudio) steer the
//    bestReleases picks instead of raw resolution alone.
//  - Freshness-aware ordering for RELEASING media — the newest release of the
//    episode wins, not the oldest high-seed torrent.

interface ProviderConfig {
    baseUrls: string[]
    category: string
    filter: string
    maxResults: number
    preferredResolution: string
    preferDualAudio: boolean
    preferredGroups: string[]
}

interface RawTorrent {
    name: string
    link: string
    downloadUrl: string
    date: string
    seeders: string
    leechers: string
    downloads: string
    infoHash: string
    size: string
    metadata: $habari.Metadata
}

interface SmartQuery {
    query: string
    sortBy: string
}

type Torrent = AnimeTorrent & { metadata: $habari.Metadata }

const DEFAULT_API_URL = "https://nyaa.si"
const DEFAULT_CATEGORY = "1_2"
const DEFAULT_FILTER = "0"
const DEFAULT_MAX_RESULTS = 60
const DEFAULT_PREFERRED_RESOLUTION = ""
const DEFAULT_PREFER_DUAL_AUDIO = "false"
const DEFAULT_PREFERRED_GROUPS = ""

const CACHE_TTL_MS = 3 * 60 * 1000
const CACHE_MAX_ENTRIES = 24

const ABS_OFFSET_TTL_MS = 24 * 60 * 60 * 1000
const MAX_MIRROR_ATTEMPTS = 5

// per-request timeouts (seconds) — the runtime default is 35s, which makes a
// black-holed mirror cost half a minute before failover rotates
const RSS_TIMEOUT_S = 10
const ANILIST_TIMEOUT_S = 8

// filtered-result cache: the UI re-fires smartSearch with debounced values,
// so identical option sets are served from memory (~0ms) instead of
// re-running parse + filter + AniList
const OP_CACHE_TTL_MS = 90 * 1000
const OP_CACHE_MAX_ENTRIES = 32

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://tracker.pomf.se:80/announce",
    // verified reachable at add time (probed 2026-08)
    "udp://bt1.archive.org:6969/announce",
    "http://bt1.archive.org:6969/announce",
    "udp://open.demonii.si:1337/announce",
    "http://open.demonii.si:1337/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://1337.abcvg.info:80/announce",
]

//@ts-ignore
class Provider {
    canSmartSearch = true
    supportsAdult = false

    private _cache = new Map<string, { time: number, torrents: RawTorrent[] }>()
    private _absOffCache = new Map<number, { time: number, offset: number }>()
    private _opCache = new Map<string, { time: number, torrents: Torrent[] }>()
    // mirror ordering with penalty memory: failed mirrors sink to the back
    private _mirrorOrder: string[] | null = null

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const raw = await this.fetchRSS("", "id")
            const torrents = raw.slice(0, this.getConfig().maxResults).map(t => this.toAnimeTorrent(t))
            console.log("nyaa-plus: " + torrents.length + " latest torrents")
            return torrents
        } catch (error) {
            console.error("nyaa-plus: getLatest error: " + (error as Error).message)
            return []
        }
    }

    async search(options: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const raw = await this.fetchRSS(options.query, "seeders")
            const torrents = raw.slice(0, this.getConfig().maxResults).map(t => this.toAnimeTorrent(t))
            torrents.sort(this.compareTorrents)
            console.log("nyaa-plus: " + torrents.length + " results for '" + options.query + "'")
            return torrents
        } catch (error) {
            console.error("nyaa-plus: search error: " + (error as Error).message)
            return []
        }
    }

    async smartSearch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const tStart = Date.now()
        try {
            // op-level cache: the UI re-fires identical smart searches while
            // debouncing — serve the already-filtered result instead of
            // re-running parse + filter + AniList
            const opKey = this.buildOpCacheKey(options)
            const opHit = this._opCache.get(opKey)
            if (opHit && Date.now() - opHit.time < OP_CACHE_TTL_MS) {
                console.log("nyaa-plus: op-cache hit, " + opHit.torrents.length + " torrents in " + (Date.now() - tStart) + "ms")
                return opHit.torrents
            }

            // derive an absolute episode offset from AniList whenever the media
            // doesn't already carry one. catches BOTH marker-qualified sequels
            // ("Jujutsu Kaisen 2nd Season") and markerless ones ("Kaguya-sama:
            // Love Is War? Ultra Romantic"). STARTED IN PARALLEL with the RSS
            // fan-out so a cold AniList round-trip doesn't serialize on top.
            const needsOffset = !!(options.episodeNumber && options.episodeNumber > 0)
                && !((options.media.absoluteSeasonOffset || 0) > 0)
            const offPromise = needsOffset ? this.getAnilistSeasonOffset(options.media) : Promise.resolve(0)

            const base = this.buildSmartSearchQueries(options, 0)
            if (!base.queries || base.queries.length === 0) {
                console.warn("nyaa-plus: smart search: no queries generated")
                return []
            }

            // fan out all queries in parallel
            const tRss = Date.now()
            const results = await Promise.all(base.queries.map(async (q) => {
                try {
                    return await this.fetchRSS(q.query, q.sortBy)
                } catch (e) {
                    console.error("nyaa-plus: query failed (" + q.query + "): " + (e as Error).message)
                    return [] as RawTorrent[]
                }
            }))
            const rssMs = Date.now() - tRss

            // absolute episode query fires once the offset resolves (usually
            // already done by now) and merges into the same pool
            const tAni = Date.now()
            const absOffset = await offPromise
            const aniMs = Date.now() - tAni
            if (absOffset > 0) {
                const withAbs = this.buildSmartSearchQueries(options, absOffset)
                if (withAbs.absQuery) {
                    try {
                        const extra = await this.fetchRSS(withAbs.absQuery.query, withAbs.absQuery.sortBy)
                        results.push(extra)
                    } catch (e) {
                        console.error("nyaa-plus: absolute query failed: " + (e as Error).message)
                    }
                }
            }

            // dedupe by info hash (then by download URL)
            const unique = new Map<string, RawTorrent>()
            for (const raw of results.flat()) {
                if (!raw.name) continue
                const key = raw.infoHash || raw.downloadUrl || raw.link
                if (!unique.has(key)) unique.set(key, raw)
            }

            let torrents = [...unique.values()].map(t => this.toAnimeTorrent(t))
            console.log("nyaa-plus: " + torrents.length + " unique before filtering (rss " + rssMs + "ms, anilist " + aniMs + "ms)")

            torrents = this.filterSmartResults(torrents, options, absOffset)

            if (options.bestReleases) {
                this.markBestReleases(torrents)
                torrents = torrents.filter(t => t.isBestRelease)
            }

            // airing shows: newest release of the episode first (groups ship
            // retimes/v2s); finished shows: seeders first as usual
            const releasing = options.media.status === "RELEASING" && !options.batch && (options.episodeNumber || 0) > 0
            this.sortTorrents(torrents, releasing)

            this._opCache.set(opKey, { time: Date.now(), torrents })
            if (this._opCache.size > OP_CACHE_MAX_ENTRIES) {
                const oldest = this._opCache.keys().next().value
                if (oldest) this._opCache.delete(oldest)
            }

            console.log("nyaa-plus: " + torrents.length + " torrents after filtering in " + (Date.now() - tStart) + "ms")
            return torrents
        } catch (error) {
            console.error("nyaa-plus: smartSearch error: " + (error as Error).message)
            return []
        }
    }

    private buildOpCacheKey(options: AnimeSmartSearchOptions): string {
        const m = options.media
        return [
            m.idMal || m.id || 0,
            m.status || "",
            options.episodeNumber || 0,
            options.batch ? 1 : 0,
            options.resolution || "",
            options.bestReleases ? 1 : 0,
            options.query || "",
        ].join("|")
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        // fast path: info hash straight from the RSS feed, no scraping
        if (torrent.infoHash) {
            return this.buildMagnet(torrent.infoHash, torrent.name)
        }

        // fallback: scrape the torrent page for a magnet link
        try {
            const res = await fetch(torrent.link)
            const html = res.text()
            const $ = LoadDoc(html)

            let magnetLink = ""
            $("a[href^='magnet:']").each((i: number, el) => {
                const href = el.attr("href")
                if (href && href.startsWith("magnet:")) {
                    magnetLink = href
                    return false
                }
            })

            if (!magnetLink) throw new Error("no magnet link on page")
            return magnetLink
        } catch (error) {
            console.error("nyaa-plus: magnet fetch failed: " + (error as Error).message)
            throw new Error("Could not fetch magnet link for: " + torrent.name)
        }
    }

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query", "bestReleases"],
            supportsAdult: false,
            type: "main",
        }
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private getConfig(): ProviderConfig {
        let apiUrl = "{{apiUrl}}"
        if (!apiUrl || apiUrl.startsWith("{{")) apiUrl = DEFAULT_API_URL

        // comma-separated mirror list: "https://nyaa.si,https://nyaa.iss.one"
        const baseUrls = apiUrl
            .split(",")
            .map(u => u.trim().replace(/\/+$/, ""))
            .filter(u => u.length > 0)
            .map(u => u.startsWith("http") ? u : "https://" + u)
        if (baseUrls.length === 0) baseUrls.push(DEFAULT_API_URL)

        let category = "{{category}}"
        if (!category || category.startsWith("{{")) category = DEFAULT_CATEGORY

        let filter = "{{filter}}"
        if (!filter || filter.startsWith("{{")) filter = DEFAULT_FILTER

        let maxResults = parseInt("{{maxResults}}", 10)
        if (isNaN(maxResults) || maxResults <= 0) maxResults = DEFAULT_MAX_RESULTS
        if (maxResults > 150) maxResults = 150

        let preferredResolution = "{{preferredResolution}}"
        if (!preferredResolution || preferredResolution.startsWith("{{")) preferredResolution = DEFAULT_PREFERRED_RESOLUTION

        let preferDualAudio = "{{preferDualAudio}}"
        if (!preferDualAudio || preferDualAudio.startsWith("{{")) preferDualAudio = DEFAULT_PREFER_DUAL_AUDIO

        let preferredGroups = "{{preferredGroups}}"
        if (!preferredGroups || preferredGroups.startsWith("{{")) preferredGroups = DEFAULT_PREFERRED_GROUPS

        return {
            baseUrls: baseUrls,
            category: category,
            filter: filter,
            maxResults: maxResults,
            preferredResolution: preferredResolution.trim(),
            preferDualAudio: preferDualAudio.toLowerCase() === "true",
            preferredGroups: preferredGroups.split(",").map(g => g.trim().toLowerCase()).filter(g => g.length > 0),
        }
    }

    private buildURLFor(base: string, query: string, sortBy: string = "seeders"): string {
        const cfg = this.getConfig()
        const qs = "page=rss&q=" + encodeURIComponent(query) + "&c=" + cfg.category + "&f=" + cfg.filter + "&s=" + sortBy + "&o=desc"
        return base + "/?" + qs
    }

    private async fetchRSS(query: string, sortBy: string = "seeders"): Promise<RawTorrent[]> {
        // TTL cache — the UI re-triggers smart search with debounced values,
        // no point hammering nyaa for identical queries
        const cfg = this.getConfig()
        if (!this._mirrorOrder) this._mirrorOrder = [...cfg.baseUrls]

        const cachedUrl = this.buildURLFor(this._mirrorOrder[0], query, sortBy)
        const hit = this._cache.get(cachedUrl)
        if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.torrents

        // mirror failover with penalty memory: try mirrors in order of
        // preference; a failed mirror sinks to the back of the rotation so
        // every subsequent search doesn't re-hang on it. per-request timeout
        // keeps a black-holed mirror to ~10s instead of the runtime's 35s.
        const attempts = Math.min(this._mirrorOrder.length, MAX_MIRROR_ATTEMPTS)
        let lastError: Error | null = null

        for (let attempt = 0; attempt < attempts; attempt++) {
            const base = this._mirrorOrder[0]
            const attemptUrl = this.buildURLFor(base, query, sortBy)
            try {
                const res = await fetch(attemptUrl, { timeout: RSS_TIMEOUT_S })
                if (!res.ok) throw new Error("HTTP " + res.status)
                const torrents = this.parseRSSFeed(res.text())

                this._cache.set(attemptUrl, { time: Date.now(), torrents })
                if (this._cache.size > CACHE_MAX_ENTRIES) {
                    const oldest = this._cache.keys().next().value
                    if (oldest) this._cache.delete(oldest)
                }

                if (attempt > 0) console.log("nyaa-plus: using mirror " + base)
                return torrents
            } catch (e) {
                lastError = e as Error
                console.error("nyaa-plus: mirror " + base + " failed for '" + query + "': " + (e as Error).message)
                // sink the failed mirror to the back of the rotation so it
                // costs at most one attempt per search, not every search
                this._mirrorOrder.splice(0, 1)
                this._mirrorOrder.push(base)
            }
        }

        throw lastError || new Error("all mirrors failed")
    }

    // ------------------------------------------------------------------
    // Absolute episode offset via AniList.
    //
    // Some groups (SubsPlease, Erai-raws) number later seasons with
    // continuing episode counts ("Jujutsu Kaisen - 29" is S2E5 because S1
    // had 24 episodes). Seanime only supplies absoluteSeasonOffset when the
    // media carries it, so we derive it ourselves: sum the episode counts of
    // every anime-season relation (TV/TV_SHORT/ONA, PREQUEL/SEQUEL/PARENT)
    // that finished airing before this media started. graphql.anilist.co is
    // whitelisted in the runtime. Cached 24h per media id.
    // ------------------------------------------------------------------
    private async getAnilistSeasonOffset(media: Media): Promise<number> {
        // idMal and AniList id are different ID spaces — filter by whichever exists
        const hasMal = !!(media.idMal && media.idMal > 0)
        const key = hasMal ? media.idMal : (media.id || 0)
        if (!key) return 0

        const cached = this._absOffCache.get(key)
        if (cached && Date.now() - cached.time < ABS_OFFSET_TTL_MS) return cached.offset

        let offset = 0
        try {
            const query = (hasMal ? "Media(idMal: $id)" : "Media(id: $id)")
                + " { startDate { year month day } relations { edges { relationType node { type format episodes endDate { year month day } } } } }"
            const res = await fetch("https://graphql.anilist.co", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ query: "query ($id: Int) { " + query + " }", variables: { id: key } }),
                timeout: ANILIST_TIMEOUT_S,
            })
            if (!res.ok) throw new Error("HTTP " + res.status)

            const json = res.json()
            const node = json && json.data ? json.data.Media : null
            if (!node) throw new Error("media not found")

            const mediaStart = this.dateToTs(node.startDate)

            for (const edge of (node.relations && node.relations.edges) || []) {
                const rel = edge && edge.node ? edge.node : null
                if (!rel || rel.type !== "ANIME") continue
                if (rel.format !== "TV" && rel.format !== "TV_SHORT" && rel.format !== "ONA") continue
                if (edge.relationType !== "PREQUEL" && edge.relationType !== "SEQUEL" && edge.relationType !== "PARENT") continue

                const eps = parseInt(rel.episodes, 10)
                if (!eps || eps <= 0) continue

                // only count seasons that fully finished before this one started
                const relEnd = this.dateToTs(rel.endDate)
                if (relEnd > 0 && mediaStart > 0 && relEnd > mediaStart) continue

                offset += eps
            }

            console.log("nyaa-plus: anilist offset for " + key + " = " + offset)
        } catch (e) {
            console.error("nyaa-plus: anilist offset fetch failed: " + (e as Error).message)
            offset = 0
        }

        this._absOffCache.set(key, { time: Date.now(), offset: offset })
        return offset
    }

    private dateToTs(d: { year?: number, month?: number, day?: number } | null | undefined): number {
        if (!d || !d.year) return 0
        return new Date(d.year, (d.month || 1) - 1, d.day || 1).getTime()
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private buildSmartSearchQueries(opts: AnimeSmartSearchOptions, absOffset: number = 0): { queries: SmartQuery[], absQuery: SmartQuery | null } {
        const { media, query: userQuery, batch, episodeNumber, resolution } = opts

        // user-provided query takes priority, single query
        if (userQuery) {
            const q = resolution ? userQuery + " " + resolution : userQuery
            return { queries: [{ query: q, sortBy: "seeders" }], absQuery: null }
        }

        const allTitles = [
            media.romajiTitle || "",
            media.englishTitle || "",
            ...(media.synonyms || []),
        ].filter(Boolean)

        if (allTitles.length === 0) return { queries: [], absQuery: null }

        const processed = $scannerUtils.buildSmartSearchTitles(allTitles)
        const titles = processed.titles || []
        // sanity caps so numeric titles like "86" or "91 Days" can't poison
        // season/part logic (they parse as trailing numbers otherwise)
        const season = processed.season > 0 && processed.season <= 12 ? processed.season : 0
        const part = processed.part > 0 && processed.part <= 4 ? processed.part : 0

        if (titles.length === 0) return { queries: [], absQuery: null }

        // shorter titles are less restrictive -> higher priority
        const sorted = [...titles].sort((a, b) => a.length - b.length)

        const isMovie = media.format === "MOVIE" && (media.episodeCount || 0) === 1
        const canBatch = media.status === "FINISHED" && (media.episodeCount || 0) > 0

        let queries: SmartQuery[]
        let absQuery: SmartQuery | null = null
        if (batch && canBatch && !isMovie) {
            queries = this.buildBatchQueries(sorted, season, part, media, resolution)
        } else if (isMovie) {
            queries = this.buildMovieQueries(sorted, resolution)
        } else {
            queries = this.buildEpisodeQueries(sorted, season, part, episodeNumber, media, resolution, absOffset)
            absQuery = queries.length > 0 && absOffset > 0 ? queries[queries.length - 1] : null
        }

        // dedupe and cap
        const seen = new Set<string>()
        const unique: SmartQuery[] = []
        for (const q of queries) {
            const key = q.query + "|" + q.sortBy
            if (!seen.has(key)) {
                seen.add(key)
                unique.push(q)
            }
            if (unique.length >= 6) break
        }

        // the abs query is last in the array; make sure the cap didn't drop it
        if (absQuery && !seen.has(absQuery.query + "|" + absQuery.sortBy) && unique.length >= 6) {
            unique.pop()
            unique.push(absQuery)
        }

        return { queries: unique, absQuery: absQuery }
    }

    // 1. Exact-phrase title group + episode (catches every language variant)
    // 2. Shortest title + episode (broadest catch)
    // 3. Season-qualified title + episode (if season > 1)
    // 4. Part-qualified title + episode (if part > 1)
    // 5. Alternative title + episode (different language/variant)
    // 6. Absolute episode number (if the media uses absolute numbering)
    private buildEpisodeQueries(
        sorted: string[], season: number, part: number,
        episodeNumber: number, media: Media, resolution: string, absOffset: number = 0
    ): SmartQuery[] {
        const queries: SmartQuery[] = []
        const resStr = resolution ? " " + resolution : " (360|480|720|1080)"
        const epGroup = this.buildEpisodeGroup(episodeNumber, season)
        const primary = sorted[0]
        const secondary = sorted.length > 1 ? sorted[1] : ""
        const offset = (media.absoluteSeasonOffset || 0) || absOffset
        const hasAbsoluteOffset = offset > 0

        const exactGroup = this.buildExactTitleGroup(media, epGroup + resStr)
        if (exactGroup) {
            queries.push({ query: exactGroup, sortBy: "seeders" })
        }

        queries.push({ query: primary + " " + epGroup + resStr, sortBy: "seeders" })

        if (season > 1) {
            queries.push({ query: $scannerUtils.buildSeasonQuery(primary, season) + " " + epGroup + resStr, sortBy: "seeders" })
        }

        if (part > 1) {
            queries.push({ query: $scannerUtils.buildPartQuery(primary, part) + " " + epGroup + resStr, sortBy: "seeders" })
        }

        if (secondary) {
            queries.push({ query: secondary + " " + epGroup + resStr, sortBy: "seeders" })
        }

        if (hasAbsoluteOffset && episodeNumber > 0) {
            const absEp = episodeNumber + offset
            // continuing-numbering groups name torrents after the franchise
            // base title ("Jujutsu Kaisen - 29"), not the season-qualified one
            const base = this.getBaseFranchiseTitles(media)[0] || $scannerUtils.buildSearchQuery(primary)
            if (base) {
                queries.push({ query: base + " " + this.buildEpisodeGroup(absEp, 0, true) + resStr, sortBy: "seeders" })
            }
        }

        return queries
    }

    // 1. Exact-phrase group + batch terms (size)
    // 2. Shortest title + batch terms (size)
    // 3. Season/part-qualified + batch terms / disc terms
    // 4. Shortest title + disc terms
    // 5. Alternative title + batch terms
    // 6. Title-only (size) — catches oddly-named packs
    private buildBatchQueries(
        sorted: string[], season: number, part: number,
        media: Media, resolution: string
    ): SmartQuery[] {
        const queries: SmartQuery[] = []
        const resStr = resolution ? " " + resolution : " (360|480|720|1080)"
        const primary = sorted[0]
        const secondary = sorted.length > 1 ? sorted[1] : ""
        const batchTerms = this.buildBatchTerms(media)
        const discTerms = " (BD|Blu-ray|BDRip|Remux|HEVC|x265|10bit|Dual-Audio|Dual Audio)"

        const exactGroup = this.buildExactTitleGroup(media, batchTerms + resStr)
        if (exactGroup) {
            queries.push({ query: exactGroup, sortBy: "size" })
        }

        queries.push({ query: primary + batchTerms + resStr, sortBy: "size" })

        if (season > 1) {
            const seasonQ = $scannerUtils.buildSeasonQuery(primary, season)
            queries.push({ query: seasonQ + batchTerms + resStr, sortBy: "size" })
            queries.push({ query: seasonQ + discTerms + resStr, sortBy: "size" })
        } else if (part > 1) {
            queries.push({ query: $scannerUtils.buildPartQuery(primary, part) + batchTerms + resStr, sortBy: "size" })
        }

        queries.push({ query: primary + discTerms + resStr, sortBy: "size" })

        if (secondary) {
            queries.push({ query: secondary + batchTerms + resStr, sortBy: "size" })
        }

        queries.push({ query: primary + resStr, sortBy: "size" })

        return queries
    }

    private buildMovieQueries(sorted: string[], resolution: string): SmartQuery[] {
        const queries: SmartQuery[] = []
        const resStr = resolution ? " " + resolution : " (360|480|720|1080)"
        const primary = sorted[0]
        const secondary = sorted.length > 1 ? sorted[1] : ""

        queries.push({ query: primary + resStr, sortBy: "seeders" })
        if (secondary) {
            queries.push({ query: secondary + resStr, sortBy: "seeders" })
        }
        queries.push({ query: primary + " (BD|Blu-ray|BDRip|HEVC|WEB-DL)" + resStr, sortBy: "seeders" })

        return queries
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Post-filter results for accuracy:
    //  - episode must match (relative or absolute)
    //  - title must match one of the media titles (weighted token match)
    //  - torrent must not predate the anime's airing window
    //  - season/part verification only when explicitly marked
    private filterSmartResults(torrents: Torrent[], opts: AnimeSmartSearchOptions, absOffset: number = 0): Torrent[] {
        const { media, batch, episodeNumber, query: userQuery } = opts
        const isMovie = media.format === "MOVIE" && (media.episodeCount || 0) === 1
        const expectedSeason = this.getExpectedSeason(media)
        const expectedPart = this.getExpectedPart(media)
        const offset = (media.absoluteSeasonOffset || 0) || absOffset
        const hasAbsoluteOffset = offset > 0
        const absEp = hasAbsoluteOffset && episodeNumber > 0 ? episodeNumber + offset : -1
        const minDate = this.getMediaMinDate(media)
        // users who typed a custom query know what they want — relax title matching
        const titleThreshold = userQuery ? 0.4 : (batch ? 0.55 : 0.65)
        const queryTitle = userQuery ? $scannerUtils.buildSearchQuery(userQuery) : ""

        return torrents.filter(t => {
            const ep = t.episodeNumber ?? -1

            // --- movie: no episode required ---
            if (isMovie) {
                if (!this.torrentMatchesMedia(t, media, 0.6, queryTitle)) return false
                if (!this.torrentAfterDate(t, minDate)) return false
                return true
            }

            // --- batch: must look like a batch ---
            if (batch) {
                const isBatch = t.isBatch || (ep === -1 && this.torrentMatchesMedia(t, media, 0.55, queryTitle))
                if (!isBatch) return false
                if (ep > 0) return false // single-episode torrents are not batches
                if (!this.torrentMatchesMedia(t, media, titleThreshold, queryTitle)) return false
                if (!this.torrentAfterDate(t, minDate)) return false
                if (this.torrentContainsCompleteKeywords(t.name)) return true
                return this.verifySeasonAndPart(t, media, expectedSeason, expectedPart, hasAbsoluteOffset)
            }

            // --- single episode ---
            if (episodeNumber > 0) {
                // episode must match relative OR absolute
                if (ep !== episodeNumber && (absEp < 0 || ep !== absEp)) return false
            }
            // episodeNumber === 0 -> any episode accepted (e.g. user cleared the box)

            // no episode number at all: only allow if it's clearly a batch-ish release
            if (ep < 0 && !this.isTorrentLikelyBatch(t.name)) return false

            if (!this.torrentMatchesMedia(t, media, titleThreshold, queryTitle)) return false
            if (!this.torrentAfterDate(t, minDate)) return false

            // skip season verification when absolute numbering spans seasons,
            // or when no season was detected for the media
            if (!hasAbsoluteOffset && expectedSeason > 0) {
                const torrentSeason = this.getTorrentSeason(t)
                if (expectedSeason > 1) {
                    if (torrentSeason > 0 && torrentSeason !== expectedSeason) return false
                } else {
                    if (torrentSeason > 1) return false
                }
            }

            if (!this.verifyPart(t, expectedPart)) return false

            return true
        })
    }

    private verifySeasonAndPart(t: Torrent, media: Media, expectedSeason: number, expectedPart: number, hasAbsoluteOffset: boolean): boolean {
        if (!hasAbsoluteOffset && expectedSeason > 0) {
            const torrentSeason = this.getTorrentSeason(t)
            const multiSeasonRange = this.getMultiSeasonRange(t.name)

            if (multiSeasonRange) {
                if (expectedSeason < multiSeasonRange[0] || expectedSeason > multiSeasonRange[1]) return false
            } else if (expectedSeason > 1) {
                if (torrentSeason !== expectedSeason) return false
            } else {
                if (torrentSeason > 1) return false
            }
        }

        return this.verifyPart(t, expectedPart)
    }

    private verifyPart(t: Torrent, expectedPart: number): boolean {
        const torrentPart = this.getTorrentPart(t)
        if (expectedPart > 0) {
            if (torrentPart > 0 && torrentPart !== expectedPart) return false
        } else {
            // media has no part — reject packs explicitly marked Part 2+
            if (torrentPart > 1) return false
        }
        return true
    }

    // mark the highest-quality release per episode (and per batch) as best.
    // scoring: preferredResolution (if set) dominates, then dual-audio (if
    // preferred, worth ~2 resolution tiers), then preferredGroups, then
    // resolution, then HEVC/x265. for batches, a release group's COMPLETE pack
    // ("01-12") outranks its own partial splits ("01-06" + "07-12").
    private markBestReleases(torrents: Torrent[]): void {
        const cfg = this.getConfig()
        const targetRes = parseInt(cfg.preferredResolution, 10) || 0
        const groups = new Map<string, Torrent[]>()

        for (const t of torrents) {
            const key = t.isBatch ? "batch" : "ep" + (t.episodeNumber ?? -1)
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key)!.push(t)
        }

        const score = (t: Torrent): number => {
            const r = parseInt(t.resolution || "", 10) || 0
            let s = r
            if (targetRes > 0 && r === targetRes) s += 1500
            if (cfg.preferDualAudio && this.isDualAudio(t.name)) s += 500
            if (cfg.preferredGroups.some(g => t.name.toLowerCase().includes(g))) s += 300
            if (this.isHevc(t.name)) s += 10
            return s
        }

        for (const [, group] of groups) {
            let bestScore = -1
            const scored: { t: Torrent, s: number }[] = []

            if (group[0].isBatch && group.length > 1) {
                // per release group, find the largest pack range; only members
                // holding the complete pack qualify for the pack bonus
                const maxPack = new Map<string, number>()
                for (const t of group) {
                    const gk = this.torrentGroupKey(t)
                    const size = this.packRangeSize(t.name)
                    if (!maxPack.has(gk) || size > maxPack.get(gk)!) maxPack.set(gk, size)
                }
                for (const t of group) {
                    const gk = this.torrentGroupKey(t)
                    let s = score(t)
                    if ((maxPack.get(gk) || 0) > 0 && this.packRangeSize(t.name) === maxPack.get(gk)) s += 2000
                    scored.push({ t, s })
                    if (s > bestScore) bestScore = s
                }
            } else {
                for (const t of group) {
                    const s = score(t)
                    scored.push({ t, s })
                    if (s > bestScore) bestScore = s
                }
            }

            for (const { t, s } of scored) {
                t.isBestRelease = bestScore > 0 && s === bestScore
            }
        }
    }

    private isDualAudio(name: string): boolean {
        return /dual[- ]?audio/i.test(name)
    }

    private isHevc(name: string): boolean {
        return /\b(hevc|x265|10bit)\b/i.test(name)
    }

    private torrentGroupKey(t: Torrent): string {
        if (t.metadata && t.metadata.release_group) return t.metadata.release_group.toLowerCase()
        const m = t.name.match(/^\[([^\]]+)\]/)
        return m ? m[1].toLowerCase() : "?"
    }

    // how many episodes a batch pack covers, from its range markers.
    // "01-12" -> 12, "E01-E12" -> 12, "S1-S3" -> 3, "Complete Series" -> 999
    private packRangeSize(name: string): number {
        let m = name.match(/\bE?0*(\d{1,3})\s*[-~]\s*E?0*(\d{1,3})\b/i)
        if (m) {
            const s = parseInt(m[1], 10), e = parseInt(m[2], 10)
            if (e > s && e <= 300) return e - s + 1
        }
        m = name.match(/\bS0*(\d{1,3})\s*[-~]\s*S?0*(\d{1,3})\b/i)
        if (m) {
            const s = parseInt(m[1], 10), e = parseInt(m[2], 10)
            if (e > s) return e - s + 1
        }
        if (/\bcomplete\s+(?:series|collection)\b/i.test(name)) return 999
        return 0
    }

    private sortTorrents(torrents: Torrent[], freshness: boolean = false): Torrent[] {
        if (!freshness) return torrents.sort(this.compareTorrents)
        return torrents.sort((a, b) => {
            const d1 = a.date ? new Date(a.date).getTime() : 0
            const d2 = b.date ? new Date(b.date).getTime() : 0
            if (d1 !== d2) return d2 - d1
            if (a.seeders !== b.seeders) return b.seeders - a.seeders
            return b.size - a.size
        })
    }

    private compareTorrents(a: Torrent, b: Torrent): number {
        if (a.seeders !== b.seeders) return b.seeders - a.seeders
        return b.size - a.size
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private getMediaMinDate(media: Media): number {
        if (!media.startDate || !media.startDate.year) return 0
        const startDate = new Date(media.startDate.year, (media.startDate.month || 1) - 1, media.startDate.day || 1)
        startDate.setMonth(startDate.getMonth() - 3)
        return startDate.getTime()
    }

    private torrentAfterDate(torrent: AnimeTorrent, minDate: number): boolean {
        if (minDate <= 0) return true
        if (!torrent.date) return true
        const torrentTime = new Date(torrent.date).getTime()
        if (isNaN(torrentTime)) return true
        return torrentTime >= minDate
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private getExpectedSeason(media: Media): number {
        const titles = [
            media.romajiTitle || "",
            media.englishTitle || "",
            ...(media.synonyms || []),
        ].filter(Boolean)

        for (const t of titles) {
            const s = this.extractSeasonNumber(t)
            if (s > 0 && s <= 12) return s
        }
        return 0
    }

    private getExpectedPart(media: Media): number {
        const titles = [
            media.romajiTitle || "",
            media.englishTitle || "",
            ...(media.synonyms || []),
        ].filter(Boolean)

        for (const t of titles) {
            const p = this.extractPartNumber(t)
            if (p > 0 && p <= 4) return p
        }
        return 0
    }

    private getTorrentSeason(t: Torrent): number {
        const meta = t.metadata
        if (meta.season_number && meta.season_number.length > 0) {
            const s = parseInt(meta.season_number[0], 10)
            if (s > 0 && s <= 12) return s
        }
        return this.extractSeasonNumber(t.name)
    }

    private getTorrentPart(t: Torrent): number {
        const meta = t.metadata
        if (meta.part_number && meta.part_number.length > 0) {
            if (meta.part_number.length > 1) return -1 // multi-part (e.g. "Part 1 & 2")
            const p = parseInt(meta.part_number[0], 10)
            if (p > 0 && p <= 4) return p
        }
        return this.extractPartNumber(t.name)
    }

    // Season extraction with EXPLICIT markers only.
    // Never matches bare trailing numbers — titles like "86", "91 Days" or
    // "3-gatsu no Lion" must not be read as seasons.
    private extractSeasonNumber(title: string): number {
        if (!title) return 0

        let m = title.match(/\bS(\d{1,2})\s*(?:E|$)/i)
        if (m) return parseInt(m[1], 10)

        m = title.match(/\bSeason\s+(\d{1,2})\b/i)
        if (m) return parseInt(m[1], 10)

        m = title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i)
        if (m) return parseInt(m[1], 10)

        m = title.match(/\b(Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s+Season\b/i)
        if (m) {
            const words: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 }
            return words[m[1].toLowerCase()] || 0
        }

        m = title.match(/\bSeason\s+(II|III|IV|V|VI|VII|VIII)\b/i)
        if (m) return this.romanToInt(m[1])

        m = title.match(/(\d{1,2})\s*期/)
        if (m) return parseInt(m[1], 10) // Japanese: 2期

        return 0
    }

    private extractPartNumber(title: string): number {
        if (!title) return 0

        let m = title.match(/\bPart\s+(\d{1,2})\b/i)
        if (m) return parseInt(m[1], 10)

        m = title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Part\b/i)
        if (m) return parseInt(m[1], 10)

        m = title.match(/\bCour\s*(\d{1,2})\b/i)
        if (m) return parseInt(m[1], 10)

        m = title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Cour\b/i)
        if (m) return parseInt(m[1], 10)

        m = title.match(/\bPart\s+(II|III|IV)\b/i)
        if (m) return this.romanToInt(m[1])

        return 0
    }

    private romanToInt(roman: string): number {
        const values: Record<string, number> = { I: 1, V: 5, X: 10 }
        let total = 0
        for (let i = 0; i < roman.length; i++) {
            const cur = values[roman[i]] || 0
            const next = values[roman[i + 1]] || 0
            total += cur < next ? -cur : cur
        }
        return total
    }

    // weighted token matching against every known title (eng/romaji/jp/aliases).
    // when a queryTitle is provided (user typed a custom query) a match against
    // the query itself also counts.
    private torrentMatchesMedia(t: Torrent, media: Media, threshold: number, queryTitle: string = ""): boolean {
        const parsedTitle = this.cleanTorrentTitle(t.metadata.title || t.metadata.formatted_title || t.name)
        if (!parsedTitle) return false

        if (queryTitle) {
            const qRatio = $scannerUtils.compareTitles(parsedTitle, queryTitle)
            if (qRatio >= threshold || this.containsTitle(parsedTitle, queryTitle)) return true
        }

        const mediaTitles = [
            media.romajiTitle || "",
            media.englishTitle || "",
            ...(media.synonyms || []),
            ...this.getBaseFranchiseTitles(media),
        ].filter(Boolean)

        for (const mediaTitle of mediaTitles) {
            if (!mediaTitle) continue
            const ratio = $scannerUtils.compareTitles(parsedTitle, mediaTitle)
            if (ratio >= threshold) return true
            // franchise-level containment (e.g. "Sousou no Frieren" vs "Frieren")
            // only counts at relaxed thresholds (batch/custom-query mode)
            if (threshold <= 0.55 && this.containsTitle(parsedTitle, mediaTitle)) return true
        }

        return false
    }

    // strip parsing junk that would dilute token matches:
    // resolution tags, encodes, release metadata, batch markers
    private cleanTorrentTitle(raw: string): string {
        return String(raw || "")
            .replace(/\b(2160|1440|1080|720|540|480|360)\s?[pP]\b/g, " ")
            .replace(/\b(4K|HDTV|HDR|SDR|10bit|8bit|HEVC|x265|x264|AVC|AAC|FLAC)\b/gi, " ")
            .replace(/\b(Batch|Complete Series|Complete Collection)\b/gi, " ")
            .replace(/\[[^\]]*\]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    // normalized substring containment — same franchise, shortened or
    // subtitle-prefixed torrent titles ("Frieren: Beyond Journey's End" names)
    private containsTitle(parsed: string, mediaTitle: string): boolean {
        const a = $scannerUtils.buildSearchQuery(parsed)
        const b = $scannerUtils.buildSearchQuery(mediaTitle)
        if (!a || !b) return false
        if (a.length < 5 || b.length < 5) return false
        return a.includes(b) || b.includes(a)
    }

    // franchise base titles so shortened torrent names still match:
    // "Attack on Titan Final Season" -> "Attack on Titan"
    // "That Time I Got Reincarnated as a Slime Season 3" -> base title
    private getBaseFranchiseTitles(media: Media): string[] {
        const rawTitles = [
            media.romajiTitle || "",
            media.englishTitle || "",
        ].filter(Boolean)

        const seen = new Set<string>()
        const bases: string[] = []

        const addBase = (t: string) => {
            const q = $scannerUtils.buildSearchQuery(t)
            if (q && q.length >= 3 && !seen.has(q)) {
                seen.add(q)
                bases.push(q)
            }
        }

        for (const raw of rawTitles) {
            const colonIdx = raw.indexOf(":")
            if (colonIdx > 4) addBase(raw.substring(0, colonIdx))

            const dashIdx = raw.indexOf(" - ")
            if (dashIdx > 4) addBase(raw.substring(0, dashIdx))

            const stripped = raw
                .replace(/\s+(?:The\s+)?Final(?:\s+Season)?$/i, "")
                .replace(/\s+Final$/i, "")
                .replace(/\s+Season\s+\d+$/i, "")
                .replace(/\s+\d+(?:st|nd|rd|th)\s+Season$/i, "")
                .replace(/\s+(?:Second|Third|Fourth|Fifth)\s+Season$/i, "")
                .replace(/\s+S\d+(?:\s|$).*$/i, "")
                .replace(/\s+Part\s+\d+$/i, "")
                .replace(/\s+\d+\s*期$/, "")
                .replace(/\s+(?:II|III|IV|V|VI)$/i, "")
            if (stripped !== raw && stripped.length >= 4) {
                addBase(stripped)
            }
        }

        return bases
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // detect batch releases via keywords/patterns
    private isTorrentLikelyBatch(name: string): boolean {
        if (this.torrentContainsBatchKeywords(name)) return true

        // episode range patterns: "01-12", "01 - 12", "01~12"
        let m = name.match(/(?:^|[\s\[\(])0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})(?:[\s\]\)]|$)/)
        if (m) {
            const start = parseInt(m[1], 10), end = parseInt(m[2], 10)
            if (end > start && start >= 1 && end <= 300) return true
        }

        // "E01-E12", "E01~E12"
        if (/\be\d{1,3}\s*[-~]\s*e?\d{1,3}\b/i.test(name)) return true

        // "Vol. 1-3"
        if (/\bvol\.?\s*\d+\s*[-~]\s*\d+/i.test(name)) return true

        // "Season 1-3", "S01-S03", "S1+S2+S3"
        if (/\bseasons?\s*\d+\s*[-~]\s*\d+/i.test(name)) return true
        if (/\bS\d{1,2}\s*[-~+]\s*S?\d{1,2}\b/i.test(name)) return true

        return false
    }

    private torrentContainsBatchKeywords(name: string): boolean {
        return /\b(?:Batch)\b/i.test(name) || this.torrentContainsCompleteKeywords(name)
    }

    private torrentContainsCompleteKeywords(name: string): boolean {
        return /\bcomplete\s+(?:series|collection)\b/i.test(name)
    }

    // extract the season range from multi-season packs, e.g. "S01-S03" or "Complete Series"
    private getMultiSeasonRange(name: string): [number, number] | null {
        let m = name.match(/\bseasons?\s*(\d+)\s*[-~]\s*(\d+)/i)
        if (m) {
            const s = parseInt(m[1], 10), e = parseInt(m[2], 10)
            if (e > s && s >= 1) return [s, e]
        }

        m = name.match(/\bS(\d{1,2})\s*[-~]\s*S?(\d{1,2})\b/i)
        if (m) {
            const s = parseInt(m[1], 10), e = parseInt(m[2], 10)
            if (e > s && s >= 1) return [s, e]
        }

        if (/\bcomplete\s+series\b/i.test(name)) return [1, 99]

        return null
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // exact-phrase OR group of the media's titles. `suffix` (episode/res/batch
    // terms) is ANDed onto EVERY variant — nyaa's "|" binds looser than
    // adjacency, so appending after the group would only qualify the last one
    private buildExactTitleGroup(media: Media, suffix: string = ""): string {
        let titles = [
            media.romajiTitle || "",
            media.englishTitle || "",
            ...(media.synonyms || []),
        ].filter(Boolean)

        const season = this.getExpectedSeason(media)

        titles = titles.map(t => {
            let clean = t.replace(/:/g, " ").replace(/-/g, " ").trim()
            clean = clean.replace(/×/g, " x ").replace(/＊/g, " * ")
            clean = clean.replace(/[()[\]{}|"'~?\\^!]/g, "")
            clean = clean.replace(/\s+/g, " ")
            clean = clean.toLowerCase()
            if (season !== 0) {
                clean = clean.replace(/\biii\b/gi, "").replace(/\bii\b/gi, "")
            }
            return clean.trim()
        }).filter(Boolean)

        titles = [...new Set(titles)].slice(0, 3)
        if (titles.length === 0) return ""

        return "(" + titles.map(t => '"' + t + '"' + suffix).join("|") + ")"
    }

    // episode number OR group: "05", "E05", "EP05", "EP5", "S02E05"
    private buildEpisodeGroup(ep: number, season?: number, isAbsolute: boolean = false): string {
        const padded = this.zeropad(ep)
        let terms = [padded, "E" + padded, "EP" + padded, "EP" + ep]

        if (!isAbsolute) {
            const actualSeason = season && season > 0 ? season : 1
            terms.push("S" + this.zeropad(actualSeason) + "E" + padded)
        }

        terms = [...new Set(terms)]
        return "(" + terms.join("|") + ")"
    }

    private buildBatchTerms(media: Media): string {
        const epCount = this.zeropad(media.episodeCount || 0)
        const parts = [
            '"Batch"',
            '"Complete"',
            '"Complete Series"',
            '"Complete Collection"',
            '"01 - ' + epCount + '"',
            '"01-' + epCount + '"',
            '"E01-E' + epCount + '"',
        ]
        return " (" + parts.join("|") + ")"
    }

    private zeropad(v: number): string {
        const s = String(v)
        return s.length < 2 ? "0" + s : s
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private buildMagnet(infoHash: string, name: string): string {
        let magnet = "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodeURIComponent(name)
        for (const tr of TRACKERS) {
            magnet += "&tr=" + encodeURIComponent(tr)
        }
        return magnet
    }

    private parseRSSFeed(rssText: string): RawTorrent[] {
        const torrents: RawTorrent[] = []

        const getTagContent = (xml: string, tag: string): string => {
            const regex = new RegExp("<" + tag + "[^>]*>([^<]*)</" + tag + ">")
            const match = xml.match(regex)
            return match ? match[1].trim() : ""
        }

        const getNyaaTagContent = (xml: string, tag: string): string => {
            const regex = new RegExp("<nyaa:" + tag + "[^>]*>([^<]*)</nyaa:" + tag + ">")
            const match = xml.match(regex)
            return match ? match[1].trim() : ""
        }

        const itemRegex = /<item>([\s\S]*?)<\/item>/g
        let match

        while ((match = itemRegex.exec(rssText)) !== null) {
            const itemXml = match[1]
            const name = getTagContent(itemXml, "title")
            if (!name) continue

            const metadata = $habari.parse(name)
            torrents.push({
                name: name,
                link: getTagContent(itemXml, "guid"),
                downloadUrl: getTagContent(itemXml, "link"),
                date: getTagContent(itemXml, "pubDate"),
                seeders: getNyaaTagContent(itemXml, "seeders"),
                leechers: getNyaaTagContent(itemXml, "leechers"),
                downloads: getNyaaTagContent(itemXml, "downloads"),
                infoHash: getNyaaTagContent(itemXml, "infoHash"),
                size: getNyaaTagContent(itemXml, "size"),
                metadata: metadata,
            })
        }

        return torrents
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private toAnimeTorrent(t: RawTorrent): Torrent {
        const seeders = parseInt(t.seeders, 10) || 0
        const leechers = parseInt(t.leechers, 10) || 0
        const downloads = parseInt(t.downloads, 10) || 0

        let formattedDate = ""
        try {
            const parsedDate = new Date(t.date)
            if (!isNaN(parsedDate.getTime())) {
                formattedDate = parsedDate.toISOString()
            }
        } catch (e) { }

        let sizeInBytes = 0
        const sizeMatch = t.size.match(/([\d.]+)\s*([KMGT]?i?B)/i)
        if (sizeMatch) {
            const sz = parseFloat(sizeMatch[1])
            const unit = sizeMatch[2].toUpperCase()
            if (unit.endsWith("IB")) {
                if (unit.startsWith("M")) sizeInBytes = sz * Math.pow(1024, 2)
                else if (unit.startsWith("G")) sizeInBytes = sz * Math.pow(1024, 3)
                else if (unit.startsWith("T")) sizeInBytes = sz * Math.pow(1024, 4)
                else sizeInBytes = sz * 1024
            } else {
                if (unit.startsWith("M")) sizeInBytes = sz * Math.pow(1000, 2)
                else if (unit.startsWith("G")) sizeInBytes = sz * Math.pow(1000, 3)
                else if (unit.startsWith("T")) sizeInBytes = sz * Math.pow(1000, 4)
                else sizeInBytes = sz * 1000
            }
        }

        let episode = -1
        let isBatch = false
        const epNumbers = t.metadata.episode_number

        if (epNumbers && epNumbers.length > 0) {
            if (epNumbers.length > 1) {
                // multi-episode range -> batch
                const first = parseInt(epNumbers[0], 10) || 0
                const last = parseInt(epNumbers[epNumbers.length - 1], 10) || 0
                isBatch = last > first
                episode = -1
            } else {
                episode = parseInt(epNumbers[0], 10) || -1
            }
        }

        if (episode < 0 && !isBatch) {
            episode = this.extractEpisodeFallback(t.name)
            if (episode > 0) {
                // if the name also carries an explicit range marker, it's a batch
                if (this.isTorrentLikelyBatch(t.name) && /[-~]\s*0*\d{1,3}/.test(t.name)) {
                    isBatch = true
                    episode = -1
                }
            }
        }

        if (!isBatch && episode < 0) {
            isBatch = this.isTorrentLikelyBatch(t.name)
        }

        return {
            name: t.name,
            date: formattedDate,
            size: Math.round(sizeInBytes),
            formattedSize: t.size,
            seeders: seeders,
            leechers: leechers,
            downloadCount: downloads,
            link: t.link,
            downloadUrl: t.downloadUrl,
            infoHash: t.infoHash,
            magnetLink: "",
            resolution: t.metadata.video_resolution || this.extractResolutionFallback(t.name),
            isBatch: isBatch,
            episodeNumber: episode,
            releaseGroup: t.metadata.release_group || "",
            isBestRelease: false,
            confirmed: false,
            metadata: t.metadata,
        }
    }

    // resolution fallback when habari misses: "(1080p)", "[720p]", "1080p"
    private extractResolutionFallback(name: string): string {
        const m = name.match(/\b(2160|1440|1080|720|540|480|360)\s?[pP]\b/)
        return m ? m[1] : ""
    }

    // episode extraction fallback when habari misses.
    // Explicit markers only — never a bare number at the start of the name
    // (protects numeric titles like "86").
    private extractEpisodeFallback(name: string): number {
        let m = name.match(/[Ee][Pp]?\.?\s*(\d{1,3})(?:v\d+)?\b/i)
        if (m) {
            const ep = parseInt(m[1], 10)
            if (ep >= 1 && ep <= 1000) return ep
        }

        // " - 05", "- 05v2", "[05]", "[05 END]", "(05)" — number must sit
        // between separators, never at string start
        m = name.match(/[\-–—\[\]\(]\s*(\d{1,3})(?:v\d+)?(?:END)?\s*(?:[\-–—\[\]\)]|\s)/i)
        if (m) {
            const ep = parseInt(m[1], 10)
            if (ep >= 1 && ep <= 1000) return ep
        }

        return -1
    }
}
