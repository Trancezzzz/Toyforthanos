class Provider {
    base = "https://animesdigital.org"
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    _h(r: string) {
        return { "User-Agent": this.ua, Referer: r }
    }

    getSettings(): Settings {
        return { episodeServers: ["AnimesDigital"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        try {
            if (!opts || !opts.query.trim()) return []
            let res = await fetch(this.base + "/pesquisa/?s=" + encodeURIComponent(opts.query), { headers: this._h(this.base) })
            if (!res.ok) return []
            let html = await res.text()
            let out: SearchResult[] = []
            let parts = html.split('<div class="itemA">')
            for (let i = 1; i < parts.length; i++) {
                let p = parts[i]
                let linkM = p.match(/href="(https:\/\/animesdigital\.org\/anime\/a\/([^"]+))"/)
                let titleM = p.match(/title="Assistir ([^"]+?) Online em HD"/)
                let imgM = p.match(/src="([^"]+?)"[^>]*title="Assistir ([^"]+?) Online em HD"/)
                if (!linkM || !titleM) continue
                if (opts.dub) continue
                out.push({ id: linkM[2], title: titleM[1].trim(), url: linkM[1], subOrDub: "sub", poster: imgM ? imgM[1] : "" })
            }
            return out
        } catch (e) { return [] }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        try {
            if (!id) throw new Error("no id")
            let res = await fetch(this.base + "/anime/a/" + encodeURIComponent(id), { headers: this._h(this.base) })
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
        } catch (e) { throw e }
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        try {
            if (!episode || !episode.url) throw new Error("invalid episode")
            let res = await fetch(episode.url, { headers: this._h(this.base) })
            if (!res.ok) throw new Error("Video page failed " + res.status)
            let html = await res.text()
            let iframeM = html.match(/<iframe[^>]*class="metaframe[^"]*rptss[^"]*no-lazy"[^>]*src="([^"]+)"[^>]*>/)
            if (!iframeM) throw new Error("No player iframe for ep " + episode.number)
            let src = iframeM[1]
            let dM = src.match(/[?&]d=([^&]+)/)
            if (!dM) throw new Error("No stream URL in iframe for ep " + episode.number)
            let m3u8Url = decodeURIComponent(dM[1])
            let m3u8Res = await fetch(m3u8Url, { headers: this._h(this.base), redirect: "follow" })
            if (!m3u8Res.ok) return { server: "AnimesDigital", headers: this._h(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
            let body = await m3u8Res.text()
            if (body.indexOf("#EXTM3U") === -1) return { server: "AnimesDigital", headers: this._h(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
            let sources = this._parseM3u8(body, m3u8Res.url || m3u8Url)
            if (sources.length === 0) sources.push({ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] })
            return { server: "AnimesDigital", headers: this._h(this.base), videoSources: sources }
        } catch (e) { throw e }
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
