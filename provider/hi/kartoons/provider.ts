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
        console.log("[Kartoons] search query:", opts.query)
        let [showsRes, moviesRes] = await Promise.all([
            fetch(this.api + "/shows?search=" + q + "&limit=20"),
            fetch(this.api + "/movies?search=" + q + "&limit=20")
        ])
        console.log("[Kartoons] search shows status:", showsRes.status, "movies status:", moviesRes.status)
        let results: SearchResult[] = []
        if (showsRes.ok) {
            let body = showsRes.json()
            if (body.success) {
                console.log("[Kartoons] search shows found:", body.data.length)
                for (let i = 0; i < body.data.length; i++) {
                    let item = body.data[i]
                    results.push({
                        id: item._id,
                        title: item.title,
                        url: this.site + "/show/" + item.slug,
                        subOrDub: "dub",
                    })
                }
            } else {
                console.log("[Kartoons] search shows success false, body:", JSON.stringify(body))
            }
        } else {
            console.log("[Kartoons] search shows not ok, status:", showsRes.status)
        }
        if (moviesRes.ok) {
            let body = moviesRes.json()
            if (body.success) {
                console.log("[Kartoons] search movies found:", body.data.length)
                for (let i = 0; i < body.data.length; i++) {
                    let item = body.data[i]
                    results.push({
                        id: item._id,
                        title: item.title,
                        url: this.site + "/movie/" + item.slug,
                        subOrDub: "dub",
                    })
                }
            } else {
                console.log("[Kartoons] search movies success false, body:", JSON.stringify(body))
            }
        } else {
            console.log("[Kartoons] search movies not ok, status:", moviesRes.status)
        }
        console.log("[Kartoons] search total results:", results.length)
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let episodes: EpisodeDetails[] = []
        let epNum = 1
        console.log("[Kartoons] findEpisodes id:", id)

        let showRes = await fetch(this.api + "/shows/" + id)
        console.log("[Kartoons] show detail status:", showRes.status)
        if (showRes.ok) {
            let showBody = showRes.json()
            if (showBody.success && showBody.data && showBody.data.seasons) {
                let seasons = showBody.data.seasons
                console.log("[Kartoons] show has", seasons.length, "seasons")
                for (let s = 0; s < seasons.length; s++) {
                    console.log("[Kartoons] fetching season", seasons[s]._id)
                    let epRes = await fetch(this.api + "/shows/" + id + "/season/" + seasons[s]._id + "/all-episodes")
                    if (!epRes.ok) {
                        console.log("[Kartoons] season episodes not ok, status:", epRes.status)
                        continue
                    }
                    let epBody = epRes.json()
                    if (!epBody.success || !epBody.data) {
                        console.log("[Kartoons] season episodes success false or no data")
                        continue
                    }
                    console.log("[Kartoons] season has", epBody.data.length, "episodes")
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
            } else {
                console.log("[Kartoons] show detail not a show or no seasons, body.success:", showBody.success)
            }
            if (episodes.length > 0) {
                console.log("[Kartoons] found", episodes.length, "episodes via show")
                return episodes
            }
        } else {
            console.log("[Kartoons] show detail failed, trying as movie")
        }

        console.log("[Kartoons] trying as movie")
        let movieRes = await fetch(this.api + "/movies/" + id)
        console.log("[Kartoons] movie detail status:", movieRes.status)
        if (movieRes.ok) {
            let movieBody = movieRes.json()
            if (movieBody.success && movieBody.data) {
                console.log("[Kartoons] found movie:", movieBody.data.title)
                episodes.push({
                    id: movieBody.data._id,
                    number: 1,
                    url: this.site + "/player?episodeId=" + movieBody.data._id,
                    title: movieBody.data.title || "Movie",
                })
                return episodes
            }
        }

        console.log("[Kartoons] no episodes found for id:", id)
        throw new Error("No episodes found")
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("[Kartoons] findEpisodeServer episode:", episode.id, "server:", _server)

        let linksRes = await fetch(this.api + "/shows/episode/" + episode.id + "/links")
        console.log("[Kartoons] direct links fetch status:", linksRes.status)
        if (linksRes.ok) {
            let body = linksRes.json()
            console.log("[Kartoons] links body success:", body.success, "has data:", !!body.data)
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
                console.log("[Kartoons] direct links yielded", sources.length, "sources")
                if (sources.length > 0) {
                    return { server: "Kartoons", headers: { Referer: this.site + "/" }, videoSources: sources }
                }
            }
        } else {
            let bodyText = await linksRes.text()
            console.log("[Kartoons] direct links failed, body:", bodyText.substring(0, 200))
        }

        console.log("[Kartoons] falling back to ChromeDP player page scraping")
        let browser = await ChromeDP.newBrowser({ headless: true, timeout: 60 })
        try {
            console.log("[Kartoons] navigating to player page:", episode.url)
            await browser.navigate(episode.url)
            await browser.sleep(5000)

            console.log("[Kartoons] looking for video element")
            let videoSrc = await browser.evaluate(
                "(function(){let v=document.querySelector('video');return v?v.currentSrc||v.src:''})()"
            )
            console.log("[Kartoons] video element src:", videoSrc ? videoSrc.substring(0, 100) : "none")
            if (videoSrc && videoSrc.length > 0 && videoSrc.indexOf("http") !== -1) {
                await browser.close()
                console.log("[Kartoons] found video source via ChromeDP")
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

            console.log("[Kartoons] looking for iframe")
            let iframeSrc = await browser.evaluate(
                "(function(){let f=document.querySelector('iframe');return f?f.src:''})()"
            )
            console.log("[Kartoons] iframe src:", iframeSrc ? iframeSrc.substring(0, 100) : "none")
            if (iframeSrc && iframeSrc.length > 0 && iframeSrc.indexOf("http") !== -1) {
                await browser.close()
                console.log("[Kartoons] found iframe source via ChromeDP")
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

            console.log("[Kartoons] extracting page HTML for m3u8 search")
            let html = await browser.outerHTML("body")
            console.log("[Kartoons] body HTML length:", html.length)
            await browser.close()

            let m3u8Rx = /https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/g
            let m3u8Match = m3u8Rx.exec(html)
            console.log("[Kartoons] m3u8 regex match:", m3u8Match ? m3u8Match[0].substring(0, 100) : "none")
            if (m3u8Match) {
                console.log("[Kartoons] found m3u8 URL in HTML")
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
            console.log("[Kartoons] ChromeDP error:", e)
            try { await browser.close() } catch (_) {}
        }

        console.log("[Kartoons] all methods exhausted, throwing")
        throw new Error("Could not retrieve video sources")
    }
}
