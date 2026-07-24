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

    _serverReferers: Record<string, string> = {
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
            "X-Requested-With": "XMLHttpRequest",
        }
    }

    _extractSlug(id: string): { name: string, animeId: string } {
        let lastDash = id.lastIndexOf("-")
        if (lastDash === -1) return { name: "", animeId: id }
        return { name: id.substring(0, lastDash), animeId: id.substring(lastDash + 1) }
    }

    _b64decode(s: string): string {
        try { return atob(s.replace(/-/g, "+").replace(/_/g, "/")) } catch (e) { return "" }
    }

    _tokenToEpisodeId(token: string): string {
        if (!token) return ""
        return this._b64decode(token).split(":")[0]
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
        let res = await fetch(this.base + "/search?q=" + encodeURIComponent(opts.query), { headers: this._headers(this.base) })
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
                    url: this.base + "/details/" + linkM[1],
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
        let url = this.base + "/watch-" + name + "-episode-1-" + animeId
        let res = await fetch(url, { headers: this._headers(this.base) })
        if (!res.ok) { console.log("[hianime] watch fail:", res.status); return [] }
        let html = await res.text()
        let episodes: EpisodeDetails[] = []
        let rx = /<a[\s\S]*?class="ws-ep[^"]*"[\s\S]*?<\/a>/g
        let m
        while ((m = rx.exec(html)) !== null) {
            let b = m[0]
            let numM = b.match(/data-episode="(\d+)"/)
            let tokenM = b.match(/data-stream-token="([^"]+)"/)
            let titleM = b.match(/aria-label="([^"]+)"/)
            if (numM && tokenM) {
                let num = parseInt(numM[1], 10)
                let epId = this._tokenToEpisodeId(tokenM[1])
                if (epId && !episodes.some(function (e) { return e.number === num })) {
                    episodes.push({
                        id: epId,
                        number: num,
                        url: this.base + "/watch-" + name + "-episode-" + num + "-" + animeId,
                        title: titleM ? titleM[1] : "Episode " + num,
                    })
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
        let res = await fetch(url, { headers: this._headers(referer), redirect: "follow" })
        if (!res.ok) { console.log("[hianime] m3u8 fail:", res.status); return { sources: [], masterUrl: url } }
        let finalUrl = res.url || url
        let body = await res.text()
        if (body.indexOf("#EXTM3U") !== -1) {
            let sources = this._parseM3u8(body, finalUrl)
            if (sources.length > 0) return { sources, masterUrl: finalUrl }
        }
        return { sources: [], masterUrl: finalUrl }
    }

    async _scrapeWatchPage(episodeUrl: string): Promise<string> {
        let res = await fetch(episodeUrl, { headers: this._headers(this.base) })
        if (!res.ok) return ""
        return await res.text()
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        console.log("[hianime] findEpisodeServer ep:", episode.number, "server:", server)
        let version = episode.subOrDub === "dub" ? "dub" : "sub"
        let key = this._serverKey(server)
        let sr = this._serverReferers[key] || "https://megaplay.buzz/"
        let html = await this._scrapeWatchPage(episode.url)
        let aniM = html.match(/var anilistId\s*=\s*(\d+)/)
        let tokenM = html.match(/data-stream-token="([^"]+)"/)
        let anilistId = aniM ? aniM[1] : ""

        if (key === "volt" && anilistId) {
            return { server, headers: this._headers(sr), videoSources: [{ url: "https://vidnest.fun/anime/" + anilistId + "/" + episode.number + "/" + version, quality: "auto", type: "unknown", subtitles: [] }] }
        }
        if (key === "warp" && anilistId) {
            return { server, headers: this._headers(sr), videoSources: [{ url: "https://tryembed.us.cc/embed/anime/" + anilistId + "/" + episode.number + "/" + version, quality: "auto", type: "unknown", subtitles: [] }] }
        }
        if (key === "ayame" && anilistId) {
            return { server, headers: this._headers(sr), videoSources: [{ url: "https://vidnest.fun/animepahe/" + anilistId + "/" + episode.number + "/" + version, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        // Ryu -- decode stream token, call getSourcesNew
        let epId = this._tokenToEpisodeId(tokenM ? tokenM[1] : "")
        if (epId) {
            let apiUrl = "https://megaplay.buzz/stream/getSourcesNew?id=" + epId + "&id=" + epId
            console.log("[hianime] ryu API:", apiUrl.substring(0, 80))
            let res = await fetch(apiUrl, { headers: this._headers(sr) })
            if (res.ok) {
                let json = await res.json()
                let masterUrl = json.sources && json.sources.file
                let subs: { url: string, lang: string }[] = []
                if (json.tracks) {
                    for (let t of json.tracks) {
                        if (t.file) subs.push({ url: t.file, lang: t.label || "English" })
                    }
                }
                if (masterUrl) {
                    let m3u8Result = await this._fetchM3u8(masterUrl, sr)
                    if (m3u8Result.sources.length > 0) {
                        for (let s of m3u8Result.sources) s.subtitles = subs
                        return { server, headers: this._headers(sr), videoSources: m3u8Result.sources }
                    }
                    return { server, headers: this._headers(sr), videoSources: [{ url: masterUrl, quality: "auto", type: "hls", subtitles: subs }] }
                }
            }
        }

        console.log("[hianime] fallback to episode URL")
        return { server, headers: this._headers(episode.url), videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] }
    }
}
