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
        let ajaxUrl = this.base + "/ajax/v2/episode/list/" + animeId
        console.log("[hianime] ajax:", ajaxUrl)
        let res = await fetch(ajaxUrl, { headers: this._headers(this.base) })
        if (!res.ok) { console.log("[hianime] ajax fail:", res.status); return [] }
        let html = await res.text()
        console.log("[hianime] ajax html length:", html.length)
        let episodes: EpisodeDetails[] = []
        let epRx = /<a\s+href="#"([\s\S]*?)<\/a>/g
        let m
        while ((m = epRx.exec(html)) !== null) {
            let block = m[1]
            let numM = block.match(/data-number="(\d+)"/)
            let idM = block.match(/data-id="([^"]+)"/)
            let titleM = block.match(/title="([^"]+)"/)
            if (numM && idM) {
                let num = parseInt(numM[1], 10)
                if (!episodes.some(function (e) { return e.number === num })) {
                    let epUrl = this.base + "/watch/" + name + "-" + animeId + "?ep=" + idM[1]
                    episodes.push({
                        id: idM[1],
                        number: num,
                        url: epUrl,
                        title: titleM ? titleM[1] : "Episode " + num,
                    })
                }
            }
        }
        if (episodes.length === 0) {
            console.log("[hianime] trying fallback regex")
            let epRx2 = /data-number="(\d+)"[\s\S]*?data-id="([^"]+)"/g
            let m2
            while ((m2 = epRx2.exec(html)) !== null) {
                let num = parseInt(m2[1], 10)
                if (!episodes.some(function (e) { return e.number === num })) {
                    let epUrl = this.base + "/watch/" + name + "-" + animeId + "?ep=" + m2[2]
                    episodes.push({ id: m2[2], number: num, url: epUrl, title: "Episode " + num })
                }
            }
        }
        episodes.sort(function (a, b) { return a.number - b.number })
        console.log("[hianime] episodes:", episodes.length, episodes[0] ? episodes[0].number + "-" + episodes[episodes.length - 1].number : "none")
        return episodes
    }

    _parseM3u8(body: string, baseUrl: string): VideoSource[] {
        let sources: VideoSource[] = []
        let lines = body.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim()
            if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
                let nameM = line.match(/NAME="([^"]+)"/)
                let quality = nameM ? nameM[1] : "auto"
                let next = i + 1
                while (next < lines.length && lines[next].trim() === "") next++
                if (next < lines.length) {
                    let url = lines[next].trim()
                    if (url.indexOf("http") !== 0) {
                        let sep = baseUrl.lastIndexOf("/")
                        url = baseUrl.substring(0, sep + 1) + url
                    }
                    sources.push({ url: url, quality: quality, type: "hls", subtitles: [] })
                }
            }
        }
        return sources
    }

    async _fetchM3u8(url: string, referer: string): Promise<{ sources: VideoSource[], masterUrl: string }> {
        console.log("[hianime] fetch m3u8:", url.substring(0, 60))
        let res = await fetch(url, { headers: this._headers(referer), redirect: "follow" })
        if (!res.ok) { console.log("[hianime] m3u8 fail:", res.status); return { sources: [], masterUrl: url } }
        let finalUrl = res.url || url
        let body = await res.text()
        console.log("[hianime] m3u8 body starts with:", body.substring(0, 40))
        if (body.indexOf("#EXTM3U") !== -1) {
            let sources = this._parseM3u8(body, finalUrl)
            console.log("[hianime] m3u8 parsed:", sources.length, "variants")
            if (sources.length > 0) return { sources, masterUrl: finalUrl }
        }
        return { sources: [], masterUrl: finalUrl }
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        console.log("[hianime] findEpisodeServer ep:", episode.number, "server:", server)
        let version = episode.subOrDub === "dub" ? "dub" : "sub"
        let key = this._serverKey(server)
        let sr = this._serverReferers[key as keyof typeof this._serverReferers] || "https://megaplay.buzz/"
        let data = await this._scrapeEpisodeData(episode.url)

        if (key === "volt" && data.anilistId) {
            let url = "https://vidnest.fun/anime/" + data.anilistId + "/" + episode.number + "/" + version
            console.log("[hianime] volt URL:", url.substring(0, 60))
            return { server: server, headers: this._headers(sr), videoSources: [{ url: url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        if (key === "warp" && data.anilistId) {
            let url = "https://tryembed.us.cc/embed/anime/" + data.anilistId + "/" + episode.number + "/" + version
            console.log("[hianime] warp URL:", url.substring(0, 60))
            return { server: server, headers: this._headers(sr), videoSources: [{ url: url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        if (key === "ayame" && data.anilistId) {
            let url = "https://vidnest.fun/animepahe/" + data.anilistId + "/" + episode.number + "/" + version
            console.log("[hianime] ayame URL:", url.substring(0, 60))
            return { server: server, headers: this._headers(sr), videoSources: [{ url: url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        // Ryu — use getSourcesNew JSON API
        let epId = this._tokenToEpisodeId(data.streamToken)
        if (epId) {
            let apiUrl = "https://megaplay.buzz/stream/getSourcesNew?id=" + epId + "&id=" + epId
            console.log("[hianime] ryu API:", apiUrl)
            let res = await fetch(apiUrl, { headers: this._headers(sr) })
            if (res.ok) {
                let json = await res.json()
                console.log("[hianime] ryu JSON keys:", Object.keys(json).join(","))
                let masterUrl = json.sources && json.sources.file
                let subs: { url: string, lang: string }[] = []
                if (json.tracks) {
                    for (let t of json.tracks) {
                        if (t.file) subs.push({ url: t.file, lang: t.label || "English" })
                    }
                }
                if (masterUrl) {
                    console.log("[hianime] ryu master:", masterUrl.substring(0, 60))
                    let m3u8Result = await this._fetchM3u8(masterUrl, sr)
                    if (m3u8Result.sources.length > 0) {
                        for (let s of m3u8Result.sources) {
                            s.subtitles = subs
                        }
                        console.log("[hianime] ryu HLS with", m3u8Result.sources.length, "variants,", subs.length, "subs")
                        return { server: server, headers: this._headers(sr), videoSources: m3u8Result.sources }
                    }
                    console.log("[hianime] ryu no variants, using master URL with subs")
                    return { server: server, headers: this._headers(sr), videoSources: [{ url: masterUrl, quality: "auto", type: "hls", subtitles: subs }] }
                }
            }
            console.log("[hianime] ryu API failed, falling through")
        }

        console.log("[hianime] no token, fallback to episode URL")
        return { server: server, headers: this._headers(episode.url), videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] }
    }
}
