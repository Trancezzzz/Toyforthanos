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
        console.log("[AnimeWorld] _extractVideoSources:", playerUrl.substring(0, 60))
        const res = await fetch(playerUrl, {
            headers: { "User-Agent": "Mozilla/5.0", Referer: referer },
        })
        if (!res.ok) {
            return [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }]
        }

        const html = await res.text()
        console.log("[AnimeWorld] player HTML:", html.length, "bytes")

        const sources: VideoSource[] = []
        const subs: { id: string; url: string; language: string; isDefault: boolean }[] = []

        const videoStart = html.indexOf("<video")
        if (videoStart !== -1) {
            const videoEnd = html.indexOf("</video>", videoStart)
            const vblock = videoEnd !== -1 ? html.substring(videoStart, videoEnd + 8) : html.substring(videoStart, videoStart + 5000)

            const srcParts = vblock.split('<source')
            for (let s = 1; s < srcParts.length; s++) {
                const srcM = srcParts[s].match(/src="([^"]+)"/)
                if (srcM && !sources.some(function (x) { return x.url === srcM[1] })) {
                    sources.push({
                        url: srcM[1],
                        quality: "auto",
                        type: srcM[1].indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                        subtitles: [],
                    })
                }
            }

            const directM = vblock.match(/<video[^>]*src="([^"]+)"/)
            if (directM && !sources.some(function (x) { return x.url === directM[1] })) {
                sources.push({
                    url: directM[1],
                    quality: "auto",
                    type: directM[1].indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                    subtitles: [],
                })
            }

            const trackParts = vblock.split("<track")
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

        const urlParts = html.split(/https?:\/\//)
        for (let u = 0; u < urlParts.length; u++) {
            const m = urlParts[u].match(/^[^"'\s<>]+\.(m3u8|mp4)[^"'\s<>]*/)
            if (m && !sources.some(function (x) { return x.url === "https://" + m[0] })) {
                sources.push({
                    url: "https://" + m[0],
                    quality: "auto",
                    type: m[1] === "m3u8" ? "m3u8" : "mp4",
                    subtitles: [],
                })
            }
        }

        if (sources.length > 0 && subs.length > 0) {
            sources[0].subtitles = subs
        }

        if (sources.length === 0) {
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        console.log("[AnimeWorld] sources:", sources.length)
        return sources
    }
}
