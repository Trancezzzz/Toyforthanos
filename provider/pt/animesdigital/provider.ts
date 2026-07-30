class Provider {
    base = "https://animesdigital.org"
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    logTag = "[AnimesDigital]"

    _h(r: string) {
        return { "User-Agent": this.ua, Referer: r }
    }

    _log(...args: any[]) {
        console.log(this.logTag, ...args)
    }

    getSettings(): Settings {
        this._log("getSettings called")
        return { episodeServers: ["AnimesDigital"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        this._log("search called with query:", opts.query, "dub:", opts.dub)
        if (!opts.query.trim()) {
            this._log("search: empty query, returning []")
            return []
        }
        let url = this.base + "/pesquisa/?s=" + encodeURIComponent(opts.query)
        this._log("search: fetching", url)
        let res = await fetch(url, { headers: this._h(this.base) })
        this._log("search: response status", res.status, res.statusText)
        if (!res.ok) {
            this._log("search: not ok, returning []")
            return []
        }
        let html = await res.text()
        this._log("search: received HTML length", html.length)
        let out: SearchResult[] = []
        let parts = html.split('<div class="itemA">')
        this._log("search: found", parts.length - 1, "result items")
        for (let i = 1; i < parts.length; i++) {
            let p = parts[i]
            let linkM = p.match(/href="(https:\/\/animesdigital\.org\/anime\/a\/([^"]+))"/)
            let titleM = p.match(/title="Assistir ([^"]+?) Online em HD"/)
            let imgM = p.match(/src="([^"]+?)"[^>]*title="Assistir ([^"]+?) Online em HD"/)
            if (!linkM) this._log("search: item", i, "no link match")
            if (!titleM) this._log("search: item", i, "no title match")
            if (!linkM || !titleM) continue
            if (opts.dub) {
                this._log("search: item", i, "skipped - dub requested but provider is sub-only")
                continue
            }
            this._log("search: matched item", i, "id:", linkM[2], "title:", titleM[1].trim())
            out.push({
                id: linkM[2],
                title: titleM[1].trim(),
                url: linkM[1],
                subOrDub: "sub",
                poster: imgM ? imgM[1] : "",
            })
        }
        this._log("search: returning", out.length, "results")
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this._log("findEpisodes called with id:", id)
        let url = this.base + "/anime/a/" + id
        this._log("findEpisodes: fetching", url)
        let res = await fetch(url, { headers: this._h(this.base) })
        this._log("findEpisodes: response status", res.status)
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        let html = await res.text()
        this._log("findEpisodes: received HTML length", html.length)
        let episodes: EpisodeDetails[] = []
        let rx = /<div class="item_ep b_flex">\s*<a href="(https:\/\/animesdigital\.org\/video\/a\/(\d+)\/)"[^>]*>[\s\S]*?title_anime[^>]*>([^<]+)<\/div>/g
        let m, matchCount = 0
        while ((m = rx.exec(html)) !== null) {
            matchCount++
            let epTitle = m[3].trim()
            this._log("findEpisodes: raw ep match", matchCount, "id:", m[2], "title:", epTitle)
            let numM = epTitle.match(/Epis[oó]dio\s+(\d+)/i)
            let num = numM ? parseInt(numM[1], 10) : 0
            if (num === 0) {
                this._log("findEpisodes: skipping - could not parse episode number from:", epTitle)
                continue
            }
            if (episodes.some(function (e) { return e.number === num })) {
                this._log("findEpisodes: skipping duplicate episode", num)
                continue
            }
            episodes.push({
                id: m[2],
                number: num,
                url: m[1],
                title: epTitle,
            })
        }
        this._log("findEpisodes: regex matches:", matchCount, "valid episodes:", episodes.length)
        if (episodes.length === 0) throw new Error("No episodes found for " + id)
        episodes.sort(function (a, b) { return a.number - b.number })
        this._log("findEpisodes: returning episodes", episodes.map(function(e) { return e.number + ":" + e.id }).join(", "))
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        this._log("findEpisodeServer called for ep", episode.number, "id:", episode.id, "url:", episode.url)
        let res = await fetch(episode.url, { headers: this._h(this.base) })
        this._log("findEpisodeServer: video page status", res.status)
        if (!res.ok) throw new Error("Video page failed " + res.status)
        let html = await res.text()
        this._log("findEpisodeServer: video page HTML length", html.length)
        let iframeM = html.match(/<iframe[^>]*class="metaframe[^"]*rptss[^"]*no-lazy"[^>]*src="([^"]+)"[^>]*>/)
        if (!iframeM) {
            this._log("findEpisodeServer: NO PLAYER IFRAME FOUND - checking all iframes in page")
            let allIframes = html.match(/<iframe[\s\S]*?<\/iframe>/g)
            this._log("findEpisodeServer: total iframes found:", allIframes ? allIframes.length : 0)
            if (allIframes) for (let fi = 0; fi < allIframes.length; fi++) {
                this._log("findEpisodeServer: iframe", fi, ":", allIframes[fi].substring(0, 200))
            }
            throw new Error("No player iframe for ep " + episode.number)
        }
        let src = iframeM[1]
        this._log("findEpisodeServer: iframe src:", src)
        let dM = src.match(/[?&]d=([^&]+)/)
        if (!dM) {
            this._log("findEpisodeServer: no 'd' param in iframe src, checking if it's a direct URL")
            if (src.indexOf("http") === 0 && (src.indexOf(".m3u8") !== -1 || src.indexOf(".mp4") !== -1)) {
                this._log("findEpisodeServer: iframe src is itself a video URL, using directly")
                return { server: "AnimesDigital", headers: this._h(this.base), videoSources: [{ url: src, quality: "auto", type: src.indexOf(".m3u8") !== -1 ? "hls" : "mp4", subtitles: [] }] }
            }
            throw new Error("No stream URL in iframe for ep " + episode.number)
        }
        let m3u8Url = decodeURIComponent(dM[1])
        this._log("findEpisodeServer: decoded m3u8 URL:", m3u8Url)
        let m3u8Res = await fetch(m3u8Url, { headers: this._h(this.base), redirect: "follow" })
        this._log("findEpisodeServer: m3u8 fetch status:", m3u8Res.status, "final URL:", m3u8Res.url)
        if (!m3u8Res.ok) {
            this._log("findEpisodeServer: m3u8 fetch failed, returning URL directly as fallback")
            return { server: "AnimesDigital", headers: this._h(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
        }
        let body = await m3u8Res.text()
        this._log("findEpisodeServer: m3u8 body length:", body.length, "starts with #EXTM3U:", body.indexOf("#EXTM3U") === 0)
        if (body.indexOf("#EXTM3U") === -1) {
            this._log("findEpisodeServer: not a valid m3u8, returning URL directly")
            return { server: "AnimesDigital", headers: this._h(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
        }
        let sources = this._parseM3u8(body, m3u8Res.url || m3u8Url)
        this._log("findEpisodeServer: parsed", sources.length, "sources from m3u8")
        if (sources.length === 0) {
            this._log("findEpisodeServer: no multi-quality streams, using m3u8 URL as single source")
            sources.push({ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] })
        }
        this._log("findEpisodeServer: returning", sources.length, "video sources")
        return { server: "AnimesDigital", headers: this._h(this.base), videoSources: sources }
    }

    _parseM3u8(body: string, baseUrl: string): VideoSource[] {
        let out: VideoSource[] = []
        let lines = body.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
            let tl = lines[i].trim()
            if (tl.indexOf("#EXT-X-STREAM-INF:") === -1) continue
            let q = (tl.match(/NAME="([^"]+)"/) || [])[1] || "auto"
            let n = i + 1
            while (n < lines.length && lines[n].trim() === "") n++
            if (n >= lines.length) continue
            let u = lines[n].trim()
            if (u.indexOf("http") !== 0) {
                let sep = baseUrl.lastIndexOf("/")
                u = baseUrl.substring(0, sep + 1) + u
            }
            out.push({ url: u, quality: q, type: "hls", subtitles: [] })
        }
        return out
    }
}
