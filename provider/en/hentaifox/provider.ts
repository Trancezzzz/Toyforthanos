/// <reference path="./manga-provider.d.ts" />

let api = "https://hentaifox.com"

class Provider {

    private fetchOpts = {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            "Referer": api + "/",
        },
    }

    getSettings(): Settings {
        return { supportsMultiLanguage: false, supportsMultiScanlator: false }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        let q = encodeURIComponent(opts.query)
        let resp = await fetch(api + "/search/?q=" + q, this.fetchOpts)
        if (!resp.ok) return []
        let html = await resp.text()

        let out: SearchResult[] = []
        let seen = new Set<string>()

        let thumbRx = /<div[^>]*class="thumb"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
        let m: RegExpExecArray | null
        while ((m = thumbRx.exec(html)) !== null) {
            let block = m[1]
            let hrefM = block.match(/href="\/gallery\/(\d+)\//)
            if (!hrefM) continue
            let id = hrefM[1]
            if (seen.has(id)) continue
            seen.add(id)

            let titleM = block.match(/class="g_title"[^>]*>[\s\S]*?href="[^"]*">([\s\S]*?)<\/a>/)
            let title = titleM ? titleM[1].trim() : id

            let imgM = block.match(/data-src="([^"]+)"/)
            let image = imgM ? imgM[1] : ""

            out.push({ id, title, image })
        }

        return out
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        let pageUrl = api + "/g/" + mangaId + "/1/"
        return [{
            id: pageUrl,
            url: pageUrl,
            title: "Chapter 1",
            chapter: "1",
            index: 0,
            language: "en",
            updatedAt: "",
        }]
    }

    private cachedPages = new Map<string, ChapterPage[]>()

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        let cached = this.cachedPages.get(chapterId)
        if (cached) return cached

        let idM = chapterId.match(/\/g\/(\d+)\//)
        if (!idM) return []
        let galleryId = idM[1]

        let resp = await fetch(chapterId, this.fetchOpts)
        if (!resp.ok) return []
        let html = await resp.text()

        let imgSrcM = html.match(/data-src="([^"]+)"/)
        if (!imgSrcM) return []

        let totalPages = 0
        let pageInputM = html.match(/name="pages"[^>]*value="(\d+)"/)
        if (pageInputM) totalPages = parseInt(pageInputM[1])
        if (!totalPages) return []

        let imgUrl = imgSrcM[1]
        let extM = imgUrl.match(/\.(webp|jpg|png)$/i)
        let ext = extM ? extM[1] : "webp"
        let base = imgUrl.replace(/\/\d+\.(webp|jpg|png)$/i, "/")

        let out: ChapterPage[] = []
        let seen = new Set<string>()
        for (let i = 1; i <= totalPages; i++) {
            let u = base + i + "." + ext
            if (seen.has(u)) continue
            seen.add(u)
            out.push({ url: u, index: out.length, headers: { Referer: api + "/" } })
        }

        this.cachedPages.set(chapterId, out)
        return out
    }
}
