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

        const res = await fetch(this.base + "/search?keyword=" + encodeURIComponent(opts.query), { headers: this._headers(this.base) })
        if (!res.ok) return []

        const html = await res.text()
        const results: SearchResult[] = []
        const parts = html.split('<div class="item">')
        for (let i = 1; i < parts.length; i++) {
            const linkM = parts[i].match(/href="\/play\/([^"]+)"/)
            const titleM = parts[i].match(/class="name"[^>]*>([^<]+)</)
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
        var epRes = await fetch(episode.url, { headers: this._headers(this.base) })
        if (!epRes.ok) throw new Error("page fetch failed " + epRes.status)
        var epHtml = await epRes.text()

        var csrfToken = (epHtml.match(/window\.csrfToken\s*=\s*['"]([^'"]+)['"]/) || epHtml.match(/csrf-token[^>]+content="([^"]+)/) || [])[1] || ""

        var playerUrl = ""

        var playerEndpoints = [
            this.base + "/api/episode/serverPlayerAnimeWorld?id=" + episode.id,
            this.base + "/api/episode/serverPlayerShiva?id=" + episode.id,
            this.base + "/api/episode/serverPlayer?id=" + episode.id,
        ]

        for (var pi = 0; pi < playerEndpoints.length; pi++) {
            try {
                var prRes = await fetch(playerEndpoints[pi], { headers: this._headers(episode.url) })
                if (prRes.ok) {
                    var prText = await prRes.text()
                    if (prText.indexOf("<source") !== -1 || prText.indexOf("https://") !== -1) {
                        playerUrl = playerEndpoints[pi]
                        break
                    }
                    if (prText.indexOf('"target"') !== -1 || prText.indexOf("target") !== -1) {
                        try {
                            var pd = JSON.parse(prText)
                            if (pd.target) {
                                playerUrl = pd.target
                                break
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }

        if (!playerUrl && csrfToken) {
            try {
                var h = epRes.headers
                var cookieStr = ""
                try {
                    if (h) {
                        var keys = Object.keys(h)
                        for (var ki = 0; ki < keys.length; ki++) {
                            if (keys[ki].toLowerCase() === "set-cookie") {
                                var raw = String(h[keys[ki]])
                                var cparts = raw.split(",")
                                for (var ci = 0; ci < cparts.length; ci++) {
                                    var cv = cparts[ci].split(";")[0].trim()
                                    if (cv.length > 0) { if (cookieStr.length > 0) cookieStr += "; "; cookieStr += cv }
                                }
                            }
                        }
                    }
                } catch (e2) {}

                var apiBody = JSON.stringify({ id: episode.id, alt: "0" })

                var apiRes = await fetch(this.base + "/api/episode/info", {
                    method: "POST",
                    headers: {
                        "CSRF-Token": csrfToken, "Content-Type": "application/json",
                        "User-Agent": this.UA, Referer: episode.url,
                        "X-Requested-With": "XMLHttpRequest", Origin: this.base,
                    },
                    body: apiBody,
                })
                if (apiRes.ok) {
                    var apiText = await apiRes.text()
                    var apiData = JSON.parse(apiText)
                    if (apiData.target) playerUrl = apiData.target
                }
            } catch (e) {}
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

        var idx = 0
        while (true) {
            idx = plHtml.indexOf("https://", idx)
            if (idx === -1) break
            var end = idx + 8
            while (end < plHtml.length && plHtml[end] !== '"' && plHtml[end] !== "'" && plHtml[end] !== " " && plHtml[end] !== ">" && plHtml[end] !== "\n" && plHtml[end] !== "\r" && plHtml[end] !== "\t") end++
            var url = plHtml.substring(idx, end)
            if ((url.indexOf(".mp4") !== -1 || url.indexOf(".m3u8") !== -1) && !sources.some(function (x) { return x.url === url })) {
                sources.push({ url: url, quality: "auto", type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4", subtitles: [] })
            }
            idx = end
        }

        if (sources.length === 0) {
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: sources }
    }
}
