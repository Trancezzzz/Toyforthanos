/// <reference path="./online-streaming-provider.d.ts" />

let uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
]

function headers(referer: string) {
    return {
        "User-Agent": uas[Math.floor(Math.random() * uas.length)],
        Referer: referer,
        "X-Requested-With": "XMLHttpRequest",
    }
}

function b64decode(s: string): string {
    try {
        let b = s.replace(/-/g, "+").replace(/_/g, "/")
        while (b.length % 4 !== 0) b += "="
        return CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(b))
    } catch (e) {
        return ""
    }
}

function parseM3u8(body: string, baseUrl: string): VideoSource[] {
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
        if (u.indexOf("http") !== 0) { let sep = baseUrl.lastIndexOf("/"); u = baseUrl.substring(0, sep + 1) + u }
        out.push({ url: u, quality: q, type: "hls", subtitles: [] })
    }
    return out
}

function getFile(json: any): string {
    if (!json || !json.sources) return ""
    let s = json.sources
    if (typeof s.file === "string") return s.file
    if (Array.isArray(s)) for (let v of s) { if (typeof v.file === "string") return v.file }
    return ""
}

class Provider {
    base = "https://hianime.ms"

    getSettings(): Settings {
        return { episodeServers: ["Ryu"], supportsDub: true }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!opts.query.trim()) return []
        let res = await fetch(this.base + "/search?q=" + encodeURIComponent(opts.query), { headers: headers(this.base) })
        if (!res.ok) return []
        let html = await res.text()
        let out: SearchResult[] = []
        let parts = html.split('<div class="flw-item">')
        for (let i = 1; i < parts.length; i++) {
            let p = parts[i]
            let linkM = p.match(/href="https:\/\/hianime\.ms\/details\/([^"]+)"/)
            let titleM = p.match(/class="dynamic-name"[^>]*>([^<]+)</)
            if (!linkM || !titleM) continue
            let hasSub = p.indexOf("tick-sub") !== -1
            let hasDub = p.indexOf("tick-dub") !== -1
            if (opts.dub && !hasDub) continue
            if (!opts.dub && !hasSub) continue
            out.push({
                id: linkM[1],
                title: titleM[1].trim(),
                url: this.base + "/details/" + linkM[1],
                subOrDub: hasSub && hasDub ? "both" : (hasDub ? "dub" : "sub"),
            })
        }
        return out
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let d = id.lastIndexOf("-")
        if (d === -1) return []
        let name = id.substring(0, d), animeId = id.substring(d + 1)
        let res = await fetch(this.base + "/watch-" + name + "-episode-1-" + animeId, { headers: headers(this.base) })
        if (!res.ok) return []
        let html = await res.text()
        let out: EpisodeDetails[] = []
        let seen: Record<number, boolean> = {}
        let rx = /<a[\s\S]*?class="ws-ep[^"]*"[\s\S]*?<\/a>/g
        let m
        while ((m = rx.exec(html)) !== null) {
            let numM = m[0].match(/data-episode="(\d+)"/)
            let tokenM = m[0].match(/data-stream-token="([^"]+)"/)
            if (!numM || !tokenM) continue
            let num = parseInt(numM[1], 10)
            if (seen[num]) continue
            seen[num] = true
            let epId = b64decode(tokenM[1]).split(":")[0]
            if (!epId) continue
            let titleM = m[0].match(/aria-label="([^"]+)"/)
            out.push({
                id: epId,
                number: num,
                url: this.base + "/watch-" + name + "-episode-" + num + "-" + animeId,
                title: titleM ? titleM[1] : "Episode " + num,
            })
        }
        out.sort(function (a, b) { return a.number - b.number })
        return out
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        let sr = "https://megaplay.buzz/"
        let html = await (await fetch(episode.url, { headers: headers(this.base) })).text()
        let tokenM = html.match(/data-stream-token="([^"]+)"/)
        let realId = tokenM ? b64decode(tokenM[1]).split(":")[0] : ""
        if (!realId) throw new Error("No stream token for ep " + episode.number)

        let br = await fetch("https://megaplay.buzz/stream/s-2/" + realId + "/" + ((episode as any).subOrDub === "dub" ? "dub" : "sub"), { headers: headers(sr) })
        if (!br.ok) throw new Error("Backup failed for ep " + episode.number + ": " + br.status)
        let didM = (await br.text()).match(/data-id="(\d+)"/)
        let dataId = didM ? didM[1] : ""
        if (!dataId) throw new Error("No data-id for ep " + episode.number)

        let res = await fetch("https://megaplay.buzz/stream/getSourcesNew?id=" + dataId + "&id=" + dataId, { headers: headers(sr) })
        if (!res.ok) throw new Error("Sources failed for ep " + episode.number + ": " + res.status)
        let json = JSON.parse(await res.text())
        let masterUrl = getFile(json)
        if (!masterUrl) throw new Error("No source for ep " + episode.number)

        let subs: VideoSubtitle[] = []
        if (json.tracks) for (let i = 0; i < json.tracks.length; i++) {
            let t = json.tracks[i]
            if (t.file) subs.push({ id: "sub-" + i, url: t.file, language: t.label || "English", isDefault: i === 0 })
        }

        let m3u8Res = await fetch(masterUrl, { headers: headers(sr), redirect: "follow" })
        if (m3u8Res.ok) {
            let body = await m3u8Res.text()
            if (body.indexOf("#EXTM3U") !== -1) {
                let sources = parseM3u8(body, m3u8Res.url || masterUrl)
                if (sources.length > 0) {
                    for (let s of sources) s.subtitles = subs
                    return { server, headers: headers(sr), videoSources: sources }
                }
            }
        }
        return { server, headers: headers(sr), videoSources: [{ url: masterUrl, quality: "auto", type: "hls", subtitles: subs }] }
    }
}
