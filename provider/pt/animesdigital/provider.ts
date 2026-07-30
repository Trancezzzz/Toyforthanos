class Provider {
    base = "https://animesdigital.org"
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    _headers(referer: string) {
        return { "User-Agent": this.UA, Referer: referer }
    }

    _url(path: string) {
        return this.base + path
    }

    getSettings(): Settings {
        return { episodeServers: ["AnimesDigital"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!opts || !opts.query.trim()) return []
        let res = await fetch(this._url("/pesquisa/?s=" + encodeURIComponent(opts.query)), { headers: this._headers(this.base) })
        if (!res.ok) return []
        let html = await res.text()
        let out: SearchResult[] = []
        let parts = html.split('<div class="itemA">')
        for (let i = 1; i < parts.length; i++) {
            let p = parts[i]
            let linkM = p.match(/href="(https:\/\/animesdigital\.org\/anime\/a\/([^"]+))"/)
            let titleM = p.match(/title="Assistir ([^"]+?) Online em HD"/)
            if (!linkM || !titleM) continue
            if (opts.dub) continue
            out.push({ id: linkM[2], title: titleM[1].trim(), url: linkM[1], subOrDub: "sub" })
        }
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        if (id.indexOf("http") === 0) {
            let m = id.match(/\/anime\/a\/([^\/?#]+)/)
            if (m) id = m[1]
        }
        let res = await fetch(this._url("/anime/a/" + id), { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        let html = await res.text()
        let episodes: EpisodeDetails[] = []
        let rx = /<div class="item_ep b_flex">\s*<a href="(https:\/\/animesdigital\.org\/video\/a\/(\d+)\/)"[^>]*>[\s\S]*?title_anime[^>]*>([^<]+)<\/div>/g
        let m
        while ((m = rx.exec(html)) !== null) {
            let epTitle = m[3].trim()
            let numM = epTitle.match(/Epis[oó]dio\s+(\d+)/i)
            let num = numM ? parseInt(numM[1], 10) : 0
            if (num === 0) continue
            if (episodes.some(function (e) { return e.number === num })) continue
            episodes.push({ id: m[2], number: num, url: m[1], title: epTitle })
        }
        if (episodes.length === 0) throw new Error("No episodes found for " + id)
        episodes.sort(function (a, b) { return a.number - b.number })
        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        let m3u8Url = ""
        let headers = this._headers(this.base)

        let res = await fetch(episode.url, { headers: headers })
        if (res.ok) {
            let html = await res.text()
            let iframeM = html.match(/<iframe[^>]*class="metaframe[^"]*rptss[^"]*no-lazy"[^>]*src="([^"]+)"[^>]*>/)
            if (iframeM) {
                let dM = iframeM[1].match(/[?&]d=([^&]+)/)
                if (dM) {
                    m3u8Url = decodeURIComponent(dM[1])
                }
            }
        }

        if (!m3u8Url) {
            return { server: "AnimesDigital", headers: headers, videoSources: [{ url: episode.url, quality: "auto", type: "unknown", subtitles: [] }] }
        }

        let m3u8Res = await fetch(m3u8Url, { headers: headers })
        if (!m3u8Res.ok) {
            return { server: "AnimesDigital", headers: headers, videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
        }

        let body = await m3u8Res.text()
        if (body.indexOf("#EXTM3U") === -1) {
            return { server: "AnimesDigital", headers: headers, videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
        }

        let sources = this._parseM3u8(body, m3u8Res.url || m3u8Url)
        if (sources.length === 0) {
            sources.push({ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] })
        }
        return { server: "AnimesDigital", headers: headers, videoSources: sources }
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
