/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
    base = "https://www.animeworld.ac"
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    _headers(referer: string) {
        return { "User-Agent": this.UA, Referer: referer }
    }

    getSettings(): Settings {
        return {
            episodeServers: ["AnimeWorld"],
            supportsDub: false,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!opts.query.trim()) return []
        var res = await fetch(this.base + "/search?keyword=" + encodeURIComponent(opts.query), { headers: this._headers(this.base) })
        if (!res.ok) return []
        var html = await res.text()
        var results: SearchResult[] = []
        var parts = html.split('<div class="item">')
        for (var i = 1; i < parts.length; i++) {
            var linkM = parts[i].match(/href="\/play\/([^"]+)"/)
            var titleM = parts[i].match(/class="name"[^>]*>([^<]+)</)
            if (linkM && titleM) results.push({ id: linkM[1], title: titleM[1], url: this.base + "/play/" + linkM[1], subOrDub: "sub" })
        }
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        var res = await fetch(this.base + "/play/" + id, { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        var html = await res.text()

        var allEpisodes: EpisodeDetails[] = []
        var epRx = /<li\s+class="episode"[^>]*>[\s\S]*?<\/li>/g
        var m
        while ((m = epRx.exec(html)) !== null) {
            var block = m[0]
            var idM = block.match(/data-id="([^"]+)"/)
            var numM = block.match(/data-episode-num="(\d+)"/)
            var hrefM = block.match(/href="([^"]+)"/)
            if (idM && numM) {
                var num = parseInt(numM[1], 10)
                var epHref = hrefM ? hrefM[1] : ""
                if (!allEpisodes.some(function (e) { return e.number === num })) {
                    allEpisodes.push({
                        id: idM[1],
                        number: num,
                        url: epHref ? (epHref.indexOf("http") === 0 ? epHref : this.base + (epHref[0] === "/" ? "" : "/") + epHref) : this.base + "/play/" + id,
                        title: "Episode " + num,
                    })
                }
            }
        }

        if (allEpisodes.length === 0) throw new Error("No episodes found.")
        allEpisodes.sort(function (a, b) { return a.number - b.number })
        return allEpisodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        var playerUrl = this.base + "/api/episode/serverPlayerAnimeWorld?id=" + episode.id

        var prRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
        if (prRes.ok) {
            var prText = await prRes.text()
            if (prText.indexOf("<source") === -1 && prText.indexOf("https://") === -1) playerUrl = ""
        } else {
            playerUrl = ""
        }

        if (!playerUrl) {
            playerUrl = this.base + "/api/episode/serverPlayerShiva?id=" + episode.id
            var prRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
            if (prRes.ok) {
                var prText = await prRes.text()
                if (prText.indexOf("<source") === -1 && prText.indexOf("https://") === -1) playerUrl = ""
            } else {
                playerUrl = ""
            }
        }

        if (!playerUrl) {
            playerUrl = this.base + "/api/episode/serverPlayer?id=" + episode.id
            var prRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
            if (prRes.ok) {
                var prText = await prRes.text()
                if (prText.indexOf("<source") === -1 && prText.indexOf("https://") === -1) playerUrl = ""
            } else {
                playerUrl = ""
            }
        }

        if (!playerUrl) throw new Error("No player URL found")

        var plRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
        if (!plRes.ok) {
            return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        var plHtml = await plRes.text()
        var sources: VideoSource[] = []
        var srcParts = plHtml.split("<source")
        for (var si = 1; si < srcParts.length; si++) {
            var m = srcParts[si].match(/src="([^"]+)"/)
            if (m && !sources.some(function (x) { return x.url === m[1] })) {
                sources.push({ url: m[1], quality: "auto", type: m[1].indexOf(".m3u8") !== -1 ? "m3u8" : "mp4", subtitles: [] })
            }
        }

        if (sources.length === 0) {
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: sources }
    }
}
