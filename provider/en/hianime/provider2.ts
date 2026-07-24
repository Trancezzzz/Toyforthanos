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

    _rand<T>(arr: T[]): T {
        return arr[Math.floor(Math.random() * arr.length)]
    }

    _headers(referer: string) {
        return {
            "User-Agent": this._rand(this._uas),
            Referer: referer,
            "X-Requested-With": "XMLHttpRequest",
        }
    }

    _extractSlug(id: string): { name: string, animeId: string } {
        let lastDash = id.lastIndexOf("-")
        if (lastDash === -1) return { name: "", animeId: id }
        return { name: id.substring(0, lastDash), animeId: id.substring(lastDash + 1) }
    }

    _b64decode(s: string): string {
        try {
            let b = s.replace(/-/g, "+").replace(/_/g, "/")
            while (b.length % 4 !== 0) b += "="
            return CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(b))
        } catch (e) { return "" }
    }

    _tokenToEpisodeId(token: string): string {
        if (!token) return ""
        return this._b64decode(token).split(":")[0]
    }

    _parseM3u8(body: string, baseUrl: string): VideoSource[] {
        let sources: VideoSource[] = []
        let lines = body.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim()
            if (line.indexOf("#EXT-X-STREAM-INF:") === -1) continue
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
                sources.push({ url, quality, type: "hls", subtitles: [] })
            }
        }
        return sources
    }

    getSettings(): Settings {
        return { episodeServers: ["Ryu"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
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
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let { name, animeId } = this._extractSlug(id)
        if (!name) return []
        let url = this.base + "/watch-" + name + "-episode-1-" + animeId
        let res = await fetch(url, { headers: this._headers(this.base) })
        if (!res.ok) return []
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

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        let sr = "https://megaplay.buzz/"
        let version = episode.subOrDub === "dub" ? "dub" : "sub"
        let html = await (await fetch(episode.url, { headers: this._headers(this.base) })).text()
        let tokenM = html.match(/data-stream-token="([^"]+)"/)
        let realId = this._tokenToEpisodeId(tokenM ? tokenM[1] : "")
        if (!realId) throw new Error("No stream token")

        let br = await fetch("https://megaplay.buzz/stream/s-2/" + realId + "/" + version, { headers: this._headers(sr) })
        if (!br.ok) throw new Error("Backup URL failed: " + br.status)
        let didM = (await br.text()).match(/data-id="(\d+)"/)
        let dataId = didM ? didM[1] : ""
        if (!dataId) throw new Error("No data-id in backup")

        let res = await fetch("https://megaplay.buzz/stream/getSourcesNew?id=" + dataId + "&id=" + dataId, { headers: this._headers(sr) })
        if (!res.ok) throw new Error("getSourcesNew failed: " + res.status)
        let json = JSON.parse(await res.text())
        let masterUrl = json.sources && json.sources.file
        if (!masterUrl) throw new Error("No master URL in JSON")

        let subs: { url: string, lang: string }[] = []
        if (json.tracks) {
            for (let t of json.tracks) {
                if (t.file) subs.push({ url: t.file, lang: t.label || "English" })
            }
        }

        let m3u8Res = await fetch(masterUrl, { headers: this._headers(sr), redirect: "follow" })
        if (m3u8Res.ok) {
            let body = await m3u8Res.text()
            if (body.indexOf("#EXTM3U") !== -1) {
                let sources = this._parseM3u8(body, m3u8Res.url || masterUrl)
                if (sources.length > 0) {
                    for (let s of sources) s.subtitles = subs
                    return { server, headers: this._headers(sr), videoSources: sources }
                }
            }
        }
        return { server, headers: this._headers(sr), videoSources: [{ url: masterUrl, quality: "auto", type: "hls", subtitles: subs }] }
    }
}
