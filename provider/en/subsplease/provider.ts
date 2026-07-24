/// <reference path="./anime-torrent-provider.d.ts" />

let api = "https://subsplease.org/api"

function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function toAnimeTorrent(key: string, v: any): AnimeTorrent {
    let best = v.downloads[v.downloads.length - 1]
    let episode = v.episode
    let isBatch = episode.indexOf("-") !== -1
    return {
        name: key,
        date: new Date(v.release_date).toISOString(),
        size: 0,
        formattedSize: "",
        seeders: 0,
        leechers: 0,
        downloadCount: 0,
        link: "https://subsplease.org/shows/" + v.page,
        downloadUrl: best.torrent || "",
        magnetLink: best.magnet,
        infoHash: best.magnet.match(/btih:([A-Fa-f0-9]+)/i)?.[1] || "",
        resolution: best.res + "p",
        isBatch: isBatch,
        episodeNumber: isBatch ? -1 : parseInt(episode, 10),
        releaseGroup: "SubsPlease",
        isBestRelease: false,
        confirmed: true,
    }
}

class Provider {
    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query", "bestReleases"],
            supportsAdult: false,
            type: "main",
        }
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        let res = await fetch(api + "/?f=search&s=" + encodeURIComponent(opts.query) + "&tz=UTC")
        if (!res.ok) return []
        let json = await res.json()
        let out: AnimeTorrent[] = []
        for (let key in json) {
            if (!json.hasOwnProperty(key)) continue
            out.push(toAnimeTorrent(key, json[key]))
        }
        return out
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        let results: AnimeTorrent[] = []

        if (opts.batch || opts.episodeNumber > 0) {
            let sid = slug(opts.media.englishTitle || opts.media.romajiTitle || opts.query)
            let res = await fetch(api + "/?f=show&sid=" + encodeURIComponent(sid) + "&tz=UTC")
            if (res.ok) {
                let json = await res.json()
                for (let key in json.episode || {}) {
                    if (!json.episode.hasOwnProperty(key)) continue
                    let t = toAnimeTorrent(key, json.episode[key])
                    if (opts.batch && t.isBatch) results.push(t)
                    if (opts.episodeNumber > 0 && t.episodeNumber === opts.episodeNumber) results.push(t)
                }
                for (let key in json.batch || {}) {
                    if (!json.batch.hasOwnProperty(key)) continue
                    let t = toAnimeTorrent(key, json.batch[key])
                    if (opts.batch) results.push(t)
                }
            }
        }

        if (results.length === 0) {
            let res = await fetch(api + "/?f=search&s=" + encodeURIComponent(opts.media.englishTitle || opts.media.romajiTitle || opts.query) + "&tz=UTC")
            if (res.ok) {
                let json = await res.json()
                for (let key in json) {
                    if (!json.hasOwnProperty(key)) continue
                    let t = toAnimeTorrent(key, json[key])
                    if (opts.batch && t.isBatch) results.push(t)
                    if (opts.episodeNumber > 0 && t.episodeNumber === opts.episodeNumber) results.push(t)
                    if (opts.episodeNumber === 0 && !opts.batch) results.push(t)
                }
            }
        }

        if (opts.resolution) {
            let r = opts.resolution.replace(/p$/, "")
            results = results.filter(function (t) { return t.resolution === r + "p" })
        }

        if (opts.bestReleases && results.length > 0) {
            let best: number[] = []
            for (let t of results) {
                let r = parseInt(t.resolution, 10) || 0
                best.push(r)
            }
            let max = best.reduce(function (a, b) { return a > b ? a : b }, 0)
            for (let t of results) t.isBestRelease = parseInt(t.resolution, 10) >= max
        }

        return results
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        let res = await fetch(api + "/?f=latest&tz=UTC")
        if (!res.ok) return []
        let json = await res.json()
        let out: AnimeTorrent[] = []
        for (let key in json) {
            if (!json.hasOwnProperty(key)) continue
            out.push(toAnimeTorrent(key, json[key]))
        }
        return out
    }
}
