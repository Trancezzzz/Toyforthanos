/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
    base = "https://www.animeworld.ac"

    getSettings(): Settings {
        console.log("[AnimeWorld] getSettings called")
        return {
            episodeServers: ["AnimeWorld"],
            supportsDub: false,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        console.log("[AnimeWorld] search called with query:", opts.query)
        if (!opts.query.trim()) return []

        const url = `${this.base}/search?keyword=${encodeURIComponent(opts.query)}`
        console.log("[AnimeWorld] search: fetching", url)

        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) {
            console.warn("[AnimeWorld] search: fetch failed", res.status)
            return []
        }

        const html = await res.text()
        console.log("[AnimeWorld] search: got HTML length", html.length)

        const results: SearchResult[] = []
        const itemRegex = /<div\s+class="item">[\s\S]*?<a\s+href="\/play\/([^"]+)"\s+class="poster"[\s\S]*?class="name">([^<]+)<\/a>/g
        let match
        while ((match = itemRegex.exec(html)) !== null) {
            const id = match[1].trim()
            const title = match[2].trim()
            if (id && title) {
                results.push({
                    id,
                    title,
                    url: `${this.base}/play/${id}`,
                    subOrDub: "sub",
                })
            }
        }

        console.log("[AnimeWorld] search: returning", results.length, "results")
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const url = `${this.base}/play/${id}`
        console.log("[AnimeWorld] findEpisodes called with id:", id, "url:", url)

        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) throw new Error(`[AnimeWorld] findEpisodes: fetch failed ${res.status}`)

        const html = await res.text()
        console.log("[AnimeWorld] findEpisodes: got HTML length", html.length)

        const episodes: EpisodeDetails[] = []
        const epRegex = /<a[^>]*?data-id="([^"]+)"[^>]*?data-episode-num="(\d+)"[^>]*?href="([^"]+)"[^>]*>(?:\s*)(\d+)(?:\s*)<\/a>/g
        let match
        while ((match = epRegex.exec(html)) !== null) {
            const epToken = match[1]
            const epNum = parseInt(match[2], 10)
            const epHref = match[3]
            if (!epToken || !Number.isInteger(epNum)) continue

            episodes.push({
                id: epToken,
                number: epNum,
                url: epHref.startsWith("http") ? epHref : `${this.base}${epHref.startsWith("/") ? "" : "/"}${epHref}`,
                title: `Episode ${epNum}`,
            })
        }

        if (episodes.length === 0) {
            console.error("[AnimeWorld] findEpisodes: no episodes found")
            throw new Error("No episodes found.")
        }

        episodes.sort((a, b) => a.number - b.number)
        console.log("[AnimeWorld] findEpisodes: returning", episodes.length, "episodes, range", episodes[0].number, "-", episodes[episodes.length - 1].number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const serverName = "AnimeWorld"
        console.log("[AnimeWorld] findEpisodeServer: id:", episode.id, "num:", episode.number, "url:", episode.url)

        const epPageUrl = episode.url
        console.log("[AnimeWorld] findEpisodeServer: fetching episode page for CSRF token")
        const res = await fetch(epPageUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) throw new Error(`[AnimeWorld] findEpisodeServer: page fetch failed ${res.status}`)

        const html = await res.text()
        console.log("[AnimeWorld] findEpisodeServer: got HTML length", html.length)

        const csrfMatch = html.match(/window\.csrfToken\s*=\s*['"]([^'"]+)['"]/)
            || html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"[^>]*>/)
        if (!csrfMatch) {
            console.error("[AnimeWorld] findEpisodeServer: CSRF token not found")
            throw new Error("CSRF token not found")
        }
        const csrfToken = csrfMatch[1]
        console.log("[AnimeWorld] findEpisodeServer: CSRF token:", csrfToken.substring(0, 10) + "...")

        const apiUrl = `${this.base}/api/episode/info`
        const apiBody = JSON.stringify({ id: episode.id, alt: "0" })
        console.log("[AnimeWorld] findEpisodeServer: POST", apiUrl, apiBody)

        const apiRes = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "CSRF-Token": csrfToken,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: epPageUrl,
                "X-Requested-With": "XMLHttpRequest",
            },
            body: apiBody,
        })
        if (!apiRes.ok) {
            const text = await apiRes.text()
            console.error("[AnimeWorld] findEpisodeServer: API error", apiRes.status, text)
            throw new Error(`API error ${apiRes.status}: ${text}`)
        }

        const apiData = JSON.parse(await apiRes.text()) as { target: string }
        console.log("[AnimeWorld] findEpisodeServer: API response target:", apiData.target)

        if (!apiData.target) throw new Error("No video target found")

        const videoSources = await this._extractVideoSources(apiData.target, epPageUrl)
        console.log("[AnimeWorld] findEpisodeServer: returning", videoSources.length, "sources")

        return {
            server: serverName,
            headers: {
                Referer: apiData.target,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            videoSources,
        }
    }

    async _extractVideoSources(playerUrl: string, referer: string): Promise<VideoSource[]> {
        console.log("[AnimeWorld] _extractVideoSources: fetching", playerUrl)
        const res = await fetch(playerUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: referer,
            },
        })
        if (!res.ok) {
            console.warn("[AnimeWorld] _extractVideoSources: fetch failed", res.status, "- returning player URL as unknown")
            return [{ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] }]
        }

        const html = await res.text()
        console.log("[AnimeWorld] _extractVideoSources: HTML length", html.length)

        const sources: VideoSource[] = []
        const subtitles: { id: string; url: string; language: string; isDefault: boolean }[] = []

        const videoRegex = /<video[^>]*>([\s\S]*?)<\/video>/i
        const videoMatch = html.match(videoRegex)
        if (videoMatch) {
            const videoBlock = videoMatch[1]
            const srcRegex = /<source[^>]*?src="([^"]+)"[^>]*>/g
            let m
            while ((m = srcRegex.exec(videoBlock)) !== null) {
                const src = m[1]
                const isM3u8 = src.includes(".m3u8")
                console.log("[AnimeWorld] _extractVideoSources: <source>", src)
                if (!sources.some((s) => s.url === src)) {
                    sources.push({ url: src, quality: "auto", type: isM3u8 ? "m3u8" : "mp4", subtitles: [] })
                }
            }

            const directSrcRegex = /<video[^>]*?src="([^"]+)"[^>]*>/i
            const directMatch = videoBlock.match(directSrcRegex) || html.match(/<video[^>]*?src="([^"]+)"[^>]*>/i)
            if (directMatch) {
                const src = directMatch[1]
                if (!sources.some((s) => s.url === src)) {
                    const isM3u8 = src.includes(".m3u8")
                    console.log("[AnimeWorld] _extractVideoSources: video[src]", src)
                    sources.push({ url: src, quality: "auto", type: isM3u8 ? "m3u8" : "mp4", subtitles: [] })
                }
            }

            const trackRegex = /<track[^>]*?src="([^"]+)"[^>]*?(?:srclang="([^"]*)")?[^>]*?(?:label="([^"]*)")?[^>]*?(default)?[^>]*>/g
            while ((m = trackRegex.exec(videoBlock)) !== null) {
                const trackSrc = m[1]
                const lang = m[3] || m[2] || "unknown"
                console.log("[AnimeWorld] _extractVideoSources: <track>", lang, trackSrc)
                subtitles.push({
                    id: lang,
                    url: trackSrc.startsWith("http") ? trackSrc : `${this.base}${trackSrc.startsWith("/") ? "" : "/"}${trackSrc}`,
                    language: lang,
                    isDefault: m[4] !== undefined,
                })
            }
        }

        const scriptUrlRegex = /https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/g
        let m
        while ((m = scriptUrlRegex.exec(html)) !== null) {
            if (!sources.some((s) => s.url === m[0])) {
                console.log("[AnimeWorld] _extractVideoSources: URL in HTML", m[0])
                sources.push({ url: m[0], quality: "auto", type: m[0].includes(".m3u8") ? "m3u8" : "mp4", subtitles: [] })
            }
        }

        if (sources.length > 0 && subtitles.length > 0) {
            sources[0].subtitles = subtitles
        }

        if (sources.length === 0) {
            console.warn("[AnimeWorld] _extractVideoSources: no sources found, returning player URL as unknown")
            sources.push({ url: playerUrl, quality: "auto", type: "unknown", subtitles: [] })
        }

        return sources
    }
}
