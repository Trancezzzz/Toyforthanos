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
    let re = /<a[^>]*href="\/title\/([a-z0-9]+[^"\/]*)"/g
    let m: RegExpExecArray | null
    let idOrder = new Map<string, string>()
    while ((m = re.exec(html)) !== null) {
        let slug = m[1]
        let id = slug.split("-")[0]
        if (!idOrder.has(id)) idOrder.set(id, slug)
    }
    for (let [id, slug] of idOrder) {
        if (seen.has(id)) continue
        seen.add(id)
        let idx = html.indexOf('/title/' + slug)
        let block = idx < 0 ? slug : html.substring(Math.max(0, idx - 200), idx + 600)
        let titleM = block.match(/alt="([^"]*)"[^>]*title="([^"]*)"/) || block.match(/title-row-card__title[^>]*>([^<]+)</) || block.match(/alt="([^"]*?)"/)
        let title = titleM?.[2] || titleM?.[1] || slug
        let imgM = block.match(/<img[^>]*src="([^"]*?)"[^>]*>/)
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
            let q = opts.query.replace(/[:\-]/g, " ")
            let url = base + "/browse?keyword=" + encodeURIComponent(q) + "&sort=relevance:desc"
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

        // Helper: add items from any API structure
        function addItems(items: any[]) {
            for (let item of items) {
                let k = String(item.number || item.id || item.hid || "")
                if (!k) continue
                if (!chMap.has(k)) {
                    chMap.set(k, {
                        id: item.hid || item.id || 0,
                        number: item.number || item.volume || 0,
                        name: item.name || item.title || "",
                        language: item.language || "en",
                        date: item.createdAt || item.date || item.publishedAt || item.updatedAt || "",
                    })
                }
            }
        }

        // Extract chapters from all captured API responses
        if (api) {
            for (let key of Object.keys(api)) {
                let d = api[key]
                if (!d || typeof d !== "object") continue

                // __direct_chapters: array of chapter page responses
                if (Array.isArray(d)) {
                    for (let page of d) {
                        if (page?.items) addItems(page.items)
                        if (page?.data?.chapters) addItems(page.data.chapters)
                    }
                    continue
                }

                // Chapters API page: { items: [...], meta: {...} }
                if (d.items && Array.isArray(d.items)) { addItems(d.items); continue }

                // Volumes API: { data: { chapters: [...] } } or { data: { volumes: [{ chapters: [...] }] } }
                if (d.data) {
                    if (d.data.chapters && Array.isArray(d.data.chapters)) { addItems(d.data.chapters); continue }
                    if (d.data.volumes && Array.isArray(d.data.volumes)) {
                        for (let vol of d.data.volumes) {
                            if (vol.chapters) addItems(vol.chapters)
                        }
                        continue
                    }
                }

                // Direct: { chapters: [...] }
                if (d.chapters && Array.isArray(d.chapters)) { addItems(d.chapters); continue }
            }
        }

        // Fallback to HTML — parse chapter rows from rendered DOM
        if (chMap.size === 0) {
            let patterns = [
                /<a[^>]*class="title-detail__row-link"[^>]*href="\/title\/[^/]+\/chapter\/(\d+)"[^>]*>[\s\S]*?<span[^>]*class="title-detail__row-num"[^>]*>Ch\.\s*([\d.]+)<\/span>/g,
                /<a[^>]*href="\/title\/[^/]+\/chapter\/(\d+)"[\s\S]{0,500}?Ch\.\s*([\d.]+)<\/span>/g,
                /\/title\/[^/]+\/chapter\/(\d+)[^"]*"[^>]*>[\s\S]{0,200}?Ch[^0-9]*([\d.]+)/g,
            ]
            for (let re of patterns) {
                let m: RegExpExecArray | null
                while ((m = re.exec(html)) !== null) {
                    let k = m[2]
                    if (!chMap.has(k)) chMap.set(k, { id: parseInt(m[1]), number: parseFloat(m[2]) })
                }
                if (chMap.size > 0) break
            }
        }

        // Last resort: parse from JSON in __remixContext or similar
        if (chMap.size === 0) {
            let scriptM = html.match(/<script[^>]*>window\.__remixContext\s*=\s*({[\s\S]*?})<\/script>/)
            if (scriptM) {
                try {
                    let ctx = JSON.parse(scriptM[1])
                    for (let key of Object.keys(ctx?.routeData || {})) {
                        let rd = ctx.routeData[key]
                        if (rd?.chapters) addItems(rd.chapters)
                        if (rd?.items) addItems(rd.items)
                        if (rd?.data?.chapters) addItems(rd.data.chapters)
                        if (rd?.data?.volumes) {
                            for (let vol of rd.data.volumes) {
                                if (vol.chapters) addItems(vol.chapters)
                            }
                        }
                    }
                } catch {}
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
