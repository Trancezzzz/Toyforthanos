/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {
    api = "https://api.kartoons.me/api"
    site = "https://kartoons.me"
    sitekey = "0x4AAAAAACnvUm93__ifaEkF"

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

    async _fetchLinks(episodeId: string, token?: string): Promise<any> {
        let opts: any = { timeout: 30 }
        if (token) {
            opts.headers = {
                "X-Challenge-Token": token,
                "X-Challenge-Retry": "true",
            }
        }
        let res = await fetch(this.api + "/shows/episode/" + episodeId + "/links", opts)
        if (!res.ok) {
            let text = await res.text()
            console.log("[Kartoons] _fetchLinks status:", res.status, "body:", text.substring(0, 150))
            return null
        }
        return res.json()
    }

    _stealthJs = `
(function() {
    var p = Object.getOwnPropertyDescriptor(navigator.constructor.prototype, 'webdriver');
    if (p && p.configurable) {
        Object.defineProperty(navigator, 'webdriver', { get: function() { return false } });
    }
    var pl = navigator.plugins;
    if (pl && pl.length === 0) {
        Object.defineProperty(navigator, 'plugins', { get: function() { return [1, 2, 3, 4, 5] } });
    }
    if (!window.chrome || !window.chrome.runtime) {
        window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
    }
    try {
        var f = Object.defineProperty;
        f(navigator, 'hardwareConcurrency', { get: function() { return 8 } });
    } catch(e) {}
})();
`

    async _extractFromChromeDP(playerUrl: string): Promise<EpisodeServer> {
        console.log("[Kartoons] launching ChromeDP for player page at:", playerUrl)
        let browser
        try {
            browser = await ChromeDP.newBrowser({
                headless: false,
                timeout: 180,
                args: [
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-gpu",
                    "--disable-dev-shm-usage",
                    "--exclude-switches=enable-automation",
                    "--window-size=1920,1080",
                ],
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                viewport: { width: 1920, height: 1080 },
            })
            console.log("[Kartoons] browser launched with stealth config")
        } catch (e) {
            console.log("[Kartoons] failed to launch ChromeDP browser:", e)
            throw new Error("ChromeDP browser launch failed: " + e)
        }

        try {
            console.log("[Kartoons] injecting stealth patches before navigation...")
            await browser.navigate("about:blank")
            await browser.evaluate(this._stealthJs)
            await browser.navigate(playerUrl)
            console.log("[Kartoons] page loaded, waiting for React SPA to render...")
            await browser.sleep(8000)

            let deadline = Date.now() + 90000
            let pollCount = 0
            while (Date.now() < deadline) {
                pollCount++
                let result = await browser.evaluate(`(() => {
                    var v = document.querySelector('video');
                    if (v && v.readyState > 0) {
                        return { found: true, type: 'video', url: v.currentSrc || v.src || '' };
                    }
                    var f = document.querySelector('iframe');
                    if (f && f.src && f.src.indexOf('http') === 0) {
                        return { found: true, type: 'iframe', url: f.src };
                    }
                    var html = document.body ? document.body.innerHTML : '';
                    var m3u = html.match(/https?:\\\/\\\/[^'"\\s<>]+\\.m3u8[^'"\\s<>]*/);
                    if (m3u) {
                        return { found: true, type: 'm3u8', url: m3u[0] };
                    }
                    var mp4 = html.match(/https?:\\\/\\\/[^'"\\s<>]+\\.mp4[^'"\\s<>]*/);
                    if (mp4) {
                        return { found: true, type: 'mp4', url: mp4[0] };
                    }
                    var turnstileIframe = document.querySelector('iframe[src*="challenges"], iframe[src*="turnstile"], iframe[src*="cf-turnstile"]');
                    var w = navigator.webdriver;
                    return { found: false, hasTurnstile: !!turnstileIframe, webdriver: w, videoCount: document.querySelectorAll('video').length, iframeCount: document.querySelectorAll('iframe').length };
                })()`)

                if (result && result.found) {
                    console.log("[Kartoons] ChromeDP extracted source type:", result.type, "url:", (result.url || "").substring(0, 80))
                    try { await browser.close() } catch (_) {}
                    let sourceType = result.type === "video" || result.type === "mp4" ? "mp4" : "m3u8"
                    return {
                        server: "Kartoons",
                        headers: { Referer: this.site + "/" },
                        videoSources: [{
                            url: result.url,
                            type: sourceType,
                            quality: "auto",
                            subtitles: [],
                        }]
                    }
                }

                console.log("[Kartoons] poll", pollCount, "- no source yet, hasTurnstile:", result && result.hasTurnstile, "webdriver:", result && result.webdriver, "videos:", result && result.videoCount, "iframes:", result && result.iframeCount)
                await browser.sleep(3000)
            }

            console.log("[Kartoons] ChromeDP polling timed out after 90s")
            try { await browser.close() } catch (_) {}
        } catch (e) {
            console.log("[Kartoons] ChromeDP navigation or polling error:", e)
            try { await browser.close() } catch (_) {}
        }
        throw new Error("Could not retrieve video sources from ChromeDP")
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("[Kartoons] findEpisodeServer episode:", episode.id, "server:", _server)

        let data = await this._fetchLinks(episode.id)
        if (data && data.success && data.data) {
            console.log("[Kartoons] direct fetch succeeded")
            return this._buildEpisodeServer(data.data)
        }

        console.log("[Kartoons] direct fetch blocked, launching ChromeDP to player page")
        return await this._extractFromChromeDP(episode.url)
    }

    _buildEpisodeServer(linksData: any): EpisodeServer {
        let sources: VideoSource[] = []
        if (Array.isArray(linksData)) {
            for (let i = 0; i < linksData.length; i++) {
                let link = linksData[i]
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
        return {
            server: "Kartoons",
            headers: { Referer: this.site + "/" },
            videoSources: sources,
        }
    }
}
