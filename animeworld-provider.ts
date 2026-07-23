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
        console.log("[AnimeWorld] findEpisodeServer id:", episode.id, "num:", episode.number, "url:", episode.url)

        console.log("[AnimeWorld] fetching episode page for CSRF")
        const res = await fetch(episode.url, { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("page fetch failed " + res.status)

        const html = await res.text()
        console.log("[AnimeWorld] page HTML length:", html.length)

        const csrfM = html.match(/window\.csrfToken\s*=\s*['"]([^'"]+)['"]/) || html.match(/csrf-token[^>]+content="([^"]+)"/)
        if (!csrfM) throw new Error("CSRF token not found")
        const csrfToken = csrfM[1]
        console.log("[AnimeWorld] CSRF:", csrfToken.substring(0, 10) + "...")

        const apiRes = await fetch(this.base + "/api/episode/info", {
            method: "POST",
            headers: {
                "CSRF-Token": csrfToken,
                "Content-Type": "application/json",
                "User-Agent": this.UA,
                Referer: episode.url,
                "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify({ id: episode.id, alt: "0" }),
        })
        if (!apiRes.ok) throw new Error("API error " + apiRes.status + " " + (await apiRes.text()))

        const apiData = JSON.parse(await apiRes.text())
        const target = apiData.target || ""
        console.log("[AnimeWorld] API target:", target.substring(0, 80))

        if (!target) throw new Error("No video target")

        if (target.indexOf(".mp4") !== -1 || target.indexOf(".m3u8") !== -1) {
            console.log("[AnimeWorld] target is direct video URL")
            return {
                server: "AnimeWorld",
                headers: this._headers(target),
                videoSources: [{ url: target, quality: "auto", type: target.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4", subtitles: [] }],
            }
        }

        const videoSources = await this._extractVideoSources(target, episode.url)
        console.log("[AnimeWorld] returning sources:", videoSources.length)

        return {
            server: "AnimeWorld",
            headers: this._headers(target),
            videoSources,
        }
    }

    async _extractVideoSources(playerUrl: string, referer: string): Promise<VideoSource[]> {
        console.log("[AnimeWorld] _extractVideoSources:", playerUrl.substring(0, 80))
        const res = await fetch(playerUrl, { headers: this._headers(referer) })
        if (!res.ok) {
            console.log("[AnimeWorld] player fetch failed", res.status)
            return [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }]
        }

        const html = await res.text()
        console.log("[AnimeWorld] player HTML:", html.length, "bytes")
        console.log("[AnimeWorld] player HTML first 500:", html.substring(0, 500))

        const sources: VideoSource[] = []
        const subs: { id: string; url: string; language: string; isDefault: boolean }[] = []

        const srcParts = html.split("<source")
        console.log("[AnimeWorld] <source> count:", srcParts.length - 1)
        for (let s = 1; s < srcParts.length; s++) {
            const srcM = srcParts[s].match(/src="([^"]+)"/)
            if (srcM && !sources.some(function (x) { return x.url === srcM[1] })) {
                const url = srcM[1]
                console.log("[AnimeWorld] found <source>:", url.substring(0, 80))
                sources.push({ url: url, quality: "auto", type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4", subtitles: [] })
            }
        }

        const scriptParts = html.split("<script")
        for (let c = 1; c < scriptParts.length; c++) {
            const js = scriptParts[c].indexOf("</script>") !== -1 ? scriptParts[c].substring(0, scriptParts[c].indexOf("</script>")) : scriptParts[c]
            var idx = 0
            while (true) {
                idx = js.indexOf("https://", idx)
                if (idx === -1) break
                var end = idx + 8
                while (end < js.length && js[end] !== '"' && js[end] !== "'" && js[end] !== " " && js[end] !== ">" && js[end] !== "\n" && js[end] !== "\r" && js[end] !== "\t") end++
                var url = js.substring(idx, end)
                if ((url.indexOf(".mp4") !== -1 || url.indexOf(".m3u8") !== -1) && !sources.some(function (x) { return x.url === url })) {
                    sources.push({ url: url, quality: "auto", type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4", subtitles: [] })
                }
                idx = end
            }
        }

        var idx = 0
        while (true) {
            idx = html.indexOf("https://", idx)
            if (idx === -1) break
            var end = idx + 8
            while (end < html.length && html[end] !== '"' && html[end] !== "'" && html[end] !== " " && html[end] !== ">" && html[end] !== "\n" && html[end] !== "\r" && html[end] !== "\t") end++
            var url = html.substring(idx, end)
            if ((url.indexOf(".mp4") !== -1 || url.indexOf(".m3u8") !== -1) && !sources.some(function (x) { return x.url === url })) {
                sources.push({ url: url, quality: "auto", type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4", subtitles: [] })
            }
            idx = end
        }

        if (sources.length > 0 && subs.length > 0) sources[0].subtitles = subs
        if (sources.length === 0) {
            console.log("[AnimeWorld] no sources, returning player URL directly")
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }
        console.log("[AnimeWorld] sources:", sources.length)
        return sources
    }
}
