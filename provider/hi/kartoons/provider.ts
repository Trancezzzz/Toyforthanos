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
        if (!res.ok) return null
        return res.json()
    }

    async _solveTurnstile(): Promise<string> {
        let cached = $store.get("kartoons_ts_token")
        if (cached) {
            console.log("[Kartoons] using cached Turnstile token")
            return cached
        }

        console.log("[Kartoons] launching ChromeDP for Turnstile solve")
        let browser = await ChromeDP.newBrowser({ headless: false, timeout: 120 })
        try {
            await browser.navigate(this.site)
            await browser.sleep(3000)

            console.log("[Kartoons] injecting Turnstile widget")
            let token = await browser.evaluate(
                `(function() {
                    return new Promise(function(resolve) {
                        let p = document.createElement('div');
                        p.id = 'k-ts';
                        p.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:99999;background:#1a1a2e;padding:24px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:sans-serif;';
                        document.body.appendChild(p);

                        let l = document.createElement('p');
                        l.textContent = 'Kartoons needs a security check. Complete the CAPTCHA.';
                        l.style.cssText = 'color:#e0e0e0;margin:0 0 16px 0;font-size:14px;text-align:center;';
                        p.appendChild(l);

                        let w = document.createElement('div');
                        w.id = 'k-ts-widget';
                        p.appendChild(w);

                        let done = function(t) {
                            resolve(t);
                            setTimeout(function() { p.remove(); }, 500);
                        };

                        if (typeof turnstile !== 'undefined') {
                            turnstile.render('#k-ts-widget', {
                                sitekey: '` + this.sitekey + `',
                                callback: done
                            });
                        } else {
                            window.initKartoons = function() {
                                turnstile.render('#k-ts-widget', {
                                    sitekey: '` + this.sitekey + `',
                                    callback: done
                                });
                            };
                            let s = document.createElement('script');
                            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=initKartoons';
                            s.async = true;
                            s.defer = true;
                            document.head.appendChild(s);
                        }
                    });
                })()`
            )

            await browser.close()
            if (token && token.length > 0) {
                console.log("[Kartoons] Turnstile solved, caching token")
                $store.set("kartoons_ts_token", token)
                setTimeout(function() { $store.set("kartoons_ts_token", "") }, 120000)
                return token
            }
        } catch (e) {
            console.log("[Kartoons] Turnstile solver error:", e)
            try { await browser.close() } catch (_) {}
        }
        return ""
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

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("[Kartoons] findEpisodeServer episode:", episode.id, "server:", _server)

        let data = await this._fetchLinks(episode.id)
        if (data && data.success && data.data) {
            console.log("[Kartoons] direct fetch succeeded")
            return this._buildEpisodeServer(data.data)
        }

        console.log("[Kartoons] direct fetch blocked, solving Turnstile...")
        let token = await this._solveTurnstile()
        if (token) {
            console.log("[Kartoons] retrying with Turnstile token")
            data = await this._fetchLinks(episode.id, token)
            if (data && data.success && data.data) {
                console.log("[Kartoons] Turnstile retry succeeded")
                return this._buildEpisodeServer(data.data)
            }
            console.log("[Kartoons] Turnstile retry still failed")
        }

        console.log("[Kartoons] all methods exhausted, throwing")
        throw new Error("Could not retrieve video sources")
    }
}
