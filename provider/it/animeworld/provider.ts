/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
    base = "https://www.animeworld.ac"
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    _headers(referer: string) {
        return { "User-Agent": this.UA, Referer: referer }
    }

    _url(path: string) {
        return this.base + path
    }

    _sourceType(_url: string) {
        return "mp4"
    }

    async _tryPlayer(episodeId: string, server: string, referer: string) {
        let url = this._url("/api/episode/serverPlayer" + server + "?id=" + episodeId)
        console.log("[AnimeWorld] _tryPlayer server:", server, "url:", url)
        let res = await fetch(url, { headers: this._headers(referer) })
        console.log("[AnimeWorld] _tryPlayer status:", res.status, "for server:", server)
        if (!res.ok) return ""
        let text = await res.text()
        console.log("[AnimeWorld] _tryPlayer response length:", text.length, "has source:", text.indexOf("<source"))
        if (text.indexOf("<source") !== -1 || text.indexOf("https://") !== -1) return url
        console.log("[AnimeWorld] _tryPlayer server", server, "failed - no source/url in response")
        return ""
    }

    getSettings(): Settings {
        return { episodeServers: ["AnimeWorld"], supportsDub: false }
    }

    async _parseSearchPage(html: string, keywords: string[]): Promise<SearchResult[]> {
        let results: SearchResult[] = []
        let parts = html.split('<div class="item">')
        console.log("[AnimeWorld] search found", parts.length - 1, "item blocks")

        // Sort keywords by length descending, keep top half (most specific/longest words)
        let strongKw: string[] = []
        if (keywords.length > 0) {
            let sorted = keywords.sort(function(a, b) { return b.length - a.length })
            strongKw = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 2)))
            console.log("[AnimeWorld] strong keywords:", JSON.stringify(strongKw))
        }

        for (let i = 1; i < parts.length; i++) {
            let linkM = parts[i].match(/href="\/play\/([^"]+)"/)
            let titleM = parts[i].match(/class="name"[^>]*>([^<]+)</)
            let jtitleM = parts[i].match(/data-jtitle="([^"]+)"/)
            if (linkM && titleM) {
                let title = titleM[1]
                let jtitle = jtitleM ? jtitleM[1].toLowerCase() : ""
                if (strongKw.length === 0) {
                    results.push({ id: linkM[1], title: title, url: this._url("/play/" + linkM[1]), subOrDub: "sub" })
                } else {
                    let titleLower = title.toLowerCase()
                    let matches = strongKw.some(function(k) { return titleLower.indexOf(k) !== -1 || jtitle.indexOf(k) !== -1 })
                    if (matches) {
                        results.push({ id: linkM[1], title: title, url: this._url("/play/" + linkM[1]), subOrDub: "sub" })
                    } else {
                        console.log("[AnimeWorld] filtered out:", title)
                    }
                }
            } else {
                console.log("[AnimeWorld] search item", i, "failed to parse - link:", !!linkM, "title:", !!titleM)
            }
        }
        return results
    }

    _normalizeQuery(query: string): string {
        let q = query
        // Strip season descriptors: "4th Season", "2nd Season", "Season 4", etc.
        q = q.replace(/\d+(?:st|nd|rd|th)\s+Season/gi, "")
        q = q.replace(/Season\s+\d+/gi, "")
        // Strip course/part: "Part 2", "Course 3"
        q = q.replace(/(?:Part|Course)\s+\d+/gi, "")
        // Strip English year/semester: "Second Year", "First Semester"
        q = q.replace(/(?:First|Second|Third|Fourth|Fifth)\s+(?:Year|Semester|Course|Part|Season)/gi, "")
        // Strip Japanese: "2-nensei-hen", "Ichi Gakki", "Ni Gakki"
        q = q.replace(/\d+-nensei-hen/gi, "")
        q = q.replace(/(?:Ichi|Ni|San|Yon|Go)\s+Gakki/gi, "")
        // Strip standalone version numbers at the end: "4", "2", etc. when they're just a trailing number
        q = q.replace(/\b\d+\s*$/, "")
        // Clean up extra whitespace
        q = q.replace(/\s+/g, " ").trim()
        return q
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!opts.query.trim()) return []
        console.log("[AnimeWorld] search query:", opts.query)

        let keywords = opts.query.toLowerCase().split(/[\s,.-]+/).filter(function(w) { return w.length > 2 })

        // Try normalized query first (strips season/volume suffixes from AniList titles)
        let normalized = this._normalizeQuery(opts.query)
        let searchQuery = normalized.length > 0 ? normalized : opts.query
        console.log("[AnimeWorld] normalized search query:", searchQuery)

        let res = await fetch(this._url("/search?keyword=" + encodeURIComponent(searchQuery)), { headers: this._headers(this.base) })
        console.log("[AnimeWorld] search status:", res.status)
        let results: SearchResult[] = []
        if (res.ok) {
            let html = await res.text()
            results = await this._parseSearchPage(html, keywords)
        }

        // If 0 results and query was normalized, try original query
        if (results.length === 0 && normalized !== opts.query) {
            console.log("[AnimeWorld] no results with normalized query, trying original")
            let origRes = await fetch(this._url("/search?keyword=" + encodeURIComponent(opts.query)), { headers: this._headers(this.base) })
            if (origRes.ok) {
                let origHtml = await origRes.text()
                results = await this._parseSearchPage(origHtml, keywords)
            }
        }

        // Progressive shortening: AnimeWorld's search fails on multi-word phrases.
        // Try the longest keyword as a standalone search.
        if (results.length === 0) {
            let longest = keywords.sort(function(a, b) { return b.length - a.length })[0]
            if (longest && longest.length > 3) {
                console.log("[AnimeWorld] fallback short search:", longest)
                let shortRes = await fetch(this._url("/search?keyword=" + encodeURIComponent(longest)), { headers: this._headers(this.base) })
                if (shortRes.ok) {
                    let shortHtml = await shortRes.text()
                    results = await this._parseSearchPage(shortHtml, keywords)
                }
            }
        }

        // If still no results, try Latin-only fallback
        if (results.length === 0) {
            let latinWords = opts.query.match(/[a-zA-Z]+/g)
            if (latinWords && latinWords.length > 0) {
                let latinQuery = latinWords.join(" ")
                console.log("[AnimeWorld] fallback latin search:", latinQuery)
                let latinRes = await fetch(this._url("/search?keyword=" + encodeURIComponent(latinQuery)), { headers: this._headers(this.base) })
                if (latinRes.ok) {
                    let latinHtml = await latinRes.text()
                    let latinKeywords = latinQuery.toLowerCase().split(" ").filter(function(w) { return w.length > 2 })
                    results = await this._parseSearchPage(latinHtml, latinKeywords)
                }
            }
        }

        console.log("[AnimeWorld] search total results:", results.length)
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        // Manual match: if id is a full URL, extract the slug
        if (id.indexOf("http") === 0) {
            let m = id.match(/\/play\/([^\/?#]+)/)
            if (m) id = m[1]
            console.log("[AnimeWorld] manual match, extracted slug:", id)
        }
        console.log("[AnimeWorld] findEpisodes id:", id)
        let res = await fetch(this._url("/play/" + id), { headers: this._headers(this.base) })
        console.log("[AnimeWorld] episode page status:", res.status)
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        let html = await res.text()
        console.log("[AnimeWorld] episode page HTML length:", html.length)
        let episodes: EpisodeDetails[] = []
        let epRx = /<li\s+class="episode"[^>]*>[\s\S]*?<\/li>/g
        let m
        let matchCount = 0
        while ((m = epRx.exec(html)) !== null) {
            matchCount++
            let block = m[0]
            let idM = block.match(/data-id="([^"]+)"/)
            let numM = block.match(/data-episode-num="(\d+)"/)
            let hrefM = block.match(/href="([^"]+)"/)
            if (idM && numM) {
                let num = parseInt(numM[1], 10)
                if (!episodes.some(function (e) { return e.number === num })) {
                    episodes.push({
                        id: idM[1],
                        number: num,
                        url: hrefM ? this._url(hrefM[1]) : this._url("/play/" + id),
                        title: "Episode " + num,
                    })
                }
            } else {
                console.log("[AnimeWorld] episode block failed parse - idM:", !!idM, "numM:", !!numM)
            }
        }
        console.log("[AnimeWorld] found", matchCount, "episode blocks, parsed", episodes.length, "episodes")
        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort(function (a, b) { return a.number - b.number })
        console.log("[AnimeWorld] episodes sorted, first:", episodes[0].number, "last:", episodes[episodes.length - 1].number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("[AnimeWorld] findEpisodeServer episode:", episode.id, "number:", episode.number)
        let servers = ["AnimeWorld", "Shiva", ""]
        let playerUrl = ""
        for (let si = 0; si < servers.length; si++) {
            console.log("[AnimeWorld] trying server:", servers[si] || "(empty)")
            playerUrl = await this._tryPlayer(episode.id, servers[si], episode.url)
            if (playerUrl) {
                console.log("[AnimeWorld] player found on server:", servers[si] || "(empty)", "url:", playerUrl)
                break
            }
        }
        if (!playerUrl) {
            console.log("[AnimeWorld] no player URL found for episode:", episode.id)
            throw new Error("No player URL found")
        }

        console.log("[AnimeWorld] fetching player page:", playerUrl)
        let plRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
        console.log("[AnimeWorld] player page status:", plRes.status)
        if (!plRes.ok) {
            console.log("[AnimeWorld] player page failed, returning player URL as fallback")
            return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        let plHtml = await plRes.text()
        console.log("[AnimeWorld] player page HTML length:", plHtml.length)
        let sources: VideoSource[] = []
        let srcParts = plHtml.split("<source")
        console.log("[AnimeWorld] found", srcParts.length - 1, "<source> tags")
        for (let s = 1; s < srcParts.length; s++) {
            let sm = srcParts[s].match(/src="([^"]+)"/)
            if (sm && !sources.some(function (x) { return x.url === sm[1] })) {
                sources.push({ url: sm[1], quality: "auto", type: this._sourceType(sm[1]), subtitles: [] })
                console.log("[AnimeWorld] source", sources.length, ":", sm[1].substring(0, 80))
            }
        }

        if (sources.length === 0) {
            console.log("[AnimeWorld] no sources extracted, falling back to player URL")
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        console.log("[AnimeWorld] returning", sources.length, "sources")
        return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: sources }
    }
}
