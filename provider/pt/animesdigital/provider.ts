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
        this._log("search enter", typeof opts, opts ? typeof opts.query : "no opts.query")
        if (!opts) { this._log("search opts is falsy"); return [] }
        if (!opts.query) { this._log("search opts.query is falsy"); return [] }
        if (typeof opts.query.trim !== "function") { this._log("search opts.query.trim not a function"); return [] }
        if (!opts.query.trim()) { this._log("search query empty"); return [] }
        this._log("search query", opts.query.substring(0, 50))
        this._log("search typeof fetch", typeof fetch)
        let url = this._url("/pesquisa/?s=" + encodeURIComponent(opts.query))
        this._log("search url", url)
        let res = await fetch(url, { headers: this._headers(this.base) })
        this._log("search status", res.status, typeof res.ok, typeof res.text)
        if (!res.ok) { this._log("search not ok"); return [] }
        let html = await res.text()
        this._log("search html length", html.length)
        let out: SearchResult[] = []
        let parts = html.split('<div class="itemA">')
        this._log("search parts", parts.length)
        for (let i = 1; i < parts.length; i++) {
            let p = parts[i]
            let linkM = p.match(/href="(https:\/\/animesdigital\.org\/anime\/a\/([^"]+))"/)
            let titleM = p.match(/title="Assistir ([^"]+?) Online em HD"/)
            if (!linkM) { this._log("search no link at", i); continue }
            if (!titleM) { this._log("search no title at", i); continue }
            if (opts.dub) continue
            out.push({ id: linkM[2], title: titleM[1].trim(), url: linkM[1], subOrDub: "sub" })
        }
        this._log("search return", out.length)
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        this._log("findEpisodes enter", typeof id, id)
        if (!id) { this._log("findEpisodes no id"); throw new Error("no id") }
        let origId = id
        if (typeof id.indexOf === "function" && id.indexOf("http") === 0) {
            this._log("findEpisodes id is URL")
            if (typeof id.match === "function") {
                let m = id.match(/\/anime\/a\/([^\/?#]+)/)
                if (m) { id = m[1]; this._log("findEpisodes extracted", id) }
                else { this._log("findEpisodes could not extract from URL"); throw new Error("bad URL id") }
            }
        }
        let url = this._url("/anime/a/" + id)
        this._log("findEpisodes url", url)
        this._log("findEpisodes typeof fetch", typeof fetch)
        let res = await fetch(url, { headers: this._headers(this.base) })
        this._log("findEpisodes status", res.status, typeof res.ok, typeof res.text)
        if (!res.ok) throw new Error("findEpisodes fetch failed " + res.status)
        let html = await res.text()
        this._log("findEpisodes html length", html.length)
        let episodes: EpisodeDetails[] = []
        let rx = /<div class="item_ep b_flex">\s*<a href="(https:\/\/animesdigital\.org\/video\/a\/(\d+)\/)"[^>]*>[\s\S]*?title_anime[^>]*>([^<]+)<\/div>/g
        this._log("findEpisodes typeof rx.exec", typeof rx.exec)
        let m, mc = 0
        while ((m = rx.exec(html)) !== null) {
            mc++
            let epTitle = m[3].trim()
            let numM = epTitle.match(/Epis[oó]dio\s+(\d+)/i)
            if (!numM) { this._log("findEpisodes no num in", epTitle); continue }
            let num = parseInt(numM[1], 10)
            if (episodes.some(function (e) { return e.number === num })) continue
            episodes.push({ id: m[2], number: num, url: m[1], title: epTitle })
        }
        this._log("findEpisodes matches", mc, "valid", episodes.length)
        if (episodes.length === 0) throw new Error("no episodes for " + id)
        episodes.sort(function (a, b) { return a.number - b.number })
        this._log("findEpisodes return", episodes.length)
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        this._log("findEpisodeServer enter", typeof episode, episode ? JSON.stringify(Object.keys(episode)) : "null")
        this._log("findEpisodeServer episode", episode ? "id=" + episode.id + " num=" + episode.number + " url=" + episode.url : "null")
        this._log("findEpisodeServer _server", _server)
        this._log("findEpisodeServer typeof fetch", typeof fetch)
        this._log("findEpisodeServer typeof decodeURIComponent", typeof decodeURIComponent)

        if (!episode) { this._log("findEpisodeServer no episode"); return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: this.base, quality: "auto", type: "unknown", subtitles: [] }] } }
        if (!episode.url) { this._log("findEpisodeServer no episode.url"); return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: this.base, quality: "auto", type: "unknown", subtitles: [] }] } }

        this._log("findEpisodeServer fetching", episode.url)
        let res = await fetch(episode.url, { headers: this._headers(this.base) })
        this._log("findEpisodeServer res status", res.status)
        if (!res.ok) { this._log("findEpisodeServer not ok"); return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] } }

        let html = await res.text()
        this._log("findEpisodeServer html", html.length)
        this._log("findEpisodeServer typeof html.match", typeof html.match)

        let iframeM = html.match(/<iframe[^>]*class="metaframe[^"]*rptss[^"]*no-lazy"[^>]*src="([^"]+)"[^>]*>/)
        this._log("findEpisodeServer iframeM", iframeM ? "found" : "null")
        if (!iframeM) {
            let allIframes = html.match(/<iframe[\s\S]*?<\/iframe>/g)
            this._log("findEpisodeServer allIframes", allIframes ? allIframes.length : 0)
            if (allIframes) for (let fi = 0; fi < allIframes.length; fi++) this._log("findEpisodeServer iframe" + fi, allIframes[fi].substring(0, 250))
            return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        this._log("findEpisodeServer src preview", iframeM[1].substring(0, 150))
        let dM = iframeM[1].match(/[?&]d=([^&]+)/)
        this._log("findEpisodeServer dM", dM ? "found" : "null")
        if (!dM) { this._log("findEpisodeServer no d param, src", iframeM[1]); return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: iframeM[1], quality: "auto", type: "unknown", subtitles: [] }] } }

        this._log("findEpisodeServer d raw", dM[1].substring(0, 100))
        let m3u8Url = decodeURIComponent(dM[1])
        this._log("findEpisodeServer m3u8Url", m3u8Url)

        let m3u8Res = await fetch(m3u8Url, { headers: this._headers(this.base) })
        this._log("findEpisodeServer m3u8 status", m3u8Res.status, typeof m3u8Res.text)
        if (!m3u8Res.ok) { this._log("findEpisodeServer m3u8 not ok"); return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] } }

        let body = await m3u8Res.text()
        this._log("findEpisodeServer m3u8 body len", body.length, "has EXTM3U", body.indexOf("#EXTM3U") === 0 || body.indexOf("#EXTM3U") !== -1)
        if (typeof body.indexOf !== "function" || body.indexOf("#EXTM3U") === -1) { this._log("findEpisodeServer bad m3u8 body"); return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] } }

        let sources = this._parseM3u8(body, m3u8Res.url || m3u8Url)
        this._log("findEpisodeServer parsed sources", sources.length)
        if (sources.length === 0) sources.push({ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] })
        this._log("findEpisodeServer returning", sources.length)
        return { server: "AnimesDigital", headers: this._headers(this.base), videoSources: sources }
    }

    _parseM3u8(body: string, baseUrl: string): VideoSource[] {
        this._log("_parseM3u8 enter", typeof body, typeof baseUrl)
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
        this._log("_parseM3u8 return", out.length)
        return out
    }
}
