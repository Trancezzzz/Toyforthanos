/// <reference path="./online-streaming-provider.d.ts" />

const BASE = "https://aniwaves.ru"

function headers(referer: string) {
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: referer,
        "X-Requested-With": "XMLHttpRequest",
    }
}

async function fetchHtml(url: string, extra: Record<string, string> = {}): Promise<string> {
    const u = new URL(url)
    let loc = `${u.protocol}//${u.hostname}${u.pathname}${u.search}`
    for (let i = 0; i < 6; i++) {
        const res = await fetch(loc, { headers: { ...headers(loc), ...extra } })
        if (!res.ok) return ""
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            let next = res.headers.get("location")!
            if (next.startsWith("/")) next = `${u.protocol}//${u.hostname}${next}`
            loc = next; continue
        }
        return await res.text()
    }
    return ""
}

async function fetchJson(url: string, extra: Record<string, string> = {}): Promise<any> {
    const res = await fetch(url, { headers: { ...headers(url), ...extra } })
    if (!res.ok) return null
    const txt = await res.text()
    try { return JSON.parse(txt) } catch { return null }
}

function parseNum(id: string): string {
    const m = id.match(/(\d{2,})$/)
    return m ? m[1] : id
}
function htmlDecode(s: string): string {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

class Provider {
    base = BASE
    servers = ["Vidplay", "BYFMS", "DGHG"]

    getSettings() {
        return { episodeServers: this.servers, supportsDub: true }
    }

    async search(opts: { query: string; dub?: boolean }): Promise<any[]> {
        if (!opts.query.trim()) return []
        const html = await fetchHtml(`${BASE}/filter?keyword=${encodeURIComponent(opts.query)}`)
        if (!html) return []
        const out: any[] = []
        const seen = new Set<string>()
        const re = /<a href="\/watch\/([^"]+)"[\s\S]*?<\/a>/gi
        let m
        while ((m = re.exec(html)) !== null) {
            const href = m[1]
            const id = href.split("/").pop()!.split("?")[0]
            if (!id || seen.has(id)) continue
            seen.add(id)
            // extract the block for this link to get title + sub/dub
            const start = m.index
            const block = html.slice(start, start + 600)
            const titleM = block.match(/alt="([^"]*)"/)
            const title = titleM ? titleM[1].trim() : id
            const subC = (block.match(/ep-status sub[\s\S]*?<span[^>]*>\s*(\d+)\s*</) || [])[1]
            const dubC = (block.match(/ep-status dub[\s\S]*?<span[^>]*>\s*(\d+)\s*</) || [])[1]
            const sub = parseInt(subC || "0", 10)
            const dub = parseInt(dubC || "0", 10)
            let subOrDub: "sub" | "dub" | "both" = "sub"
            if (dub > 0 && sub > 0) subOrDub = "both"
            else if (dub > 0) subOrDub = "dub"
            const posterM = block.match(/src="(https:\/\/static\.aniwaves\.ru\/resources\/thumbnails[^"]*)"/)
            const poster = posterM ? posterM[1] : undefined
            out.push({ id, title, url: `${BASE}/watch/${href}`, subOrDub, poster })
        }
        return out
    }

    async findEpisodes(id: string): Promise<any[]> {
        const numId = parseNum(id)
        const json = await fetchJson(`${BASE}/ajax/episode/list/${numId}`, { Referer: `${BASE}/watch/${id}` })
        if (!json || !json.result) return []
        const html = json.result as string
        const out: any[] = []
        const re = /<a[^>]*data-ids="([^"]+)"[^>]*data-num="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi
        let m
        while ((m = re.exec(html)) !== null) {
            const epId = htmlDecode(m[1])
            const num = parseInt(m[2], 10)
            const title = m[3].replace(/<[^>]+>/g, " ").trim() || `Episode ${num}`
            out.push({ id: epId, number: num, url: `${BASE}/watch/${id}`, title })
        }
        // fallback: try simpler li pattern
        if (out.length === 0) {
            const liRe = /<li[^>]*data-sv-id[^>]*data-ep-id="(\d+)"[^>]*>([\s\S]*?)<\/li>/gi
            while ((m = liRe.exec(html)) !== null) {
                const num = parseInt(m[1], 10)
                const title = m[2].replace(/<[^>]+>/g, " ").trim() || `Episode ${num}`
                out.push({ id: `${numId}&eps=${num}`, number: num, url: `${BASE}/watch/${id}`, title })
            }
        }
        out.sort((a, b) => a.number - b.number)
        if (out.length === 0) throw new Error("No episodes found")
        return out
    }

    async findEpisodeServer(episode: { id: string }, server: string): Promise<any> {
        console.log(`[aniwaves] findEpisodeServer episode=${episode.id} server=${server}`)
        const json = await fetchJson(`${BASE}/ajax/server/list?servers=${episode.id}`, {
            Referer: `${BASE}/watch/${episode.id}`, "X-Requested-With": "XMLHttpRequest"
        })
        console.log(`[aniwaves] server list status=${json?.status} servers=${json?.result ? json.result.match(/<li[^>]*data-link-id/g)?.length ?? 0 : 0}`)
        if (!json || !json.result) throw new Error("No server list")
        const html = json.result as string
        // find the <li> whose text matches the requested server (case-insensitive), tracking sub/dub
        const liRe = /<li[^>]*data-link-id="([^"]+)"[^>]*data-type="(\w+)"[^>]*>([\s\S]*?)<\/li>/gi
        let m, chosenLinkId = "", chosenName = "", chosenType = ""
        const servers: { name: string; linkId: string; type: string }[] = []
        while ((m = liRe.exec(html)) !== null) {
            const name = m[3].replace(/<[^>]+>/g, " ").trim()
            const stype = m[2]
            servers.push({ name, linkId: m[1], type: stype })
            if (!chosenLinkId && name.toLowerCase() === server.toLowerCase()) {
                chosenLinkId = m[1]; chosenName = name; chosenType = stype
            }
        }
        console.log(`[aniwaves] matched server=${chosenName} (${chosenType}) linkId=${chosenLinkId ? chosenLinkId.slice(0, 12) + '...' : 'none'} available=${servers.map(s => s.name + '(' + s.type + ')').join(', ')}`)
        if (!chosenLinkId && servers.length) { chosenLinkId = servers[0].linkId; chosenName = servers[0].name }
        if (!chosenLinkId) throw new Error("No server found")
        const srcJson = await fetchJson(`${BASE}/ajax/sources?id=${chosenLinkId}&asi=0&autoPlay=0`, {
            Referer: `${BASE}/watch/${episode.id}`, "X-Requested-With": "XMLHttpRequest"
        })
        console.log(`[aniwaves] sources status=${srcJson?.status} url=${srcJson?.result?.url ? srcJson.result.url.slice(0, 70) + '...' : 'NONE'}`)
        if (!srcJson || !srcJson.result) throw new Error("No stream found")
        const url = srcJson.result.url || ""
        return {
            server: chosenName,
            headers: headers(`${BASE}/watch/${episode.id}`),
            videoSources: [{ url, quality: chosenName, type: url.includes(".m3u8") ? "hls" : "mp4", subtitles: [] }]
        }
    }
}
