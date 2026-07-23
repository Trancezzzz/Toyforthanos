/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {
    api = "https://api.kartoons.me/api"
    site = "https://kartoons.me"

    getSettings(): Settings {
        return {
            episodeServers: ["Kartoons"],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!opts.query.trim()) return []
        let q = encodeURIComponent(opts.query)
        let [showsRes, moviesRes] = await Promise.all([
            fetch(this.api + "/shows?search=" + q + "&limit=20"),
            fetch(this.api + "/movies?search=" + q + "&limit=20")
        ])
        let results: SearchResult[] = []
        if (showsRes.ok) {
            let body = showsRes.json()
            if (body.success) {
                for (let i = 0; i < body.data.length; i++) {
                    let item = body.data[i]
                    results.push({
                        id: item._id,
                        title: item.title,
                        url: this.site + "/show/" + item.slug,
                        subOrDub: "dub",
                    })
                }
            }
        }
        if (moviesRes.ok) {
            let body = moviesRes.json()
            if (body.success) {
                for (let i = 0; i < body.data.length; i++) {
                    let item = body.data[i]
                    results.push({
                        id: item._id,
                        title: item.title,
                        url: this.site + "/movie/" + item.slug,
                        subOrDub: "dub",
                    })
                }
            }
        }
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let episodes: EpisodeDetails[] = []
        let epNum = 1

        // Try as show first
        let showRes = await fetch(this.api + "/shows/" + id)
        if (showRes.ok) {
            let showBody = showRes.json()
            if (showBody.success && showBody.data && showBody.data.seasons) {
                let seasons = showBody.data.seasons
                for (let s = 0; s < seasons.length; s++) {
                    let epRes = await fetch(this.api + "/shows/" + id + "/season/" + seasons[s]._id + "/all-episodes")
                    if (!epRes.ok) continue
                    let epBody = epRes.json()
                    if (!epBody.success || !epBody.data) continue
                    for (let e = 0; e < epBody.data.length; e++) {
                        let ep = epBody.data[e]
                        episodes.push({
                            id: ep._id,
                            number: epNum++,
                            url: this.site + "/player?episodeId=" + ep._id,
                            title: ep.title || "Episode " + ep.episodeNumber,
                        })
                    }
                }
            }
            if (episodes.length > 0) return episodes
        }

        // Try as movie
        let movieRes = await fetch(this.api + "/movies/" + id)
        if (movieRes.ok) {
            let movieBody = movieRes.json()
            if (movieBody.success && movieBody.data) {
                episodes.push({
                    id: movieBody.data._id,
                    number: 1,
                    url: this.site + "/player?episodeId=" + movieBody.data._id,
                    title: movieBody.data.title || "Movie",
                })
                return episodes
            }
        }

        throw new Error("No episodes found")
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        // Try direct fetch to links API (Seanime may auto-bypass CF)
        let linksRes = await fetch(this.api + "/shows/episode/" + episode.id + "/links")
        if (linksRes.ok) {
            let body = linksRes.json()
            if (body.success && body.data) {
                let sources: VideoSource[] = []
                if (Array.isArray(body.data)) {
                    for (let i = 0; i < body.data.length; i++) {
                        let link = body.data[i]
                        let url = link.url || link
                        if (typeof url === "string") {
                            sources.push({
                                url: url,
                                type: url.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                                quality: link.label || link.quality || "auto",
                                subtitles: [],
                            })
                        }
                    }
                }
                if (sources.length > 0) {
                    return { server: "Kartoons", headers: { Referer: this.site + "/" }, videoSources: sources }
                }
            }
        }

        // Fallback: use ChromeDP to extract video from player page
        let browser = await ChromeDP.newBrowser({ headless: true, timeout: 60 })
        try {
            await browser.navigate(episode.url)
            await browser.sleep(5000)

            // Try to get video element source
            let videoSrc = await browser.evaluate(
                "(function(){let v=document.querySelector('video');return v?v.currentSrc||v.src:''})()"
            )
            if (videoSrc && videoSrc.length > 0 && videoSrc.indexOf("http") !== -1) {
                await browser.close()
                return {
                    server: "Kartoons",
                    headers: { Referer: this.site + "/" },
                    videoSources: [{
                        url: videoSrc,
                        type: videoSrc.indexOf(".m3u8") !== -1 ? "m3u8" : "mp4",
                        quality: "auto",
                        subtitles: [],
                    }]
                }
            }

            // Try iframe embeds
            let iframeSrc = await browser.evaluate(
                "(function(){let f=document.querySelector('iframe');return f?f.src:''})()"
            )
            if (iframeSrc && iframeSrc.length > 0 && iframeSrc.indexOf("http") !== -1) {
                await browser.close()
                return {
                    server: "Kartoons",
                    headers: { Referer: this.site + "/" },
                    videoSources: [{
                        url: iframeSrc,
                        type: "unknown",
                        quality: "auto",
                        subtitles: [],
                    }]
                }
            }

            // Try to extract from page source
            let html = await browser.outerHTML("body")
            await browser.close()

            // Look for m3u8 URLs
            let m3u8Rx = /https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/g
            let m3u8Match = m3u8Rx.exec(html)
            if (m3u8Match) {
                return {
                    server: "Kartoons",
                    headers: { Referer: this.site + "/" },
                    videoSources: [{
                        url: m3u8Match[0],
                        type: "m3u8",
                        quality: "auto",
                        subtitles: [],
                    }]
                }
            }
        } catch (e) {
            try { await browser.close() } catch (_) {}
        }

        throw new Error("Could not retrieve video sources")
    }
}
