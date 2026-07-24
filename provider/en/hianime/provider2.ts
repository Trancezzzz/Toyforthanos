/// <reference path="./online-streaming-provider.d.ts" />

let _loaded = false

class Provider {
    constructor() { if (!_loaded) { _loaded = true; console.log("[hianime] loaded") } }
    base = "https://hianime.ms"

    _uas = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    ]

    _serverReferers = {
        ryu: "https://megaplay.buzz/",
        volt: "https://vidnest.fun/",
        warp: "https://tryembed.us.cc/",
        ayame: "https://vidnest.fun/",
    }

    _rand<T>(arr: T[]): T {
        return arr[Math.floor(Math.random() * arr.length)]
    }

    _headers(referer: string) {
        return {
            "User-Agent": this._rand(this._uas),
            Referer: referer,
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
        }
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
        console.log("[hianime] scrape:", episodeUrl.substring(0, 60))
        let res = await fetch(episodeUrl, { headers: this._headers(this.base) })
        if (!res.ok) { console.log("[hianime] scrape fail:", res.status); return { anilistId: "", streamToken: "" } }
        let html = await res.text()
        let aniM = html.match(/var anilistId\s*=\s*(\d+)/)
        let tokenM = html.match(/data-stream-token="([^"]+)"/)
        console.log("[hianime] scrape anilistId:", aniM ? aniM[1] : "no", "token:", tokenM ? "yes" : "no")
        return { anilistId: aniM ? aniM[1] : "", streamToken: tokenM ? tokenM[1] : "" }
    }

    _tokenToEpisodeId(token: string): string {
        if (!token) return ""
        let d = this._b64decode(token)
        return d.split(":")[0]
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
            episodeServers: ["Ryu", "Volt", "Warp", "Ayame"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        console.log("[hianime] search:", opts.query)
        if (!opts.query.trim()) return []
        let res = await fetch(this._url("/search?q=" + encodeURIComponent(opts.query)), { headers: this._headers(this.base) })
        if (!res.ok) return []
        let html = await res.text()
        let results: SearchResult[] = []
        let parts = html.split('<div class="flw-item">')
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
        console.log("[hianime] search results:", results.length)
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let { name, animeId } = this._extractSlug(id)
        console.log("[hianime] findEpisodes:", name, animeId)
        if (!name) return []
        let ep1Url = this._url("/watch-" + name + "-episode-1-" + animeId)
        let res = await fetch(ep1Url, { headers: this._headers(this.base) })
        if (!res.ok) return []
        let html = await res.text()
        let episodes: EpisodeDetails[] = []
        let epRx = /<a\s+class="ws-ep[^"]*"[^>]*>[\s\S]*?<\/a>/g
        let m
        while ((m = epRx.exec(html)) !== null) {
            let block = m[0]
            let numM = block.match(/data-episode="(\d+)"/)
            let urlM = block.match(/data-url="([^"]+)"/)
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
        episodes.sort(function (a, b) { return a.number - b.number })
        console.log("[hianime] episodes:", episodes.length, episodes[0] ? episodes[0].number + "-" + episodes[episodes.length - 1].number : "none")
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        console.log("[hianime] findEpisodeServer ep:", episode.number, "server:", server)
        let url = ""
        let version = episode.subOrDub === "dub" ? "dub" : "sub"
        let key = this._serverKey(server)
        let data = await this._scrapeEpisodeData(episode.url)
        let sr = this._serverReferers[key as keyof typeof this._serverReferers] || "https://megaplay.buzz/"

        if (key === "volt" && data.anilistId) {
            url = "https://vidnest.fun/anime/" + data.anilistId + "/" + episode.number + "/" + version
        } else if (key === "warp" && data.anilistId) {
            url = "https://tryembed.us.cc/embed/anime/" + data.anilistId + "/" + episode.number + "/" + version
        } else if (key === "ayame" && data.anilistId) {
            url = "https://vidnest.fun/animepahe/" + data.anilistId + "/" + episode.number + "/" + version
        }

        if (!url) {
            let epId = this._tokenToEpisodeId(data.streamToken)
            if (epId) { url = "https://megaplay.buzz/stream/s-2/" + epId + "/" + version; console.log("[hianime] ryu fallback") }
            else console.log("[hianime] no token for ryu")
        }

        if (!url) {
            console.log("[hianime] fallback to episode URL")
            return { server: server, headers: this._headers(episode.url), videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        console.log("[hianime] return URL:", url.substring(0, 60))
        return { server: server, headers: this._headers(sr), videoSources: [{ url: url, quality: "auto", type: "unknown", subtitles: [] }] }
    }
}
