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
        if (!opts.query.trim()) {
            console.warn("[AnimeWorld] search: empty query")
            return []
        }

        let results = await this._searchQuery(opts.query)
        console.log("[AnimeWorld] search: initial query returned", results.length, "results")

        if (results.length === 0 && opts.media) {
            const titles = [
                opts.media.englishTitle,
                opts.media.romajiTitle,
                ...(opts.media.synonyms || []),
            ].filter(Boolean) as string[]
            console.log("[AnimeWorld] search: trying fallback titles:", titles)

            for (const t of titles) {
                results = await this._searchQuery(t)
                console.log("[AnimeWorld] search: fallback '" + t + "' returned", results.length, "results")
                if (results.length > 0) break
            }
        }

        console.log("[AnimeWorld] search: returning", results.length, "results")
        return results
    }

    async _searchQuery(query: string): Promise<SearchResult[]> {
        const url = `${this.base}/search?keyword=${encodeURIComponent(query)}`
        console.log("[AnimeWorld] _searchQuery: fetching", url)
        const res = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) {
            console.warn("[AnimeWorld] _searchQuery: fetch failed with status", res.status)
            return []
        }

        const html = await res.text()
        console.log("[AnimeWorld] _searchQuery: got HTML length", html.length)
        const $ = LoadDoc(html)

        const results: SearchResult[] = []
        $(".film-list .item").each((_, el) => {
            const link = $(el).find(".inner a.poster").attr("href")
            const title = $(el).find(".inner a.name").text().trim()
            if (!link || !title) return

            const match = link.match(/^\/play\/(.+)$/)
            if (!match) return

            results.push({
                id: match[1],
                title,
                url: `${this.base}/play/${match[1]}`,
                subOrDub: "sub",
            })
        })

        console.log("[AnimeWorld] _searchQuery: parsed", results.length, "results from HTML")
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const url = `${this.base}/play/${id}`
        console.log("[AnimeWorld] findEpisodes called with id:", id)
        console.log("[AnimeWorld] findEpisodes: fetching", url)
        const res = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) throw new Error(`[AnimeWorld] findEpisodes: fetch failed with status ${res.status}`)

        const html = await res.text()
        console.log("[AnimeWorld] findEpisodes: got HTML length", html.length)

        const $ = LoadDoc(html)

        const episodes: EpisodeDetails[] = []
        $(".server.active ul.episodes.range li a").each((_, el) => {
            const $el = $(el)
            const epToken = $el.attr("data-id")
            const epNum = $el.attr("data-episode-num")
            const epHref = $el.attr("href")
            if (!epToken || !epNum) return

            const num = parseInt(epNum, 10)
            if (!Number.isInteger(num)) return

            episodes.push({
                id: epToken,
                number: num,
                url: epHref ? `${this.base}${epHref.startsWith("/") ? "" : "/"}${epHref}` : url,
                title: `Episode ${num}`,
            })
        })

        if (episodes.length === 0) {
            console.error("[AnimeWorld] findEpisodes: no episodes found on page")
            throw new Error("No episodes found.")
        }

        episodes.sort((a, b) => a.number - b.number)
        console.log("[AnimeWorld] findEpisodes: returning", episodes.length, "episodes, range", episodes[0].number, "-", episodes[episodes.length - 1].number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const serverName = "AnimeWorld"
        const episodeUrl = episode.url
        console.log("[AnimeWorld] findEpisodeServer called")
        console.log("[AnimeWorld] findEpisodeServer: episode id:", episode.id, "number:", episode.number)
        console.log("[AnimeWorld] findEpisodeServer: episode url:", episodeUrl)
        console.log("[AnimeWorld] findEpisodeServer: server:", _server)

        console.log("[AnimeWorld] findEpisodeServer: fetching episode page for CSRF token")
        const res = await fetch(episodeUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) throw new Error(`[AnimeWorld] findEpisodeServer: page fetch failed with status ${res.status}`)

        const html = await res.text()
        console.log("[AnimeWorld] findEpisodeServer: got HTML length", html.length)

        const csrfMatch = html.match(/window\.csrfToken\s*=\s*['"]([^'"]+)['"]/)
            || html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"[^>]*>/)
        if (!csrfMatch) {
            console.error("[AnimeWorld] findEpisodeServer: CSRF token not found in page")
            throw new Error("CSRF token not found")
        }
        const csrfToken = csrfMatch[1]
        console.log("[AnimeWorld] findEpisodeServer: found CSRF token:", csrfToken.substring(0, 10) + "...")

        const apiUrl = `${this.base}/api/episode/info`
        const apiBody = JSON.stringify({ id: episode.id, alt: "0" })
        console.log("[AnimeWorld] findEpisodeServer: POSTing to", apiUrl)
        console.log("[AnimeWorld] findEpisodeServer: request body:", apiBody)

        const apiRes = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "CSRF-Token": csrfToken,
                "Content-Type": "application/json",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: episodeUrl,
                "X-Requested-With": "XMLHttpRequest",
            },
            body: apiBody,
        })
        if (!apiRes.ok) {
            const text = await apiRes.text()
            console.error("[AnimeWorld] findEpisodeServer: API returned", apiRes.status, text)
            throw new Error(`API error ${apiRes.status}: ${text}`)
        }

        const apiData = JSON.parse(await apiRes.text()) as { target: string }
        console.log("[AnimeWorld] findEpisodeServer: API response:", JSON.stringify(apiData))

        if (!apiData.target) {
            console.error("[AnimeWorld] findEpisodeServer: no target field in API response")
            throw new Error("No video target found")
        }
        console.log("[AnimeWorld] findEpisodeServer: got player URL:", apiData.target)

        const videoSources = await this._extractVideoSources(apiData.target, episodeUrl)
        console.log("[AnimeWorld] findEpisodeServer: extracted", videoSources.length, "video sources")

        return {
            server: serverName,
            headers: {
                Referer: apiData.target,
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            videoSources,
        }
    }

    async _extractVideoSources(playerUrl: string, referer: string): Promise<VideoSource[]> {
        console.log("[AnimeWorld] _extractVideoSources: fetching player URL:", playerUrl)
        const res = await fetch(playerUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: referer,
            },
        })
        if (!res.ok) {
            console.warn("[AnimeWorld] _extractVideoSources: player fetch failed with status", res.status, "- returning player URL as unknown source")
            return [
                {
                    url: playerUrl,
                    quality: "auto",
                    type: "unknown",
                    subtitles: [],
                },
            ]
        }

        const html = await res.text()
        console.log("[AnimeWorld] _extractVideoSources: got player HTML length", html.length)
        const $ = LoadDoc(html)
        const sources: VideoSource[] = []

        $("video source").each((_, el) => {
            const src = $(el).attr("src")
            if (!src || sources.some((s) => s.url === src)) return
            const type = src.includes(".m3u8") ? "m3u8" : "mp4"
            console.log("[AnimeWorld] _extractVideoSources: found <video source>", type, src)
            sources.push({
                url: src,
                quality: "auto",
                type,
                subtitles: [],
            })
        })

        $("video[data-setup]").each((_, el) => {
            const src = $(el).attr("src")
            if (!src || sources.some((s) => s.url === src)) return
            const type = src.includes(".m3u8") ? "m3u8" : "mp4"
            console.log("[AnimeWorld] _extractVideoSources: found video[data-setup] src", type, src)
            sources.push({
                url: src,
                quality: "auto",
                type,
                subtitles: [],
            })
        })

        $("script").each((_, el) => {
            const text = $(el).text()
            if (!text) return

            const urlRegex = /https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/g
            let m
            while ((m = urlRegex.exec(text)) !== null) {
                if (!sources.some((s) => s.url === m[0])) {
                    console.log("[AnimeWorld] _extractVideoSources: found URL in script:", m[0])
                    sources.push({
                        url: m[0],
                        quality: "auto",
                        type: m[0].includes(".m3u8") ? "m3u8" : "mp4",
                        subtitles: [],
                    })
                }
            }

            const configRegex = /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/g
            while ((m = configRegex.exec(text)) !== null) {
                const url = m[1]
                if (!sources.some((s) => s.url === url)) {
                    console.log("[AnimeWorld] _extractVideoSources: found URL in script config:", url)
                    sources.push({
                        url,
                        quality: "auto",
                        type: url.includes(".m3u8") ? "m3u8" : "mp4",
                        subtitles: [],
                    })
                }
            }
        })

        $("track").each((_, el) => {
            const src = $(el).attr("src")
            const lang = $(el).attr("srclang") || $(el).attr("label") || "unknown"
            if (!src || sources.length === 0) return

            console.log("[AnimeWorld] _extractVideoSources: found subtitle track, lang:", lang)
            sources[0].subtitles.push({
                id: lang,
                url: src.startsWith("http")
                    ? src
                    : `${this.base}${src.startsWith("/") ? "" : "/"}${src}`,
                language: lang,
                isDefault: $(el).attr("default") !== undefined,
            })
        })

        if (sources.length === 0) {
            console.warn("[AnimeWorld] _extractVideoSources: no video sources found, returning player URL as unknown")
            sources.push({
                url: playerUrl,
                quality: "auto",
                type: "unknown",
                subtitles: [],
            })
        }

        console.log("[AnimeWorld] _extractVideoSources: returning", sources.length, "sources")
        return sources
    }
}
