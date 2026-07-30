/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
    base = "https://jkanime.net"
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    _headers(referer: string): Record<string, string> {
        return { "User-Agent": this.UA, "Referer": referer }
    }

    _url(path: string): string {
        return this.base + path
    }

    getSettings(): Settings {
        return { episodeServers: ["JKAnime"], supportsDub: false, supportsMultiLanguage: false }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        let q = opts.query.trim()
        if (!q) return []
        let res = await fetch(this._url("/buscar/" + encodeURIComponent(q) + "/"), { headers: this._headers(this.base) })
        if (!res.ok) return []
        let html = await res.text()
        let results: SearchResult[] = []
        let parts = html.split('<div class="col-lg-2 col-md-6 col-sm-6"')
        for (let i = 1; i < parts.length; i++) {
            let block = parts[i]
            let hrefM = block.match(/href="https:\/\/jkanime\.net\/([^/]+)\/"/)
            if (!hrefM) continue
            let slug = hrefM[1]
            let titleM = block.match(/<h5><a[^>]*href="[^"]*"[^>]*>([^<]+)<\/a><\/h5>/)
            if (!titleM) continue
            let imgM = block.match(/data-setbg="([^"]+)"/)
            let poster = imgM ? imgM[1] : ""
            results.push({
                id: slug,
                title: titleM[1].trim(),
                url: this._url("/" + slug + "/"),
                subOrDub: "sub",
                poster: poster,
                image: poster
            })
        }
        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let slug = id.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "")
        let animeUrl = this._url("/" + slug + "/")
        let res = await fetch(animeUrl, { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("findEpisodes failed " + res.status)
        let html = await res.text()
        let tokenM = html.match(/<meta name="csrf-token" content="([^"]+)"/)
        if (!tokenM) throw new Error("No CSRF token")
        let token = tokenM[1]
        let idM = html.match(/data-anime="(\d+)"/)
        if (!idM) throw new Error("No anime ID")
        let animeId = idM[1]
        let episodes: EpisodeDetails[] = []
        let page = 1
        let lastPage = 1
        while (page <= lastPage) {
            let epRes = await fetch(this._url("/ajax/episodes/" + animeId + "/" + page), {
                method: "POST",
                headers: {
                    ...this._headers(animeUrl),
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: "_token=" + encodeURIComponent(token)
            })
            if (!epRes.ok) break
            let json = await epRes.json()
            lastPage = json.last_page || lastPage
            for (let ep of json.data || []) {
                episodes.push({
                    id: slug + "/" + ep.number,
                    number: parseInt(ep.number, 10),
                    url: this._url("/" + slug + "/" + ep.number + "/"),
                    title: ep.title || "Episode " + ep.number
                })
            }
            page++
        }
        if (episodes.length === 0) throw new Error("No episodes found")
        return episodes.sort(function(a, b) { return a.number - b.number })
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        let res = await fetch(episode.url, { headers: this._headers(this.base) })
        if (!res.ok) throw new Error("findEpisodeServer failed " + res.status)
        let html = await res.text()
        let videoSection = html.split("var video")
        let iframeSrcs: string[] = []
        for (let vs of videoSection) {
            let srcM
            let srcRx = /src="([^"]+)"/g
            while ((srcM = srcRx.exec(vs)) !== null) {
                let src = srcM[1].replace(/&amp;/g, "&")
                if (src.indexOf("'+") !== -1 || src.indexOf("+'") !== -1) continue
                if (src.indexOf("jkanime.net/jkplayer/") !== -1 || src.indexOf("jkplayers.com/") !== -1) {
                    iframeSrcs.push(src)
                }
            }
        }
        if (iframeSrcs.length === 0) throw new Error("No video sources found")
        let videoSources: VideoSource[] = []
        for (let src of iframeSrcs) {
            try {
                let playerRes = await fetch(src, { headers: this._headers(episode.url) })
                if (!playerRes.ok) continue
                let playerHtml = await playerRes.text()
                let urlM = playerHtml.match(/url:\s*'([^']+)'/)
                let typeM = playerHtml.match(/type:\s*'([^']+)'/)
                if (urlM && !videoSources.some(function(s) { return s.url === urlM[1] })) {
                    videoSources.push({
                        url: urlM[1],
                        quality: "auto",
                        type: typeM ? typeM[1] : "mp4",
                        subtitles: []
                    })
                }
            } catch (_e) { continue }
        }
        if (videoSources.length === 0) throw new Error("Could not extract video URLs")
        return { server: "JKAnime", headers: this._headers(episode.url), videoSources: videoSources }
    }
}
