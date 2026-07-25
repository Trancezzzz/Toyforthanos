/// <reference path="./manga-provider.d.ts" />

let api = "https://comick.dev"
let searchApi = "https://api.comick.dev/v1.0/search"
let bypassd = "http://localhost:8191/solve"

async function postBypassd(url: string, extra: Record<string, any> = {}): Promise<any> {
    let body: any = { url, timeoutMs: 45000, waitMs: 15000, ...extra }
    let resp = await fetch(bypassd, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error("bypassd " + resp.status)
    return resp.json()
}

function extractJson(html: string): any {
    let m = html.match(/<pre>(.*?)<\/pre>/)
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
        let results = extractJson(json.body || "")
        if (!Array.isArray(results)) return []

        let out: SearchResult[] = []
        let seen = new Set<string>()
        for (let r of results) {
            let slug = r.slug || ""
            if (!slug || seen.has(slug)) continue
            seen.add(slug)
            let title = r.md_titles?.find((t: any) => t.lang === "en")?.title || r.title || slug
            let img = r.md_covers?.length > 0 ? "https://meo.comick.pictures/" + r.md_covers[0].b2key : ""
            out.push({ id: slug, title: title, image: img })
        }
        return out
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        let json = await postBypassd(api + "/comic/" + encodeURIComponent(mangaId), {
            timeoutMs: 45000, waitMs: 20000, scroll: false, loadMore: false,
        })
        if (!json.body) return []

        let comicHid = ""
        let nd = (() => {
            let m = json.body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
            if (!m) return null
            try { return JSON.parse(m[1]) } catch { return null }
        })()
        if (nd) {
            comicHid = nd.props?.pageProps?.comic?.hid || ""
            if (!comicHid) return []
        } else {
            return []
        }

        let allChapters: any[] = []
        let seenChaps = new Set<string>()
        let offset = 0
        let limit = 500

        while (true) {
            let chJson = await postBypassd(
                "https://api.comick.dev/comic/" + comicHid + "/chapters?limit=" + limit + "&offset=" + offset + "&lang=en",
                { timeoutMs: 30000, waitMs: 10000, scroll: false, loadMore: false }
            )
            let chData = extractJson(chJson.body || "")
            if (!chData || !Array.isArray(chData.chapters) || chData.chapters.length === 0) break

            for (let ch of chData.chapters) {
                let chapNum = ch.chap != null ? String(ch.chap) : ""
                if (!chapNum || seenChaps.has(chapNum)) continue
                seenChaps.add(chapNum)
                allChapters.push(ch)
            }

            let total = chData.total || 0
            offset += limit
            if (offset >= total) break
        }

        if (allChapters.length === 0) return []

        let out: ChapterDetails[] = []
        for (let ch of allChapters) {
            let chapNum = String(ch.chap)
            let hid = ch.hid || ""
            let title = ch.title || "Chapter " + chapNum
            let chapterUrl = api + "/comic/" + mangaId + "/" + hid
            out.push({
                id: chapterUrl,
                url: chapterUrl,
                title: title,
                chapter: chapNum,
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
            timeoutMs: 45000, waitMs: 25000, scroll: true, loadMore: false,
        })

        let images: any[] = []
        let nd = (() => {
            let m = (json.body || "").match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
            if (!m) return null
            try { return JSON.parse(m[1]) } catch { return null }
        })()

        if (nd) {
            let mdImgs = nd.props?.pageProps?.chapter?.md_images
            if (Array.isArray(mdImgs) && mdImgs.length > 0) images = mdImgs
        }

        if (images.length === 0) {
            let html = json.body || ""
            let imgRx = /<img[^>]*src="(https:\/\/meo\.comick\.pictures\/[^"]+)"/gi
            let seen = new Set<string>()
            let m
            while ((m = imgRx.exec(html)) !== null) {
                let u = m[1]
                if (!u || seen.has(u) || u.indexOf("icon") !== -1) continue
                seen.add(u)
                images.push({ url: u })
            }
        }

        let out: ChapterPage[] = []
        let seenUrls = new Set<string>()
        for (let img of images) {
            let u = img.url || img.src || (typeof img === "string" ? img : "")
            if (!u || seenUrls.has(u)) continue
            seenUrls.add(u)
            out.push({ url: u, index: out.length, headers: { Referer: api + "/" } })
        }

        return out
    }
}
