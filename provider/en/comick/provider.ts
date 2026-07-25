/// <reference path="./manga-provider.d.ts" />

let api = "https://comick.dev"
let searchApi = "https://api.comick.dev/v1.0/search"
let bypassd = "http://localhost:8191/solve"

async function postBypassd(url: string, extra: Record<string, any> = {}): Promise<any> {
    let body: any = { url, timeoutMs: 60000, waitMs: 30000, ...extra }
    let resp = await fetch(bypassd, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error("bypassd " + resp.status)
    return resp.json()
}

function extractNextData(html: string): any {
    let m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
    if (!m) return null
    try { return JSON.parse(m[1]) } catch { return null }
}

class Provider {
    getSettings(): Settings {
        return { supportsMultiLanguage: true, supportsMultiScanlator: false }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        let q = encodeURIComponent(opts.query)
        let json = await postBypassd(searchApi + "?q=" + q + "&limit=20", {
            timeoutMs: 30000, waitMs: 10000, scroll: false, loadMore: false,
        })

        let raw = json.body || ""
        let results: any[] = []
        try {
            let parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) results = parsed
            else if (parsed.total || parsed.results) results = parsed.results || parsed.data || []
        } catch {}

        if (results.length === 0) {
            let m = raw.match(/\[[\s\S]*\]/)
            if (m) try { results = JSON.parse(m[0]) } catch {}
        }

        let out: SearchResult[] = []
        let seen = new Set<string>()
        for (let r of results) {
            let slug = r.slug || ""
            if (!slug || seen.has(slug)) continue
            seen.add(slug)
            let title = ""
            if (r.md_titles) {
                let en = r.md_titles.find((t: any) => t.lang === "en")
                if (en) title = en.title
            }
            if (!title) title = r.title || slug
            let img = ""
            if (r.md_covers && r.md_covers.length > 0) {
                img = "https://meo.comick.pictures/" + r.md_covers[0].b2key
            }
            out.push({ id: slug, title: title, image: img })
        }
        return out
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        let json = await postBypassd(api + "/comic/" + encodeURIComponent(mangaId), {
            timeoutMs: 60000, waitMs: 30000, scroll: true, loadMore: true,
        })

        let nd = extractNextData(json.body || "")
        if (!nd) return []

        let chapters = nd.props?.pageProps?.firstChapters
        if (!chapters || !Array.isArray(chapters)) chapters = []

        let loadedHids = new Set(chapters.map((c: any) => c.hid))

        let chapterPage = nd.props?.pageProps?.chapters
        if (Array.isArray(chapterPage)) {
            for (let c of chapterPage) {
                if (c.hid && !loadedHids.has(c.hid)) {
                    loadedHids.add(c.hid)
                    chapters.push(c)
                }
            }
        }

        let out: ChapterDetails[] = []
        let seen = new Set<string>()
        for (let ch of chapters) {
            let hid = ch.hid || ""
            if (!hid || seen.has(hid)) continue
            seen.add(hid)
            let num = ch.chap || "0"
            let title = ch.title || "Chapter " + num
            let chapterUrl = api + "/comic/" + mangaId + "/" + hid
            out.push({
                id: chapterUrl,
                url: chapterUrl,
                title: title,
                chapter: String(num),
                index: 0,
                language: ch.lang || "en",
                updatedAt: ch.created_at || ch.publish_at || "",
            })
        }

        out.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter))
        for (let i = 0; i < out.length; i++) out[i].index = i
        return out
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        let chapterUrl = chapterId.indexOf("/") !== -1 ? chapterId : api + "/comic/" + chapterId

        let json = await postBypassd(chapterUrl, {
            timeoutMs: 45000, waitMs: 30000, scroll: true, loadMore: false,
        })

        let nd = extractNextData(json.body || "")
        let images: any[] = []

        if (nd) {
            let chData = nd.props?.pageProps?.chapter
            if (chData) {
                let mdImgs = chData.md_images
                if (Array.isArray(mdImgs) && mdImgs.length > 0) {
                    images = mdImgs
                }
            }
        }

        if (images.length === 0) {
            let html = json.body || ""
            let imgRx = /<img[^>]*src="(https:\/\/meo\.comick\.pictures\/[^"]+)"/gi
            let seen = new Set<string>()
            let m
            while ((m = imgRx.exec(html)) !== null) {
                let u = m[1]
                if (!u || seen.has(u)) continue
                seen.add(u)
                images.push({ url: u })
            }
        }

        let out: ChapterPage[] = []
        let seenUrls = new Set<string>()
        for (let i = 0; i < images.length; i++) {
            let img = images[i]
            let u = img.url || img.src || (typeof img === "string" ? img : "")
            if (!u || seenUrls.has(u)) continue
            seenUrls.add(u)
            out.push({ url: u, index: out.length, headers: { Referer: api + "/" } })
        }

        return out
    }
}
