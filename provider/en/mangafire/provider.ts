/// <reference path="./manga-provider.d.ts" />

let bypass = "http://localhost:8191/solve"
let base = "https://mangafire.to"

async function bypassFetch(url: string): Promise<string> {
    let res = await fetch(bypass, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, timeoutMs: 30000, waitMs: 15000 }),
    })
    if (!res.ok) return ""
    let json = await res.json()
    return json.body || ""
}

class Provider {
    getSettings(): Settings {
        return { supportsMultiLanguage: true, supportsMultiScanlator: false }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        let html = await bypassFetch(base + "/browse?keyword=" + encodeURIComponent(opts.query) + "&sort=relevance:desc")
        if (!html) return []

        let out: SearchResult[] = []
        let seen = new Set<string>()

        let re = /<a[^>]*class="title-rows__link"[^>]*href="\/title\/([^"]+)"[^>]*>/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            let slug = m[1]
            if (seen.has(slug)) continue
            seen.add(slug)

            let block = html.substring(m.index)
            let endIdx = block.indexOf("</a>")
            let card = endIdx > -1 ? block.substring(0, endIdx + 4) : ""

            let titleM = card.match(/title-row-card__title[^>]*>([^<]+)</)
            let title = titleM ? titleM[1].trim() : slug

            let imgM = card.match(/<img[^>]*src="([^"]*)"[^>]*>/)
            let img = imgM ? imgM[1] : ""

            out.push({ id: slug, title: title, image: img, synonyms: [] })
        }

        return out
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        let html = await bypassFetch(base + "/title/" + mangaId)
        if (!html) return []

        let chapters: ChapterDetails[] = []

        let re = /<a[^>]*class="title-detail__row-link"[^>]*href="\/title\/[^/]+\/chapter\/(\d+)"[^>]*>[\s\S]*?<span[^>]*class="title-detail__row-num"[^>]*>Ch\.\s*([\d.]+)<\/span>/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            let chId = m[1]
            let chNum = m[2]
            chapters.push({
                id: mangaId + "/chapter/" + chId,
                url: base + "/title/" + mangaId + "/chapter/" + chId,
                title: "Ch. " + chNum,
                chapter: chNum,
                index: chapters.length,
                language: "en",
                updatedAt: "",
            })
        }

        chapters.reverse()
        for (let i = 0; i < chapters.length; i++) chapters[i].index = i
        return chapters
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        let url = base + "/title/" + chapterId
        let html = await bypassFetch(url)
        if (!html) return []

        let images: string[] = []

        let imgRe = /<img[^>]*src="(https:\/\/static\.mfcdn[^"]*)"[^>]*>/g
        let m: RegExpExecArray | null
        let seen = new Set<string>()
        while ((m = imgRe.exec(html)) !== null) {
            if (!seen.has(m[1])) { seen.add(m[1]); images.push(m[1]) }
        }

        let dataRe = /"images"\s*:\s*\[([^\]]+)\]/g
        let dataM
        while ((dataM = dataRe.exec(html)) !== null) {
            let parts = dataM[1].split(",")
            for (let p of parts) {
                let clean = p.trim().replace(/^["'\s]+|["'\s]+$/g, "")
                if (clean && clean.startsWith("http") && !seen.has(clean)) {
                    seen.add(clean)
                    images.push(clean)
                }
            }
        }

        let out: ChapterPage[] = []
        for (let i = 0; i < images.length; i++) {
            out.push({ url: images[i], index: i, headers: { Referer: base + "/" } })
        }
        return out
    }
}
