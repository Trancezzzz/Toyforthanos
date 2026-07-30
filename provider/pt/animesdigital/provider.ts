class Provider {
    base = "https://animesdigital.org"
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    _headers(referer: string) {
        return { "User-Agent": this.UA, Referer: referer }
    }

    _url(path: string) {
        return this.base + path
    }

    _log(...args: any[]) {
        try { console.log("[AnimesDigital]", ...args) } catch (e) {}
    }

    getSettings(): Settings {
        this._log("getSettings")
        return { episodeServers: ["AnimesDigital"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        this._log("search called", typeof opts, opts ? "query=" + opts.query : "no opts")
        if (!opts || !opts.query.trim()) { this._log("search: empty"); return [] }
        let url = this._url("/pesquisa/?s=" + encodeURIComponent(opts.query))
        this._log("search: fetching", url)
        let res = await fetch(url, { headers: this._headers(this.base) })
        this._log("search: status", res.status)
        if (!res.ok) { this._log("search: not ok"); return [] }
        let html = await res.text()
        this._log("search: html", html.length)
        let out: SearchResult[] = []
        let parts = html.split('<div class="itemA">')
        this._log("search: items", parts.length - 1)
        for (let i = 1; i < parts.length; i++) {
            let p = parts[i]
            let linkM = p.match(/href="(https:\/\/animesdigital\.org\/anime\/a\/([^"]+))"/)
            let titleM = p.match(/title="Assistir ([^"]+?) Online em HD"/)
            if (!linkM || !titleM) { this._log("search: skip item", i, !linkM ? "no link" : "no title"); continue }
            if (opts.dub) { this._log("search: skip dub"); continue }
            out.push({ id: linkM[2], title: titleM[1].trim(), url: linkM[1], subOrDub: "sub" })
        }
        this._log("search: returning", out.length)
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this._log("findEpisodes", typeof id, id ? (id.length > 50 ? id.substring(0, 50) + "..." : id) : "null/undef")
        if (!id) throw new Error("findEpisodes: no id")
        if (id.indexOf("http") === 0) {
            let m = id.match(/\/anime\/a\/([^\/?#]+)/)
            if (m) id = m[1]
            this._log("findEpisodes: extracted id", id)
        }
        let url = this._url("/anime/a/" + id)
        this._log("findEpisodes: fetching", url)
        let res = await fetch(url, { headers: this._headers(this.base) })
        this._log("findEpisodes: status", res.status)
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        let html = await res.text()
        this._log("findEpisodes: html", html.length)
        let episodes: EpisodeDetails[] = []
        let rx = /<div class="item_ep b_flex">\s*<a href="(https:\/\/animesdigital\.org\/video\/a\/(\d+)\/)"[^>]*>[\s\S]*?title_anime[^>]*>([^<]+)<\/div>/g
        let m, mc = 0
        while ((m = rx.exec(html)) !== null) {
            mc++
            let epTitle = m[3].trim()
            let numM = epTitle.match(/Epis[oó]dio\s+(\d+)/i)
            let num = numM ? parseInt(numM[1], 10) : 0
            if (num === 0) { this._log("findEpisodes: skip no num", epTitle); continue }
            if (episodes.some(function (e) { return e.number === num })) { this._log("findEpisodes: skip dup", num); continue }
            episodes.push({ id: m[2], number: num, url: m[1], title: epTitle })
        }
        this._log("findEpisodes: matches", mc, "valid", episodes.length)
        if (episodes.length === 0) throw new Error("No episodes for " + id)
        episodes.sort(function (a, b) { return a.number - b.number })
        this._log("findEpisodes: done", episodes.length)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        this._log("findEpisodeServer called", typeof episode, episode ? "num=" + episode.number + " id=" + episode.id + " url=" + episode.url : "no episode")
        if (!episode || !episode.url) {
            this._log("findEpisodeServer: BAD episode, returning fallback")
            return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: this.base, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        let m3u8Url = ""
        this._log("findEpisodeServer: fetching", episode.url)
        let res = await fetch(episode.url, { headers: this._headers(this.base) })
        this._log("findEpisodeServer: status", res.status)
        if (res.ok) {
            let html = await res.text()
            this._log("findEpisodeServer: html", html.length)
            let iframeM = html.match(/<iframe[^>]*class="metaframe[^"]*rptss[^"]*no-lazy"[^>]*src="([^"]+)"[^>]*>/)
            this._log("findEpisodeServer: iframe match", iframeM !== null)
            if (iframeM) {
                this._log("findEpisodeServer: iframe src", iframeM[1].substring(0, 150))
                let dM = iframeM[1].match(/[?&]d=([^&]+)/)
                this._log("findEpisodeServer: d param", dM !== null)
                if (dM) {
                    m3u8Url = decodeURIComponent(dM[1])
                    this._log("findEpisodeServer: m3u8", m3u8Url)
                }
            }
            if (!iframeM) {
                let allIframes = html.match(/<iframe[\s\S]*?<\/iframe>/g)
                this._log("findEpisodeServer: all iframes", allIframes ? allIframes.length : 0)
                if (allIframes) for (let fi = 0; fi < allIframes.length; fi++) this._log("findEpisodeServer: iframe" + fi, allIframes[fi].substring(0, 200))
            }
        }

        if (!m3u8Url) {
            this._log("findEpisodeServer: no m3u8, fallback to episode.url")
            return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        this._log("findEpisodeServer: fetching m3u8", m3u8Url)
        let m3u8Res = await fetch(m3u8Url, { headers: this._headers(this.base) })
        this._log("findEpisodeServer: m3u8 status", m3u8Res.status)
        if (!m3u8Res.ok) {
            this._log("findEpisodeServer: m3u8 failed, returning raw URL")
            return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
        }

        let body = await m3u8Res.text()
        this._log("findEpisodeServer: m3u8 body", body.length, "has EXTM3U", body.indexOf("#EXTM3U") === 0)
        if (body.indexOf("#EXTM3U") === -1) {
            this._log("findEpisodeServer: bad m3u8")
            return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
        }

        let sources = this._parseM3u8(body, m3u8Res.url || m3u8Url)
        this._log("findEpisodeServer: parsed sources", sources.length)
        if (sources.length === 0) sources.push({ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] })
        this._log("findEpisodeServer: returning", sources.length, "sources")
        return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: sources }
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
