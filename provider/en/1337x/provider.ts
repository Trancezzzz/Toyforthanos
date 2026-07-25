/// <reference path="./anime-torrent-provider.d.ts" />

let api = "https://1337x.to"
let bypassd = "http://localhost:8191/solve"

function parseSize(s: string): number {
    s = s.trim().toLowerCase()
    let num = parseFloat(s)
    if (s.includes("tb")) return num * 1024 * 1024 * 1024 * 1024
    if (s.includes("gb")) return num * 1024 * 1024 * 1024
    if (s.includes("mb")) return num * 1024 * 1024
    if (s.includes("kb")) return num * 1024
    return 0
}

function parseResult(html: string): any[] {
    let out: any[] = []
    let rowRx = /<tr>[\s\S]*?<\/tr>/gi
    let row
    while ((row = rowRx.exec(html)) !== null) {
        let r = row[0]
        if (r.indexOf("coll-1 name") === -1) continue

        let nameM = r.match(/href="\/torrent\/([^"]+)"[^>]*>([^<]*)<\/a>/)
        let seedsM = r.match(/coll-2 seeds[^>]*>\s*([^<]*)</)
        let leechesM = r.match(/coll-3 leeches[^>]*>\s*([^<]*)</)
        let sizeM = r.match(/coll-4 size[^"]*"[^>]*>\s*([^<]*)</)

        let name = nameM ? nameM[2].trim() : ""
        let link = nameM ? nameM[1].trim() : ""
        if (!name) continue

        let sizeRaw = sizeM ? sizeM[1].trim() : ""
        let seeds = seedsM ? parseInt(seedsM[1].trim(), 10) || 0 : 0
        let leeches = leechesM ? parseInt(leechesM[1].trim(), 10) || 0 : 0
        let sizeBytes = parseSize(sizeRaw)

        out.push({
            name: name,
            link: api + "/torrent/" + link,
            torrentId: link.split("/")[0],
            seeds: seeds,
            leeches: leeches,
            size: sizeBytes,
            formattedSize: sizeRaw,
        })
    }
    return out
}

async function fetchBypassd(url: string, extra: Record<string, any> = {}): Promise<any> {
    let body: any = { url, timeoutMs: 60000, waitMs: 20000, ...extra }
    let resp = await fetch(bypassd, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error("bypassd " + resp.status)
    return resp.json()
}

function toAnimeTorrent(item: any): AnimeTorrent {
    let infoHash = item.infoHash || ""
    return {
        name: item.name,
        date: "",
        size: item.size || 0,
        formattedSize: item.formattedSize || "",
        seeders: item.seeds || 0,
        leechers: item.leeches || 0,
        downloadCount: 0,
        link: item.link || api,
        downloadUrl: item.downloadUrl || "",
        magnetLink: item.magnetLink || "",
        infoHash: infoHash,
        resolution: "",
        isBatch: false,
        episodeNumber: -1,
        releaseGroup: "",
        isBestRelease: false,
        confirmed: true,
    }
}

class Provider {
    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query", "bestReleases"],
            supportsAdult: true,
            type: "main",
        }
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        let q = encodeURIComponent(opts.query)
        let json = await fetchBypassd(api + "/search/" + q + "/1/")
        let items = parseResult(json.body || "")
        return items.map(toAnimeTorrent)
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        let results: AnimeTorrent[] = []
        let query = opts.media.englishTitle || opts.media.romajiTitle || opts.query
        let items = await this.search({ query: query } as any)
        for (let t of items) {
            let matchesQuery = t.name.toLowerCase().indexOf(query.toLowerCase()) !== -1
            if (opts.episodeNumber > 0) {
                let epStr = " " + opts.episodeNumber + " "
                let epMatch = t.name.indexOf(epStr) !== -1 || t.name.indexOf("- " + opts.episodeNumber) !== -1
                if (matchesQuery && epMatch) results.push(t)
            } else if (opts.batch) {
                if (t.name.match(/\b(batch|complete|全集|全)\b/i)) results.push(t)
            } else {
                if (matchesQuery) results.push(t)
            }
        }
        return results
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        if (torrent.infoHash) return torrent.infoHash
        let magnet = await this.getTorrentMagnetLink(torrent)
        let m = magnet.match(/btih:([A-Fa-f0-9]+)/i)
        return m ? m[1].toUpperCase() : ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        let json = await fetchBypassd(torrent.link, { timeoutMs: 30000, waitMs: 10000, scroll: false, loadMore: false })
        let m = (json.body || "").match(/href="(magnet:\?[^"]+)"/)
        return m ? m[1] : ""
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        let json = await fetchBypassd(api + "/trending")
        let items = parseResult(json.body || "")
        return items.map(toAnimeTorrent)
    }
}
