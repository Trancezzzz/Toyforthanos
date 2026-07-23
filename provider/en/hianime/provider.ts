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

    _buildBackupUrl(token: string, version: string, epNum: number): string {
        let v = version || "sub"
        if (token) {
            let decoded = this._b64decode(token)
            let epId = decoded.split(":")[0]
            if (epId) return "https://megaplay.buzz/stream/s-2/" + epId + "/" + v
        }
        return ""
    }

    _extractSlug(id: string): { name: string, animeId: string } {
        let lastDash = id.lastIndexOf("-")
        if (lastDash === -1) return { name: "", animeId: id }
        return { name: id.substring(0, lastDash), animeId: id.substring(lastDash + 1) }
    }

    getSettings(): Settings {
        return { episodeServers: ["HiAnime"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
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
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let { name, animeId } = this._extractSlug(id)
        if (!name) throw new Error("Invalid slug: " + id)

        let ep1Url = this._url("/watch-" + name + "-episode-1-" + animeId)
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
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        let subOrDub = "sub"
        let backupUrl = this._buildBackupUrl(episode.id, subOrDub, episode.number)

        if (!backupUrl) throw new Error("No player URL could be built")

        let playerHeaders = this._headers(episode.url)
        try {
            let res = await fetch(backupUrl, { headers: playerHeaders })
            if (res.ok) {
                let text = await res.text()
                let sources: VideoSource[] = []
                let srcParts = text.split("<source")
                for (let s = 1; s < srcParts.length; s++) {
                    let sm = srcParts[s].match(/src="([^"]+)"/)
                    if (sm && !sources.some(function (x) { return x.url === sm[1] })) {
                        let type = sm[1].indexOf(".m3u8") !== -1 ? "hls" : "mp4"
                        sources.push({ url: sm[1], quality: "auto", type: type, subtitles: [] })
                    }
                }
                if (sources.length > 0) {
                    return { server: "HiAnime", headers: playerHeaders, videoSources: sources }
                }
            }
        } catch (e) { }

        return { server: "HiAnime", headers: playerHeaders, videoSources: [{ url: backupUrl, quality: "auto", type: "unknown", subtitles: [] }] }
    }
}
