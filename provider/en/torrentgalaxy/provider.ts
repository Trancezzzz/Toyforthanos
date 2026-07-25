/// <reference path="./anime-torrent-provider.d.ts" />

let bypassd = "http://localhost:8191/solve"
let domains = [
    "https://torrentgalaxy.mx",
    "https://torrentgalaxy.to",
    "https://torrentgalaxy.tv",
]

async function tryDomain(): Promise<string | null> {
    for (let d of domains) {
        try {
            let resp = await fetch(bypassd, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: d, timeoutMs: 15000, waitMs: 5000, scroll: false, loadMore: false }),
            })
            if (resp.ok) {
                let json = await resp.json()
                if (json.status === 200 && json.body && json.body.indexOf("522") === -1) return d
            }
        } catch {}
    }
    return null
}

class Provider {
    private workingDomain: string | null = null
    private resolving: Promise<string | null> | null = null

    async ensureDomain(): Promise<string | null> {
        if (this.workingDomain) return this.workingDomain
        if (!this.resolving) this.resolving = tryDomain()
        this.workingDomain = await this.resolving
        return this.workingDomain
    }

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: false,
            smartSearchFilters: [],
            supportsAdult: true,
            type: "main",
        }
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        return []
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        return []
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return ""
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        return []
    }
}
