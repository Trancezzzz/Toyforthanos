/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
    base = "https://hianime.ms"
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    _headers(referer: string) {
        return { "User-Agent": this.UA, Referer: referer }
    }

    _url(path: string) {
        return this.base + path
    }

    _b64decode(s: string): string {
        let r = s.replace(/-/g, "+").replace(/_/g, "/")
        try { return atob(r) } catch (e) { return "" }
    }

    _parseVersion(server: string): string {
        return server.toLowerCase().indexOf("dub") !== -1 ? "dub" : "sub"
    }

    _parseServerName(server: string): string {
        return server.split(" ")[0].toLowerCase()
    }

    _extractSlug(id: string): { name: string, animeId: string } {
        let lastDash = id.lastIndexOf("-")
        if (lastDash === -1) return { name: "", animeId: id }
        return { name: id.substring(0, lastDash), animeId: id.substring(lastDash + 1) }
    }

    _buildRyuUrl(token: string, version: string): string {
        if (!token) return ""
        let decoded = this._b64decode(token)
        let epId = decoded.split(":")[0]
        if (!epId) return ""
        return "https://megaplay.buzz/stream/s-2/" + epId + "/" + version
    }

    _buildDirectUrl(baseUrl: string, anilistId: string, epNum: number, version: string): string {
        return baseUrl + anilistId + "/" + epNum + "/" + version
    }

    async _scrapeWatchPage(episodeUrl: string): Promise<{ anilistId: string, malId: string }> {
        console.log("[HiAnime] scraping watch page:", episodeUrl)
        let res = await fetch(episodeUrl, { headers: this._headers(this.base) })
        if (!res.ok) {
            console.log("[HiAnime] watch page fetch failed:", res.status)
            return { anilistId: "", malId: "" }
        }
        let html = await res.text()
        let aniM = html.match(/var anilistId\s*=\s*(\d+)/)
        let malM = html.match(/var malId\s*=\s*(\d+)/)
        console.log("[HiAnime] anilistId:", aniM ? aniM[1] : "not found", "malId:", malM ? malM[1] : "not found")
        return {
            anilistId: aniM ? aniM[1] : "",
            malId: malM ? malM[1] : "",
        }
    }

    getSettings(): Settings {
        return {
            episodeServers: [
                "Ryu Sub", "Ryu Dub",
                "Volt Sub", "Volt Dub",
                "Warp Sub", "Warp Dub",
                "Ayame Sub", "Ayame Dub",
            ],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!opts.query.trim()) return []
        console.log("[HiAnime] search:", opts.query)
        let res = await fetch(this._url("/search?q=" + encodeURIComponent(opts.query)), { headers: this._headers(this.base) })
        if (!res.ok) {
            console.log("[HiAnime] search failed:", res.status)
            return []
        }
        let html = await res.text()
        let results: SearchResult[] = []
        let parts = html.split('<div class="flw-item">')
        console.log("[HiAnime] search found", parts.length - 1, "items")

        for (let i = 1; i < parts.length; i++) {
            let linkM = parts[i].match(/href="https:\/\/hianime\.ms\/details\/([^"]+)"/)
            let titleM = parts[i].match(/class="dynamic-name"[^>]*>([^<]+)</)
            let hasSub = parts[i].indexOf("tick-sub") !== -1
            let hasDub = parts[i].indexOf("tick-dub") !== -1
            if (linkM && titleM) {
                results.push({
                    id: linkM[1],
                    title: titleM[1].trim(),
                    url: this._url("/details/" + linkM[1]),
                    subOrDub: hasSub ? "sub" : (hasDub ? "dub" : "sub"),
                })
            }
        }
        console.log("[HiAnime] search returned", results.length, "results")
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let { name, animeId } = this._extractSlug(id)
        if (!name) throw new Error("Invalid slug: " + id)
        console.log("[HiAnime] findEpisodes slug:", id, "name:", name, "animeId:", animeId)

        let ep1Url = this._url("/watch-" + name + "-episode-1-" + animeId)
        console.log("[HiAnime] fetching episode 1 page:", ep1Url)
        let res = await fetch(ep1Url, { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        let html = await res.text()

        let episodes: EpisodeDetails[] = []
        let epRx = /<a\s+class="ws-ep[^"]*"[^>]*>[\s\S]*?<\/a>/g
        let m
        while ((m = epRx.exec(html)) !== null) {
            let block = m[0]
            let numM = block.match(/data-episode="(\d+)"/)
            let urlM = block.match(/data-url="([^"]+)"/)
            let tokenM = block.match(/data-stream-token="([^"]+)"/)
            let titleM = block.match(/<span class="ws-ep__title">([^<]+)</)
            if (numM && urlM) {
                let num = parseInt(numM[1], 10)
                if (!episodes.some(function (e) { return e.number === num })) {
                    episodes.push({
                        id: tokenM ? tokenM[1] : numM[1],
                        number: num,
                        url: urlM[1],
                        title: titleM ? titleM[1] : "Episode " + num,
                    })
                }
            }
        }

        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort(function (a, b) { return a.number - b.number })
        console.log("[HiAnime] found", episodes.length, "episodes, range:", episodes[0].number, "-", episodes[episodes.length - 1].number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        let version = this._parseVersion(server)
        let serverName = this._parseServerName(server)
        console.log("[HiAnime] findEpisodeServer ep:", episode.number, "server:", server, "version:", version)
        let url = ""

        if (serverName === "ryu") {
            url = this._buildRyuUrl(episode.id, version)
            console.log("[HiAnime] built Ryu URL:", url ? url.substring(0, 60) + "..." : "failed")
        } else {
            let ids = await this._scrapeWatchPage(episode.url)
            if (!ids.anilistId) throw new Error("Could not scrape anilistId")

            if (serverName === "volt") {
                url = this._buildDirectUrl("https://vidnest.fun/anime/", ids.anilistId, episode.number, version)
            } else if (serverName === "warp") {
                url = this._buildDirectUrl("https://tryembed.us.cc/embed/anime/", ids.anilistId, episode.number, version)
            } else if (serverName === "ayame") {
                url = this._buildDirectUrl("https://vidnest.fun/animepahe/", ids.anilistId, episode.number, version)
            }
            console.log("[HiAnime] built", serverName, "URL:", url.substring(0, 70) + "...")
        }

        if (!url) throw new Error("No player URL could be built for " + server)

        let playerHeaders = this._headers(episode.url)
        try {
            console.log("[HiAnime] fetching player page:", url.substring(0, 70) + "...")
            let res = await fetch(url, { headers: playerHeaders })
            console.log("[HiAnime] player page status:", res.status)
            if (res.ok) {
                let text = await res.text()
                let sources: VideoSource[] = []
                let srcParts = text.split("<source")
                console.log("[HiAnime] found", srcParts.length - 1, "<source> tags")
                for (let s = 1; s < srcParts.length; s++) {
                    let sm = srcParts[s].match(/src="([^"]+)"/)
                    if (sm && !sources.some(function (x) { return x.url === sm[1] })) {
                        let type = sm[1].indexOf(".m3u8") !== -1 ? "hls" : "mp4"
                        sources.push({ url: sm[1], quality: "auto", type: type, subtitles: [] })
                    }
                }
                if (sources.length > 0) {
                    console.log("[HiAnime] extracted", sources.length, "sources")
                    return { server: server, headers: playerHeaders, videoSources: sources }
                }
                console.log("[HiAnime] no <source> tags found, falling back to unknown type")
            }
        } catch (e) {
            console.log("[HiAnime] player page fetch error:", e)
        }

        return { server: server, headers: playerHeaders, videoSources: [{ url: url, quality: "auto", type: "unknown", subtitles: [] }] }
    }
}
