/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

interface ProviderConfig {
    baseUrls: string[]
    category: string
    filter: string
    maxResults: number
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

const DEFAULT_API_URL = "https://sukebei.nyaa.si"
const DEFAULT_CATEGORY = "1_1"
const DEFAULT_FILTER = "0"
const DEFAULT_MAX_RESULTS = 60

const CACHE_TTL_MS = 3 * 60 * 1000
const CACHE_MAX_ENTRIES = 24

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://tracker.pomf.se:80/announce",
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
    supportsAdult = true

    private _cache = new Map<string, { time: number, torrents: RawTorrent[] }>()

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const raw = await this.fetchRSS("", "id")
            const torrents = raw.slice(0, this.getConfig().maxResults).map(t => this.toAnimeTorrent(t))
            return torrents
        } catch (error) {
            console.error("sukebei: getLatest error: " + (error as Error).message)
            return []
        }
    }

    async search(options: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const q = (options.query || "").trim()
            const queries = this.expandSearchQueries(q)
            const results: RawTorrent[] = []
            const seen = new Set<string>()

            for (const query of queries) {
                try {
                    const raw = await this.fetchRSS(query, "seeders")
                    for (const t of raw) {
                        const key = t.infoHash || t.downloadUrl || t.link
                        if (!seen.has(key)) {
                            seen.add(key)
                            results.push(t)
                        }
                    }
                } catch (e) {
                    console.error("sukebei: query failed (" + query + "): " + (e as Error).message)
                }
            }

            let torrents = results.map(t => this.toAnimeTorrent(t))
            torrents.sort(this.compareTorrents)
            return torrents
        } catch (error) {
            console.error("sukebei: search error: " + (error as Error).message)
            return []
        }
    }

    async smartSearch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const { media, query: userQuery, batch, episodeNumber, resolution, bestReleases } = options

            const allTitles = [
                media.romajiTitle || "",
                media.englishTitle || "",
                ...(media.synonyms || []),
            ].filter(Boolean)

            if (allTitles.length === 0) return []

            const processed = $scannerUtils.buildSmartSearchTitles(allTitles)
            const titles = processed.titles || []
            const season = processed.season > 0 && processed.season <= 12 ? processed.season : 0
            const part = processed.part > 0 && processed.part <= 4 ? processed.part : 0

            if (titles.length === 0) return []

            const isMovie = media.format === "MOVIE" && (media.episodeCount || 0) === 1
            const canBatch = media.status === "FINISHED" && (media.episodeCount || 0) > 1

            let queries: string[]
            if (userQuery) {
                queries = this.expandSearchQueries(userQuery)
            } else if (batch && canBatch && !isMovie) {
                queries = this.buildBatchQueries(titles, media, resolution)
            } else if (isMovie) {
                queries = this.buildMovieQueries(titles, resolution)
            } else {
                queries = this.buildEpisodeQueries(titles, season, part, episodeNumber, media, resolution)
            }

            const results: RawTorrent[] = []
            const seen = new Set<string>()

            for (const query of queries) {
                try {
                    const raw = await this.fetchRSS(query, "seeders")
                    for (const t of raw) {
                        const key = t.infoHash || t.downloadUrl || t.link
                        if (!seen.has(key)) {
                            seen.add(key)
                            results.push(t)
                        }
                    }
                } catch (e) {
                    console.error("sukebei: query failed (" + query + "): " + (e as Error).message)
                }
            }

            let torrents = results.map(t => this.toAnimeTorrent(t))

            if (options.bestReleases && torrents.length > 0) {
                this.markBestReleases(torrents)
                torrents = torrents.filter(t => t.isBestRelease)
            }

            if (resolution) {
                const r = resolution.replace(/p$/, "")
                torrents = torrents.filter(t => t.resolution === r + "p")
            }

            torrents.sort(this.compareTorrents)
            return torrents
        } catch (error) {
            console.error("sukebei: smartSearch error: " + (error as Error).message)
            return []
        }
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.infoHash) {
            return this.buildMagnet(torrent.infoHash, torrent.name)
        }
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
            console.error("sukebei: magnet fetch failed: " + (error as Error).message)
            throw new Error("Could not fetch magnet link for: " + torrent.name)
        }
    }

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query", "bestReleases"],
            supportsAdult: true,
            type: "main",
        }
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private getConfig(): ProviderConfig {
        let apiUrl = "{{apiUrl}}"
        if (!apiUrl || apiUrl.startsWith("{{")) apiUrl = DEFAULT_API_URL

        const baseUrls = apiUrl
            .split(",")
            .map(u => u.trim().replace(/\/+$/, ""))
            .filter(u => u.length > 0)
            .map(u => u.startsWith("http") ? u : "https://" + u)

        let category = "{{category}}"
        if (!category || category.startsWith("{{")) category = DEFAULT_CATEGORY

        let filter = "{{filter}}"
        if (!filter || filter.startsWith("{{")) filter = DEFAULT_FILTER

        let maxResults = parseInt("{{maxResults}}", 10)
        if (isNaN(maxResults) || maxResults <= 0) maxResults = DEFAULT_MAX_RESULTS
        if (maxResults > 150) maxResults = 150

        return {
            baseUrls: baseUrls.length > 0 ? baseUrls : [DEFAULT_API_URL],
            category: category,
            filter: filter,
            maxResults: maxResults,
        }
    }

    private buildURLFor(base: string, query: string, sortBy: string = "seeders", limit: number = 0): string {
        const cfg = this.getConfig()
        let qs = "page=rss&q=" + encodeURIComponent(query) + "&c=" + cfg.category + "&f=" + cfg.filter + "&s=" + sortBy + "&o=desc"
        if (limit > 0) qs += "&limit=" + limit
        return base + "/?" + qs
    }

    private async fetchRSS(query: string, sortBy: string = "seeders", limit: number = 0): Promise<RawTorrent[]> {
        const cfg = this.getConfig()
        const base = cfg.baseUrls[0]
        const cachedUrl = this.buildURLFor(base, query, sortBy, limit)
        const hit = this._cache.get(cachedUrl)
        if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.torrents

        try {
            const res = await fetch(cachedUrl, { timeout: 10 })
            if (!res.ok) throw new Error("HTTP " + res.status)
            const torrents = this.parseRSSFeed(res.text())
            this._cache.set(cachedUrl, { time: Date.now(), torrents })
            if (this._cache.size > CACHE_MAX_ENTRIES) {
                const oldest = this._cache.keys().next().value
                if (oldest) this._cache.delete(oldest)
            }
            return torrents
        } catch (e) {
            console.error("sukebei: fetchRSS failed for '" + query + "': " + (e as Error).message)
            throw e
        }
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

    private toAnimeTorrent(t: RawTorrent): AnimeTorrent {
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
            if (episode > 0 && this.isTorrentLikelyBatch(t.name) && /[-~]\s*0*\d{1,3}/.test(t.name)) {
                isBatch = true
                episode = -1
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

    private extractResolutionFallback(name: string): string {
        const m = name.match(/\b(2160|1440|1080|720|540|480|360)\s?[pP]\b/)
        if (m) return m[1]
        const resMatch = name.match(/(\d{3,4})p/i)
        if (resMatch) return resMatch[1]
        return ""
    }

    private extractEpisodeFallback(name: string): number {
        let m = name.match(/[Ee][Pp]?\.?\s*(\d{1,3})(?:v\d+)?\b/i)
        if (m) {
            const ep = parseInt(m[1], 10)
            if (ep >= 1 && ep <= 1000) return ep
        }
        m = name.match(/[\-–—\[\]\(]\s*(\d{1,3})(?:v\d+)?(?:END)?\s*(?:[\-–—\[\]\)]|\s)/i)
        if (m) {
            const ep = parseInt(m[1], 10)
            if (ep >= 1 && ep <= 1000) return ep
        }
        m = name.match(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})/i)
        if (m) {
            const start = parseInt(m[1], 10), end = parseInt(m[2], 10)
            if (end > start && start >= 1 && end <= 300) return -2
        }
        m = name.match(/\bPart\s*(\d{1,3})/i)
        if (m) {
            const ep = parseInt(m[1], 10)
            if (ep >= 1 && ep <= 1000) return ep
        }
        m = name.match(/S(\d{1,2})E(\d{1,2})/i)
        if (m) {
            const ep = parseInt(m[2], 10)
            if (ep >= 1 && ep <= 1000) return ep
        }
        m = name.match(/(\d{1,3})(?:st|nd|rd|th)\s*(?:EP|EP\.?)/i)
        if (m) {
            const ep = parseInt(m[1], 10)
            if (ep >= 1 && ep <= 1000) return ep
        }
        return -1
    }

    private isTorrentLikelyBatch(name: string): boolean {
        if (/\b(?:Batch)\b/i.test(name)) return true
        if (/\bcomplete\s+(?:series|collection)\b/i.test(name)) return true
        if (/\bcomplete\b/i.test(name)) return true

        let m = name.match(/(?:^|[\s\[\(])0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})(?:[\s\]\)]|$)/)
        if (m) {
            const start = parseInt(m[1], 10), end = parseInt(m[2], 10)
            if (end > start && start >= 1 && end <= 300) return true
        }

        if (/\be\d{1,3}\s*[-~]\s*e?\d{1,3}\b/i.test(name)) return true
        if (/\bVol\.?\s*\d+\s*[-~]\s*\d+/i.test(name)) return true
        if (/\bseasons?\s+\d+\s*[-~]\s*\d+/i.test(name)) return true
        if (/\bS\d{1,2}\s*[-~+]\s*S?\d{1,2}\b/i.test(name)) return true
        if (/\bParts?\s+\d+\s*[-~]\s*\d+/i.test(name)) return true

        return false
    }

    private stripTheAnimationSuffix(title: string): string {
        return title.replace(/(?:\s|_|\.)The\s+Animation(?:ion)?\s*$/i, "").trim()
    }

    private simplifyQuery(query: string): string {
        let q = query
            .replace(/[,;]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        return this.stripTheAnimationSuffix(q)
    }

    private expandSearchQueries(query: string): string[] {
        const simplified = this.simplifyQuery(query)
        const queries: string[] = [query, simplified]

        if (simplified !== query) {
            queries.push(simplified)
        }

        const withoutParticle = simplified.replace(/\s+(?:o|no|na|ni|too|te)\s+/gi, " ").trim()
        if (withoutParticle !== simplified && withoutParticle.length > 0) {
            queries.push(withoutParticle)
        }

        const shortForm = simplified.split(/\s+/).slice(0, 4).join(" ")
        if (shortForm.length > 5 && shortForm !== simplified) {
            queries.push(shortForm)
        }

        return queries
    }

    private markBestReleases(torrents: AnimeTorrent[]): void {
        const groups = new Map<string, AnimeTorrent[]>()

        for (const t of torrents) {
            const key = t.isBatch ? "batch" : "ep" + (t.episodeNumber ?? -1)
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key)!.push(t)
        }

        const score = (t: AnimeTorrent): number => {
            const r = parseInt(t.resolution || "", 10) || 0
            let s = r
            if (t.name.toLowerCase().includes("dual") || t.name.toLowerCase().includes("dub")) s += 500
            if (/\bhevc\b|\bx265\b|\b10bit\b/i.test(t.name)) s += 10
            return s
        }

        for (const [, group] of groups) {
            let bestScore = -1
            for (const t of group) {
                const s = score(t)
                if (s > bestScore) bestScore = s
            }
            for (const t of group) {
                t.isBestRelease = bestScore > 0 && score(t) === bestScore
            }
        }
    }

    private compareTorrents(a: AnimeTorrent, b: AnimeTorrent): number {
        if (a.seeders !== b.seeders) return b.seeders - a.seeders
        return b.size - a.size
    }

    private buildMagnet(infoHash: string, name: string): string {
        let magnet = "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodeURIComponent(name)
        for (const tr of TRACKERS) {
            magnet += "&tr=" + encodeURIComponent(tr)
        }
        return magnet
    }

    private buildBatchQueries(titles: string[], media: Media, resolution: string): string[] {
        const queries: string[] = []
        const resStr = resolution ? " " + resolution : " (360|480|720|1080)"
        const primary = titles[0]
        const secondary = titles.length > 1 ? titles[1] : ""
        const batchTerms = " (Batch|Complete|Complete Series|Complete Collection|Seasons|Parts)"
        const discTerms = " (BD|Blu-ray|BDRip|Remux|HEVC|x265|10bit|Dual-Audio|Dual Audio)"

        queries.push(primary + resStr)
        queries.push(primary + batchTerms + resStr.trim())
        queries.push(primary + discTerms + resStr)

        if (secondary) {
            queries.push(secondary + batchTerms + resStr)
            queries.push(secondary + resStr)
        }

        return queries
    }

    private buildMovieQueries(titles: string[], resolution: string): string[] {
        const queries: string[] = []
        const resStr = resolution ? " " + resolution : " (360|480|720|1080)"
        const primary = titles[0]
        const secondary = titles.length > 1 ? titles[1] : ""

        queries.push(primary + resStr)
        queries.push(primary + " (BD|Blu-ray|BDRip|HEVC|WEB-DL)" + resStr)

        if (secondary) {
            queries.push(secondary + resStr)
        }

        return queries
    }

    private buildEpisodeQueries(titles: string[], season: number, part: number, episodeNumber: number, media: Media, resolution: string): string[] {
        const queries: string[] = []
        const resStr = resolution ? " " + resolution : " (360|480|720|1080)"
        const primary = titles[0]
        const secondary = titles.length > 1 ? titles[1] : ""

        const epGroup = this.buildEpisodeGroup(episodeNumber, season)

        queries.push(primary + " " + epGroup + resStr.trim())
        queries.push(primary + resStr)

        if (season > 1) {
            queries.push(primary + " S" + String(season).padStart(2, "0") + " " + epGroup + resStr.trim())
        }

        if (part > 1) {
            queries.push(primary + " Part " + part + " " + epGroup + resStr.trim())
        }

        if (secondary) {
            queries.push(secondary + " " + epGroup + resStr.trim())
            queries.push(secondary + resStr)
        }

        const simplifiedPrimary = this.simplifyQuery(primary)
        if (simplifiedPrimary !== primary) {
            queries.push(simplifiedPrimary + " " + epGroup + resStr.trim())
            queries.push(simplifiedPrimary + resStr)
        }

        const withoutThe = this.stripTheAnimationSuffix(primary)
        if (withoutThe !== primary && withoutThe.length > 0) {
            queries.push(withoutThe + " " + epGroup + resStr.trim())
            queries.push(withoutThe + resStr)
        }

        const shortPrimary = primary.split(/\s+/).slice(0, 4).join(" ")
        if (shortPrimary.length > 5 && shortPrimary !== primary) {
            queries.push(shortPrimary + " " + epGroup + resStr.trim())
            queries.push(shortPrimary + resStr)
        }

        return queries
    }

    private buildEpisodeGroup(ep: number, season?: number): string {
        const padded = String(ep).padStart(2, "0")
        let terms = [padded, "E" + padded, "EP" + padded, "EP" + ep, padded + "v", "E" + padded + "v"]

        if (season && season > 0) {
            const actualSeason = season > 0 ? season : 1
            terms.push("S" + String(actualSeason).padStart(2, "0") + "E" + padded)
        }

        return "(" + terms.join("|") + ")"
    }
}