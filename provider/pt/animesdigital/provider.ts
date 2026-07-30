class Provider {
    base = "https://animesdigital.org"
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    logTag = "[AnimesDigital]"

    _h(r: string) {
        return { "User-Agent": this.ua, Referer: r }
    }

    _log(...args: any[]) {
        if (typeof console !== 'undefined' && console.log) console.log(this.logTag, ...args)
    }

    getSettings(): Settings {
        this._log("getSettings called")
        return { episodeServers: ["AnimesDigital"], supportsDub: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        try {
            this._log("search called", typeof opts, opts ? "query=" + opts.query + " dub=" + opts.dub : "opts is undefined")
            if (!opts) { this._log("search: opts is undefined, returning []"); return [] }
            if (!opts.query.trim()) { this._log("search: empty query, returning []"); return [] }
            let url = this.base + "/pesquisa/?s=" + encodeURIComponent(opts.query)
            this._log("search: fetching", url)
            let res = await fetch(url, { headers: this._h(this.base) })
            this._log("search: response status", res.status)
            if (!res.ok) { this._log("search: not ok, returning []"); return [] }
            let html = await res.text()
            this._log("search: HTML length", html.length)
            let out: SearchResult[] = []
            let parts = html.split('<div class="itemA">')
            this._log("search: found", parts.length - 1, "result items")
            for (let i = 1; i < parts.length; i++) {
                let p = parts[i]
                let linkM = p.match(/href="(https:\/\/animesdigital\.org\/anime\/a\/([^"]+))"/)
                let titleM = p.match(/title="Assistir ([^"]+?) Online em HD"/)
                let imgM = p.match(/src="([^"]+?)"[^>]*title="Assistir ([^"]+?) Online em HD"/)
                if (!linkM || !titleM) continue
                if (opts.dub) continue
                out.push({ id: linkM[2], title: titleM[1].trim(), url: linkM[1], subOrDub: "sub", poster: imgM ? imgM[1] : "" })
            }
            this._log("search: returning", out.length, "results")
            return out
        } catch (e) { this._log("search: ERROR:", e); return [] }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        try {
            this._log("findEpisodes called", typeof id, id ? "id=" + id : "id is undefined/null")
            if (!id) throw new Error("findEpisodes: id is undefined/null")
            let url = this.base + "/anime/a/" + encodeURIComponent(id)
            this._log("findEpisodes: fetching", url)
            let res = await fetch(url, { headers: this._h(this.base) })
            this._log("findEpisodes: response status", res.status)
            if (!res.ok) throw new Error("findEpisodes failed " + res.status)
            let html = await res.text()
            this._log("findEpisodes: HTML length", html.length)
            let episodes: EpisodeDetails[] = []
            let rx = /<div class="item_ep b_flex">\s*<a href="(https:\/\/animesdigital\.org\/video\/a\/(\d+)\/)"[^>]*>[\s\S]*?title_anime[^>]*>([^<]+)<\/div>/g
            let m, mc = 0
            while ((m = rx.exec(html)) !== null) {
                mc++
                let epTitle = m[3].trim()
                let numM = epTitle.match(/Epis[oó]dio\s+(\d+)/i)
                let num = numM ? parseInt(numM[1], 10) : 0
                if (num === 0) continue
                if (episodes.some(function (e) { return e.number === num })) continue
                episodes.push({ id: m[2], number: num, url: m[1], title: epTitle })
            }
            this._log("findEpisodes: regex matches:", mc, "valid:", episodes.length)
            if (episodes.length === 0) throw new Error("No episodes found for " + id)
            episodes.sort(function (a, b) { return a.number - b.number })
            this._log("findEpisodes: returning", episodes.length, "episodes")
            return episodes
        } catch (e) { this._log("findEpisodes: ERROR:", e); throw e }
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        try {
            this._log("findEpisodeServer called", typeof episode, episode ? "ep=" + episode.number + " id=" + episode.id : "episode is undefined")
            if (!episode || !episode.url) throw new Error("findEpisodeServer: invalid episode")
            let res = await fetch(episode.url, { headers: this._h(this.base) })
            this._log("findEpisodeServer: video page status", res.status)
            if (!res.ok) throw new Error("Video page failed " + res.status)
            let html = await res.text()
            this._log("findEpisodeServer: HTML length", html.length)
            let iframeM = html.match(/<iframe[^>]*class="metaframe[^"]*rptss[^"]*no-lazy"[^>]*src="([^"]+)"[^>]*>/)
            if (!iframeM) {
                let allIframes = html.match(/<iframe[\s\S]*?<\/iframe>/g)
                this._log("findEpisodeServer: iframe match failed, total iframes:", allIframes ? allIframes.length : 0)
                if (allIframes) for (let fi = 0; fi < allIframes.length; fi++) this._log("findEpisodeServer: iframe", fi, ":", allIframes[fi].substring(0, 250))
                throw new Error("No player iframe for ep " + episode.number)
            }
            let src = iframeM[1]
            let dM = src.match(/[?&]d=([^&]+)/)
            if (!dM) throw new Error("No stream URL in iframe for ep " + episode.number)
            let m3u8Url = decodeURIComponent(dM[1])
            this._log("findEpisodeServer: m3u8 URL:", m3u8Url)
            let m3u8Res = await fetch(m3u8Url, { headers: this._h(this.base), redirect: "follow" })
            this._log("findEpisodeServer: m3u8 fetch status:", m3u8Res.status)
            if (!m3u8Res.ok) return { server: "AnimesDigital", headers: this._h(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
            let body = await m3u8Res.text()
            this._log("findEpisodeServer: m3u8 body", body.length, "chars, has #EXTM3U:", body.indexOf("#EXTM3U") === 0)
            if (body.indexOf("#EXTM3U") === -1) return { server: "AnimesDigital", headers: this._h(this.base), videoSources: [{ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] }] }
            let sources = this._parseM3u8(body, m3u8Res.url || m3u8Url)
            if (sources.length === 0) sources.push({ url: m3u8Url, quality: "auto", type: "hls", subtitles: [] })
            this._log("findEpisodeServer: returning", sources.length, "sources")
            return { server: "AnimesDigital", headers: this._h(this.base), videoSources: sources }
        } catch (e) { this._log("findEpisodeServer: ERROR:", e); throw e }
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
