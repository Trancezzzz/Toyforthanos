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

    _sourceType(url: string) {
        return url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4"
    }

    async _tryPlayer(episodeId: string, server: string, referer: string) {
        let url = this._url("/api/episode/serverPlayer" + server + "?id=" + episodeId)
        let res = await fetch(url, { headers: this._headers(referer) })
        if (!res.ok) return ""
        let text = await res.text()
        if (text.indexOf("<source") !== -1 || text.indexOf("https://") !== -1) return url
        return ""
    }

    getSettings(): Settings {
        return { episodeServers: ["AnimeWorld"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!opts.query.trim()) return []
        let res = await fetch(this._url("/search?keyword=" + encodeURIComponent(opts.query)), { headers: this._headers(this.base) })
        if (!res.ok) return []
        let html = await res.text()
        let results: SearchResult[] = []
        let parts = html.split('<div class="item">')
        for (let i = 1; i < parts.length; i++) {
            let linkM = parts[i].match(/href="\/play\/([^"]+)"/)
            let titleM = parts[i].match(/class="name"[^>]*>([^<]+)</)
            if (linkM && titleM) results.push({ id: linkM[1], title: titleM[1], url: this._url("/play/" + linkM[1]), subOrDub: "sub" })
        }
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let res = await fetch(this._url("/play/" + id), { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        let html = await res.text()
        let episodes: EpisodeDetails[] = []
        let epRx = /<li\s+class="episode"[^>]*>[\s\S]*?<\/li>/g
        let m
        while ((m = epRx.exec(html)) !== null) {
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
            }
        }
        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort(function (a, b) { return a.number - b.number })
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        let servers = ["AnimeWorld", "Shiva", ""]
        let playerUrl = ""
        for (let si = 0; si < servers.length; si++) {
            playerUrl = await this._tryPlayer(episode.id, servers[si], episode.url)
            if (playerUrl) break
        }
        if (!playerUrl) throw new Error("No player URL found")

        let plRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
        if (!plRes.ok) {
            return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        let plHtml = await plRes.text()
        let sources: VideoSource[] = []
        let srcParts = plHtml.split("<source")
        for (let s = 1; s < srcParts.length; s++) {
            let sm = srcParts[s].match(/src="([^"]+)"/)
            if (sm && !sources.some(function (x) { return x.url === sm[1] })) {
                sources.push({ url: sm[1], quality: "auto", type: this._sourceType(sm[1]), subtitles: [] })
            }
        }

        if (sources.length === 0) {
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: sources }
    }
}
