/// <reference path="./online-streaming-provider.d.ts" />

console.log("[HiAnime] PROVIDER LOADED v1.0.3-shiva")

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

    _extractSlug(id: string): { name: string, animeId: string } {
        let lastDash = id.lastIndexOf("-")
        if (lastDash === -1) return { name: "", animeId: id }
        return { name: id.substring(0, lastDash), animeId: id.substring(lastDash + 1) }
    }

    async _scrapeEpisodeData(episodeUrl: string): Promise<{ anilistId: string, streamToken: string }> {
        console.log("[HiAnime] scraping episode data from:", episodeUrl.substring(0, 70))
        let res = await fetch(episodeUrl, { headers: this._headers(this.base) })
        if (!res.ok) {
            console.log("[HiAnime] scrape failed:", res.status)
            return { anilistId: "", streamToken: "" }
        }
        let html = await res.text()
        let aniM = html.match(/var anilistId\s*=\s*(\d+)/)
        let tokenM = html.match(/data-stream-token="([^"]+)"/)
        console.log("[HiAnime] anilistId:", aniM ? aniM[1] : "not found", "token:", tokenM ? "found" : "not found")
        return { anilistId: aniM ? aniM[1] : "", streamToken: tokenM ? tokenM[1] : "" }
    }

    _tokenToEpisodeId(token: string): string {
        if (!token) return ""
        let d = this._b64decode(token)
        return d.split(":")[0]
    }

    _versionFromServer(server: string): string {
        let s = server.toLowerCase()
        if (s.indexOf("dub") !== -1) return "dub"
        return "sub"
    }

    _serverKey(server: string): string {
        let s = server.toLowerCase()
        if (s.indexOf("volt") !== -1) return "volt"
        if (s.indexOf("warp") !== -1) return "warp"
        if (s.indexOf("ayame") !== -1) return "ayame"
        return "ryu"
    }

    getSettings(): Settings {
        return {
            episodeServers: ["Shiva", "Ryu Sub", "Ryu Dub", "Volt Sub", "Volt Dub", "Warp Sub", "Warp Dub", "Ayame Sub", "Ayame Dub"],
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
        console.log("[HiAnime] fetching:", ep1Url)
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
                        id: numM[1],
                        number: num,
                        url: urlM[1].indexOf("http") === 0 ? urlM[1] : this.base + urlM[1],
                        title: titleM ? titleM[1] : "Episode " + num,
                    })
                }
            }
        }

        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort(function (a, b) { return a.number - b.number })
        console.log("[HiAnime] found", episodes.length, "episodes:", episodes[0].number, "-", episodes[episodes.length - 1].number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        console.log("[HiAnime] findEpisodeServer ep:", episode.number, "server:", server)
        let version = this._versionFromServer(server)
        let key = this._serverKey(server)
        let data = await this._scrapeEpisodeData(episode.url)
        let url = ""

        if (key === "volt") {
            if (data.anilistId) url = "https://vidnest.fun/anime/" + data.anilistId + "/" + episode.number + "/" + version
        } else if (key === "warp") {
            if (data.anilistId) url = "https://tryembed.us.cc/embed/anime/" + data.anilistId + "/" + episode.number + "/" + version
        } else if (key === "ayame") {
            if (data.anilistId) url = "https://vidnest.fun/animepahe/" + data.anilistId + "/" + episode.number + "/" + version
        }

        if (!url) {
            let epId = this._tokenToEpisodeId(data.streamToken)
            if (epId) url = "https://megaplay.buzz/stream/s-2/" + epId + "/" + version
        }

        if (!url) {
            console.log("[HiAnime] fallback: returning episode URL")
            return { server: server, headers: this._headers(episode.url), videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        console.log("[HiAnime] player URL:", url.substring(0, 70) + "...")
        return { server: server, headers: this._headers(episode.url), videoSources: [{ url: url, quality: "auto", type: "unknown", subtitles: [] }] }
    }
}
