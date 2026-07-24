/// <reference path="./manga-provider.d.ts" />

let bypass = "http://localhost:8191/solve"
let base = "https://mangafire.to"

function log(...args: any[]) {
    try { console.log("[MangaFire]", ...args) } catch {}
}

async function bypassFetch(url: string, timeoutMs = 30000, waitMs = 15000, loadMore = false, scroll = true): Promise<{ body: string; api: any }> {
    let res = await fetch(bypass, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, timeoutMs, waitMs, loadMore, scroll }),
    })
    if (!res.ok) return { body: "", api: null }
    let json = await res.json()
    return { body: json.body || "", api: json.api || null }
}

function extractSearchResults(html: string, seen: Set<string>): SearchResult[] {
    let out: SearchResult[] = []
    let linkRe = /<a[^>]*href="\/title\/([a-z0-9]+[^"\/]*)"/g
    let links: { slug: string; idx: number; id: string }[] = []
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html)) !== null) {
        let slug = m[1]
        let id = slug.split("-")[0]
        if (!seen.has(id)) {
            links.push({ slug, idx: m.index, id })
            seen.add(id)
        }
    }

    for (let link of links) {
        let slug = link.slug
        let idx = link.idx

        // Look backward from the link to find the nearest <img alt="...">
        let before = html.substring(Math.max(0, idx - 1500), idx)
        let lastAlt = ""
        let imgRe = /<img[^>]*alt="([^"]*?)"[^>]*>/g
        let im: RegExpExecArray | null
        while ((im = imgRe.exec(before)) !== null) {
            if (im[1]) lastAlt = im[1]
        }

        // Look forward for a title element
        let after = html.substring(idx, idx + 500)
        let titleEl = after.match(/title-row-card__title[^>]*>([^<]+)</) ||
                      after.match(/<h[1-4][^>]*>([^<]+)</) ||
                      after.match(/card-title[^>]*>([^<]+)</) ||
                      after.match(/"title"[^>]*>([^<]+)</)

        let title = titleEl ? titleEl[1] : (lastAlt || slug)

        let imgSrc = ""
        let imgS = (before + after.substring(0, 200)).match(/<img[^>]*src="([^"]*?)"[^>]*>/)
        if (imgS) imgSrc = imgS[1]

        out.push({ id: slug, title: title || slug, image: imgSrc, synonyms: [] })
    }
    return out
}

// Extract search results directly from captured API responses
function extractApiSearchResults(api: any, seen: Set<string>): SearchResult[] {
    if (!api) return []
    let out: SearchResult[] = []

    for (let key of Object.keys(api)) {
        let d = api[key]
        if (!d || typeof d !== "object") continue

        // Collect all potential items arrays from this response
        let candidates: any[][] = []
        if (Array.isArray(d)) {
            for (let page of d) {
                if (page?.items) candidates.push(page.items)
                if (page?.data?.titles) candidates.push(page.data.titles)
                if (page?.data?.items) candidates.push(page.data.items)
            }
        }
        if (d.items && Array.isArray(d.items)) candidates.push(d.items)
        if (d.data?.titles && Array.isArray(d.data.titles)) candidates.push(d.data.titles)
        if (d.data?.items && Array.isArray(d.data.items)) candidates.push(d.data.items)
        if (d.data?.results && Array.isArray(d.data.results)) candidates.push(d.data.results)

        for (let items of candidates) {
            for (let item of items) {
                let slug = item.slug || item.hid || String(item.id || "")
                let id = typeof slug === "string" ? slug.split("-")[0] : slug
                if (!id || seen.has(id)) continue
                seen.add(id)
                out.push({
                    id: slug,
                    title: item.name || item.title || slug,
                    image: item.poster || item.image || item.cover || "",
                    synonyms: [],
                })
            }
        }
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
        let q = opts.query.replace(/[:\-]/g, " ")
        let qLower = q.toLowerCase().trim()

        // Try multiple search URL patterns in order of likelihood
        let urls = [
            base + "/browse?keyword=" + encodeURIComponent(q) + "&sort=relevance:desc",
            base + "/browse?keyword=" + encodeURIComponent(q),
            base + "/browse?search=" + encodeURIComponent(q),
            base + "/search?keyword=" + encodeURIComponent(q),
            base + "/search?q=" + encodeURIComponent(q),
        ]

        for (let url of urls) {
            let { body: html, api } = await bypassFetch(url, 20000, 8000, false, false)

            // Strategy 1: Try captured API responses first
            if (api) {
                all = extractApiSearchResults(api, seen)
                log("try:", url.slice(0, 80), "api found:", all.length)
                if (all.length > 0) {
                    for (let r of all) {
                        if (r.title.toLowerCase() === qLower) {
                            log("exact match from API:", r.title)
                            return all
                        }
                    }
                    return all
                }
            }

            // Strategy 2: Fall back to HTML parsing of rendered SPA
            if (html) {
                all = extractSearchResults(html, seen)
                log("try:", url.slice(0, 80), "html found:", all.length)
                if (all.length > 0) {
                    for (let r of all) {
                        if (r.title.toLowerCase() === qLower) {
                            log("exact match from HTML:", r.title)
                            return all
                        }
                    }
                    return all
                }
            }
        }

        log("final results:", all.length)
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

        // Extract chapters from captured API responses (only chapter/volume endpoints)
        if (api) {
            for (let key of Object.keys(api)) {
                // Skip non-chapter endpoints — only process chapters, volumes, __direct_chapters
                if (!key.includes('/chapters') && !key.includes('/volumes') && key !== '__direct_chapters') continue

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
                if (!key.includes('/chapters/')) continue
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
