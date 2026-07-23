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
        console.log("[AnimeWorld] search:", opts.query)
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
        console.log("[AnimeWorld] search:", results.length, "results")
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        console.log("[AnimeWorld] findEpisodes:", id)
        const res = await fetch(this.base + "/play/" + id, { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)

        const html = await res.text()
        const episodes: EpisodeDetails[] = []
        const parts = html.split('<li class="episode">')
        for (let i = 1; i < parts.length; i++) {
            const idM = parts[i].match(/data-id="([^"]+)"/)
            const numM = parts[i].match(/data-episode-num="(\d+)"/)
            const hrefM = parts[i].match(/href="([^"]+)"/)
            if (idM && numM) {
                const num = parseInt(numM[1], 10)
                const epHref = hrefM ? hrefM[1] : ""
                episodes.push({
                    id: idM[1],
                    number: num,
                    url: epHref ? (epHref.indexOf("http") === 0 ? epHref : this.base + (epHref[0] === "/" ? "" : "/") + epHref) : this.base + "/play/" + id,
                    title: "Episode " + num,
                })
            }
        }
        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort(function (a, b) { return a.number - b.number })
        console.log("[AnimeWorld] findEpisodes:", episodes.length, "eps")
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("[AnimeWorld] findEpisodeServer id:", episode.id, "num:", episode.number)

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
                console.log("[AnimeWorld] trying direct player URL:", playerEndpoints[pi])
                var prRes = await fetch(playerEndpoints[pi], { headers: this._headers(episode.url) })
                if (prRes.ok) {
                    var prText = await prRes.text()
                    console.log("[AnimeWorld] direct response length:", prText.length, "preview:", prText.substring(0, 200))
                    if (prText.indexOf("<source") !== -1 || prText.indexOf("https://") !== -1) {
                        playerUrl = playerEndpoints[pi]
                        console.log("[AnimeWorld] direct player URL works:", playerUrl)
                        break
                    }
                    if (prText.indexOf('"target"') !== -1 || prText.indexOf("target") !== -1) {
                        try {
                            var pd = JSON.parse(prText)
                            if (pd.target) {
                                playerUrl = pd.target
                                console.log("[AnimeWorld] got target from direct:", playerUrl.substring(0, 80))
                                break
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) { console.log("[AnimeWorld] direct failed:", e) }
        }

        if (!playerUrl && csrfToken) {
            console.log("[AnimeWorld] trying API with CSRF token")
            try {
                var h = epRes.headers
                var cookieStr = ""
                try {
                    if (h) {
                        var keys = Object.keys(h)
                        console.log("[AnimeWorld] headers keys:", JSON.stringify(keys))
                        for (var ki = 0; ki < keys.length; ki++) {
                            console.log("[AnimeWorld] header", keys[ki], "=", String(h[keys[ki]]).substring(0, 60))
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
                } catch (e2) { console.log("[AnimeWorld] header iteration error:", e2) }

                var apiBody = JSON.stringify({ id: episode.id, alt: "0" })
                console.log("[AnimeWorld] API body:", apiBody)

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
                    console.log("[AnimeWorld] API response:", apiText.substring(0, 200))
                    var apiData = JSON.parse(apiText)
                    if (apiData.target) playerUrl = apiData.target
                } else {
                    console.log("[AnimeWorld] API status:", apiRes.status)
                }
            } catch (e) { console.log("[AnimeWorld] API error:", e) }
        }

        if (!playerUrl) throw new Error("No player URL found")

        console.log("[AnimeWorld] fetching player:", playerUrl.substring(0, 80))
        var plRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
        if (!plRes.ok) {
            return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        var plHtml = await plRes.text()
        console.log("[AnimeWorld] player HTML:", plHtml.length, "bytes, preview:", plHtml.substring(0, 600))

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
            console.log("[AnimeWorld] no sources, returning player URL")
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        console.log("[AnimeWorld] sources:", sources.length)
        return { server: "AnimeWorld", headers: this._headers(playerUrl), videoSources: sources }
    }
}
