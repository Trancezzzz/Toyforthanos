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

async function bypassFetchWithApi(url: string): Promise<{ body: string, api: any }> {
    let res = await fetch(bypass, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, timeoutMs: 45000, waitMs: 25000 }),
    })
    if (!res.ok) return { body: "", api: null }
    let json = await res.json()
    return { body: json.body || "", api: json.api || null }
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
        let { body: html, api } = await bypassFetchWithApi(url)
        if (!html) return []

        let images: string[] = []

        // 1. Try API response first (captured from /api/chapters/ → data.pages[].url)
        if (api) {
            for (let key of Object.keys(api)) {
                let d = api[key]?.data
                if (d?.pages && Array.isArray(d.pages)) {
                    for (let p of d.pages) {
                        if (p.url && typeof p.url === "string" && p.url.startsWith("http"))
                            images.push(p.url)
                    }
                }
            }
        }

        // 2. Fallback: HTML img tags
        if (images.length === 0) {
            let m: RegExpExecArray | null
            let re = /<img[^>]*src="(https:\/\/[^"]*\.mfcdn[^"]*)"[^>]*>/g
            while ((m = re.exec(html)) !== null) images.push(m[1])
        }

        let out: ChapterPage[] = []
        for (let i = 0; i < images.length; i++) {
            out.push({ url: images[i], index: i, headers: { Referer: base + "/" } })
        }
        return out
    }
}
