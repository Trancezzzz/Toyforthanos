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
        if (!opts.query.trim()) return []

        let results = await this._searchQuery(opts.query)

        if (results.length === 0 && opts.media) {
            const titles = [
                opts.media.englishTitle,
                opts.media.romajiTitle,
                ...(opts.media.synonyms || []),
            ].filter(Boolean) as string[]

            for (const t of titles) {
                results = await this._searchQuery(t)
                if (results.length > 0) break
            }
        }

        return results
    }

    async _searchQuery(query: string): Promise<SearchResult[]> {
        const url = `${this.base}/search?keyword=${encodeURIComponent(query)}`
        const res = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) return []

        const html = await res.text()
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

        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const url = `${this.base}/play/${id}`
        const res = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`)

        const html = await res.text()
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

        if (episodes.length === 0) throw new Error("No episodes found.")
        episodes.sort((a, b) => a.number - b.number)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const serverName = "AnimeWorld"
        const episodeUrl = episode.url

        const res = await fetch(episodeUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: this.base,
            },
        })
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`)

        const html = await res.text()

        const csrfMatch = html.match(/window\.csrfToken\s*=\s*['"]([^'"]+)['"]/)
            || html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"[^>]*>/)
        if (!csrfMatch) throw new Error("CSRF token not found")
        const csrfToken = csrfMatch[1]

        const apiRes = await fetch(`${this.base}/api/episode/info`, {
            method: "POST",
            headers: {
                "CSRF-Token": csrfToken,
                "Content-Type": "application/json",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: episodeUrl,
                "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify({ id: episode.id, alt: "0" }),
        })
        if (!apiRes.ok) {
            const text = await apiRes.text()
            throw new Error(`API error ${apiRes.status}: ${text}`)
        }

        const apiData = (await apiRes.json()) as { target: string }
        if (!apiData.target) throw new Error("No video target found")

        const videoSources = await this._extractVideoSources(apiData.target, episodeUrl)

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
        const res = await fetch(playerUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Referer: referer,
            },
        })
        if (!res.ok) {
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
        const $ = LoadDoc(html)
        const sources: VideoSource[] = []

        $("video source").each((_, el) => {
            const src = $(el).attr("src")
            if (!src || sources.some((s) => s.url === src)) return
            sources.push({
                url: src,
                quality: "auto",
                type: src.includes(".m3u8") ? "m3u8" : "mp4",
                subtitles: [],
            })
        })

        $("video[data-setup]").each((_, el) => {
            const src = $(el).attr("src")
            if (!src || sources.some((s) => s.url === src)) return
            sources.push({
                url: src,
                quality: "auto",
                type: src.includes(".m3u8") ? "m3u8" : "mp4",
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
            sources.push({
                url: playerUrl,
                quality: "auto",
                type: "unknown",
                subtitles: [],
            })
        }

        return sources
    }
}
