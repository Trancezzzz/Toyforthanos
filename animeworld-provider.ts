/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
    base = "https://www.animeworld.ac"

    getSettings(): Settings {
        return {
            episodeServers: ["AnimeWorld"],
            supportsDub: false,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        console.log("[AnimeWorld] search:", opts.query)
        if (!opts.query.trim()) return []

        const url = this.base + "/search?keyword=" + encodeURIComponent(opts.query)
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: this.base },
        })
        if (!res.ok) return []

        const html = await res.text()
        const results: SearchResult[] = []
        const parts = html.split('<div class="item">')
        for (let i = 1; i < parts.length; i++) {
            const block = parts[i]
            const linkM = block.match(/href="\/play\/([^"]+)"/)
            const titleM = block.match(/class="name"[^>]*>([^<]+)</)
            if (linkM && titleM) {
                results.push({
                    id: linkM[1],
                    title: titleM[1],
                    url: this.base + "/play/" + linkM[1],
                    subOrDub: "sub",
                })
            }
        }

        console.log("[AnimeWorld] search:", results.length, "results")
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const url = this.base + "/play/" + id
        console.log("[AnimeWorld] findEpisodes:", id)

        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: this.base },
        })
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)

        const html = await res.text()
        const episodes: EpisodeDetails[] = []
        const parts = html.split('<li class="episode">')
        for (let i = 1; i < parts.length; i++) {
            const block = parts[i]
            const idM = block.match(/data-id="([^"]+)"/)
            const numM = block.match(/data-episode-num="(\d+)"/)
            const hrefM = block.match(/href="([^"]+)"/)
            if (idM && numM) {
                const num = parseInt(numM[1], 10)
                const epHref = hrefM ? hrefM[1] : ""
                episodes.push({
                    id: idM[1],
                    number: num,
                    url: epHref ? (epHref.indexOf("http") === 0 ? epHref : this.base + (epHref[0] === "/" ? "" : "/") + epHref) : url,
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
        console.log("[AnimeWorld] findEpisodeServer:", episode.id, "num:", episode.number)

        const res = await fetch(episode.url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: this.base },
        })
        if (!res.ok) throw new Error("page fetch failed " + res.status)

        const html = await res.text()
        const csrfM = html.match(/window\.csrfToken\s*=\s*['"]([^'"]+)['"]/)
            || html.match(/csrf-token[^>]+content="([^"]+)"/)
        if (!csrfM) throw new Error("CSRF token not found")
        const csrfToken = csrfM[1]

        const apiRes = await fetch(this.base + "/api/episode/info", {
            method: "POST",
            headers: {
                "CSRF-Token": csrfToken,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                Referer: episode.url,
                "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify({ id: episode.id, alt: "0" }),
        })
        if (!apiRes.ok) throw new Error("API error " + apiRes.status + " " + (await apiRes.text()))

        const apiData = JSON.parse(await apiRes.text())
        console.log("[AnimeWorld] API target:", apiData.target ? apiData.target.substring(0, 60) : "NONE")
        if (!apiData.target) throw new Error("No video target")

        const videoSources = await this._extractVideoSources(apiData.target, episode.url)

        return {
            server: "AnimeWorld",
            headers: { Referer: apiData.target, "User-Agent": "Mozilla/5.0" },
            videoSources,
        }
    }

    async _extractVideoSources(playerUrl: string, referer: string): Promise<VideoSource[]> {
        console.log("[AnimeWorld] _extractVideoSources:", playerUrl.substring(0, 80))
        const res = await fetch(playerUrl, {
            headers: { "User-Agent": "Mozilla/5.0", Referer: referer },
        })
        if (!res.ok) {
            return [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }]
        }

        const html = await res.text()
        console.log("[AnimeWorld] player HTML:", html.length, "bytes, first 300:", html.substring(0, 300))

        const sources: VideoSource[] = []
        const subs: { id: string; url: string; language: string; isDefault: boolean }[] = []

        const sourceParts = html.split("<source")
        console.log("[AnimeWorld] <source> tags found:", sourceParts.length - 1)
        for (let s = 1; s < sourceParts.length; s++) {
            const srcM = sourceParts[s].match(/src="([^"]+)"/)
            if (srcM && !sources.some(function (x) { return x.url === srcM[1] })) {
                const url = srcM[1]
                console.log("[AnimeWorld] found <source> src:", url.substring(0, 80))
                sources.push({
                    url: url,
                    quality: "auto",
                    type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                    subtitles: [],
                })
            }
        }

        const videoParts = html.split("<video")
        for (let v = 1; v < videoParts.length; v++) {
            const srcM = videoParts[v].match(/src="([^"]+)"/)
            if (srcM && !sources.some(function (x) { return x.url === srcM[1] })) {
                const url = srcM[1]
                console.log("[AnimeWorld] found <video src>:", url.substring(0, 80))
                sources.push({
                    url: url,
                    quality: "auto",
                    type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                    subtitles: [],
                })
            }

            const trackParts = videoParts[v].split("<track")
            for (let t = 1; t < trackParts.length; t++) {
                const srcM = trackParts[t].match(/src="([^"]+)"/)
                const langM = trackParts[t].match(/label="([^"]*)"/) || trackParts[t].match(/srclang="([^"]*)"/)
                if (srcM) {
                    subs.push({
                        id: langM ? langM[1] : "unknown",
                        url: srcM[1].indexOf("http") === 0 ? srcM[1] : this.base + (srcM[1][0] === "/" ? "" : "/") + srcM[1],
                        language: langM ? langM[1] : "unknown",
                        isDefault: trackParts[t].indexOf("default") !== -1,
                    })
                }
            }
        }

        const scriptParts = html.split("<script")
        for (let c = 1; c < scriptParts.length; c++) {
            const scriptBody = scriptParts[c]
            const closeTag = scriptBody.indexOf("</script>")
            const js = closeTag !== -1 ? scriptBody.substring(0, closeTag) : scriptBody

            var idx = 0
            while (true) {
                idx = js.indexOf("https://", idx)
                if (idx === -1) break
                var end = idx + 8
                while (end < js.length && js[end] !== '"' && js[end] !== "'" && js[end] !== " " && js[end] !== ">" && js[end] !== "\n" && js[end] !== "\r" && js[end] !== "\t") end++
                var url = js.substring(idx, end)
                if ((url.indexOf(".mp4") !== -1 || url.indexOf(".m3u8") !== -1) && !sources.some(function (x) { return x.url === url })) {
                    console.log("[AnimeWorld] URL in script:", url.substring(0, 80))
                    sources.push({
                        url: url,
                        quality: "auto",
                        type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                        subtitles: [],
                    })
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
                console.log("[AnimeWorld] URL in HTML:", url.substring(0, 80))
                sources.push({
                    url: url,
                    quality: "auto",
                    type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                    subtitles: [],
                })
            }
            idx = end
        }

        if (sources.length > 0 && subs.length > 0) {
            sources[0].subtitles = subs
        }

        if (sources.length === 0) {
            console.log("[AnimeWorld] no sources found, returning iframe URL directly")
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        console.log("[AnimeWorld] sources:", sources.length)
        return sources
    }
}
