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

        const res = await fetch(episode.url, { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("page fetch failed " + res.status)
        const html = await res.text()
        console.log("[AnimeWorld] page HTML length:", html.length)

        var iframeSrc = ""
        var iframeM = html.match(/<iframe[^>]*?src="([^"]+)"[^>]*?id="player-iframe"/)
            || html.match(/<iframe[^>]*?id="player-iframe"[^>]*?src="([^"]+)"/)
            || html.match(/player-iframe[^>]*?src="([^"]+)"/)
            || html.match(/iframe.*?src="([^"]*serverPlayer[^"]+)"/)
        if (iframeM) {
            iframeSrc = iframeM[1]
            if (iframeSrc.indexOf("http") !== 0) iframeSrc = this.base + (iframeSrc[0] === "/" ? "" : "/") + iframeSrc
            console.log("[AnimeWorld] player iframe:", iframeSrc)
        }

        var csrfToken = ""
        var csrfM = html.match(/window\.csrfToken\s*=\s*['"]([^'"]+)['"]/) || html.match(/csrf-token[^>]+content="([^"]+)"/)
        if (csrfM) {
            csrfToken = csrfM[1]
            console.log("[AnimeWorld] CSRF:", csrfToken.substring(0, 10) + "...")
        }

        var playerUrl = iframeSrc
        if (!playerUrl && csrfToken) {
            console.log("[AnimeWorld] no iframe found, trying API")
            var cookies = ""
            try {
                var h = res.headers
                if (h) {
                    var raw = h.get("Set-Cookie") || h.get("set-cookie") || ""
                    var cparts = raw.split(",")
                    for (var ci = 0; ci < cparts.length; ci++) {
                        var cv = cparts[ci].split(";")[0].trim()
                        if (cv.length > 0) { if (cookies.length > 0) cookies += "; "; cookies += cv }
                    }
                }
            } catch (e) {}
            var hdrs = {
                "CSRF-Token": csrfToken, "Content-Type": "application/json",
                "User-Agent": this.UA, Referer: episode.url,
                "X-Requested-With": "XMLHttpRequest", Origin: this.base,
            }
            if (cookies.length > 0) hdrs["Cookie"] = cookies
            try {
                var apiRes = await fetch(this.base + "/api/episode/info", {
                    method: "POST", headers: hdrs,
                    body: JSON.stringify({ id: episode.id, alt: "0" }),
                })
                if (apiRes.ok) {
                    var apiData = JSON.parse(await apiRes.text())
                    playerUrl = apiData.target || ""
                    console.log("[AnimeWorld] API target:", playerUrl.substring(0, 80))
                }
            } catch (e) { console.log("[AnimeWorld] API failed:", e) }
        }

        if (!playerUrl) throw new Error("No player URL found")

        console.log("[AnimeWorld] fetching player:", playerUrl.substring(0, 80))
        const playerRes = await fetch(playerUrl, { headers: this._headers(episode.url) })
        if (!playerRes.ok) {
            return {
                server: "AnimeWorld",
                headers: this._headers(playerUrl),
                videoSources: [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }],
            }
        }
        const playerHtml = await playerRes.text()
        console.log("[AnimeWorld] player HTML:", playerHtml.length, "bytes")
        console.log("[AnimeWorld] player HTML preview:", playerHtml.substring(0, 600))

        var sources: VideoSource[] = []
        var srcParts = playerHtml.split("<source")
        for (var si = 1; si < srcParts.length; si++) {
            var m = srcParts[si].match(/src="([^"]+)"/)
            if (m && !sources.some(function (x) { return x.url === m[1] })) {
                sources.push({ url: m[1], quality: "auto", type: m[1].indexOf(".m3u8") !== -1 ? "m3u8" : "mp4", subtitles: [] })
            }
        }

        var idx = 0
        while (true) {
            idx = playerHtml.indexOf("https://", idx)
            if (idx === -1) break
            var end = idx + 8
            while (end < playerHtml.length && playerHtml[end] !== '"' && playerHtml[end] !== "'" && playerHtml[end] !== " " && playerHtml[end] !== ">" && playerHtml[end] !== "\n" && playerHtml[end] !== "\r" && playerHtml[end] !== "\t") end++
            var url = playerHtml.substring(idx, end)
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
