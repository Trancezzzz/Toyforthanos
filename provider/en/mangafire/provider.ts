/// <reference path="./manga-provider.d.ts" />

let bypass = "http://localhost:8191/solve"
let base = "https://mangafire.to"

function log(...args: any[]) {
    try { console.log("[MangaFire]", ...args) } catch {}
}

async function bypassFetch(url: string, timeoutMs = 30000, waitMs = 15000, loadMore = false): Promise<{ body: string; api: any }> {
    let res = await fetch(bypass, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, timeoutMs, waitMs, loadMore }),
    })
    if (!res.ok) return { body: "", api: null }
    let json = await res.json()
    return { body: json.body || "", api: json.api || null }
}

function extractSearchResults(html: string, seen: Set<string>): SearchResult[] {
    let out: SearchResult[] = []
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
        out.push({ id: slug, title, image: img, synonyms: [] })
    }
    return out
}

class Provider {
    getSettings(): Settings {
        return { supportsMultiLanguage: true, supportsMultiScanlator: false }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        log("search:", opts.query)
        let seen = new Set<string>()
        let all: SearchResult[] = []
        let page = 1

        while (true) {
            let url = base + "/browse?keyword=" + encodeURIComponent(opts.query) + "&sort=relevance:desc"
            if (page > 1) url += "&page=" + page
            let { body: html } = await bypassFetch(url, 30000, 15000)
            if (!html) break

            let results = extractSearchResults(html, seen)
            if (results.length === 0) break
            for (let r of results) all.push(r)

            let npager = html.match(/npager__num[^>]*>(\d+)<\/button>/g)
            let lastPage = 1
            if (npager) {
                for (let n of npager) {
                    let p = parseInt(n.match(/>(\d+)</)?.[1] || "1")
                    if (p > lastPage) lastPage = p
                }
            }
            if (page >= lastPage) break
            page++
        }

        log("search results:", all.length)
        return all
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        log("findChapters:", mangaId)
        let url = base + "/title/" + mangaId
        let { body: html, api } = await bypassFetch(url, 60000, 30000, true)
        if (!html) return []

        let chMap = new Map<string, { id: number; number: number; name?: string; language?: string; date?: string }>()

        if (api) {
            for (let key of Object.keys(api)) {
                let d = api[key]
                if (!d?.items || !Array.isArray(d.items)) continue
                if (!d.meta) continue
                for (let item of d.items) {
                    let k = String(item.number || item.id)
                    if (!chMap.has(k)) {
                        chMap.set(k, {
                            id: item.id,
                            number: item.number,
                            name: item.name,
                            language: item.language,
                            date: item.createdAt || item.date,
                        })
                    }
                }
            }
        }

        // Fallback to HTML if API returned nothing
        if (chMap.size === 0) {
            let re = /<a[^>]*class="title-detail__row-link"[^>]*href="\/title\/[^/]+\/chapter\/(\d+)"[^>]*>[\s\S]*?<span[^>]*class="title-detail__row-num"[^>]*>Ch\.\s*([\d.]+)<\/span>/g
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) {
                let k = m[2]
                if (!chMap.has(k)) chMap.set(k, { id: parseInt(m[1]), number: parseFloat(m[2]) })
            }
        }

        let chapters: ChapterDetails[] = []
        for (let [k, v] of chMap) {
            chapters.push({
                id: mangaId + "/chapter/" + v.id,
                url: base + "/title/" + mangaId + "/chapter/" + v.id,
                title: v.name || "Ch. " + v.number,
                chapter: String(v.number),
                index: chapters.length,
                language: v.language || "en",
                updatedAt: v.date ? String(v.date) : "",
            })
        }

        chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter))
        for (let i = 0; i < chapters.length; i++) chapters[i].index = i
        log("total chapters:", chapters.length)
        return chapters
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        log("findChapterPages:", chapterId)
        let url = base + "/title/" + chapterId
        let { body: html, api } = await bypassFetch(url, 45000, 25000)
        if (!html) return []

        let images: string[] = []

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

        if (images.length === 0) {
            let re = /<img[^>]*src="(https:\/\/[^"]*\.mfcdn[^"]*)"[^>]*>/g
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) images.push(m[1])
        }

        log("chapter pages:", images.length)
        let out: ChapterPage[] = []
        for (let i = 0; i < images.length; i++) {
            out.push({ url: images[i], index: i, headers: { Referer: base + "/" } })
        }
        return out
    }
}
