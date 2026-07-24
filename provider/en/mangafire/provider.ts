/// <reference path="./manga-provider.d.ts" />

let api = "https://mangafire.to"
let bypassd = "http://localhost:8191/solve"

class Provider {
    getSettings(): Settings {
        return { supportsMultiLanguage: true, supportsMultiScanlator: false }
    }

    async postBypassd(url: string, extra: Record<string, any> = {}): Promise<any> {
        let body: any = { url, timeoutMs: 60000, waitMs: 30000, ...extra }
        let resp = await fetch(bypassd, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
        if (!resp.ok) throw new Error("bypassd " + resp.status)
        return resp.json()
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        let q = encodeURIComponent(opts.query)
        let json = await this.postBypassd(api + "/browse?keyword=" + q + "&sort=relevance:desc", {
            timeoutMs: 30000, waitMs: 15000, loadMore: false,
        })
        let html = json.body || ""
        let out: SearchResult[] = []
        let seen: Record<string, boolean> = {}

        let rx = /<a[^>]*class="title-rows__link"[^>]*href="\/title\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
        let m
        while ((m = rx.exec(html)) !== null) {
            let slug = m[1].trim()
            if (!slug || seen[slug]) continue
            seen[slug] = true
            let titleM = m[2].match(/>([^<]+)</)
            let title = titleM ? titleM[1].trim() : slug.replace(/^[^-]+-/, "").replace(/-/g, " ")
            let img = ""
            let imgM = new RegExp("<img[^>]*src=\"([^\"]+)\"[^>]*>[\\s\\S]{0,500}" + slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").exec(html)
            if (imgM) img = imgM[1]
            out.push({ id: slug, title, image: img || "" })
        }

        if (out.length === 0) {
            let frx = /<a[^>]*href="\/title\/([^"]+)"[^>]*>/gi
            while ((m = frx.exec(html)) !== null) {
                let slug = m[1].trim()
                if (!slug || seen[slug]) continue
                seen[slug] = true
                out.push({ id: slug, title: slug.replace(/^[^-]+-/, "").replace(/-/g, " "), image: "" })
            }
        }

        return out
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        let json = await this.postBypassd(api + "/title/" + encodeURIComponent(mangaId), {
            timeoutMs: 120000, waitMs: 60000, loadMore: true, scroll: true,
        })

        let rawChapters: any[] = []
        let seenIds: Record<string, boolean> = {}
        let push = (ch: any) => {
            let id = String(ch.id || ch.chapterId || "")
            if (id && seenIds[id]) return
            if (id) seenIds[id] = true
            rawChapters.push(ch)
        }

        let apis = json.api || {}
        let directArr = apis["__direct_chapters"]
        if (Array.isArray(directArr)) {
            for (let page of directArr) {
                let items = page?.data?.chapters || page?.items || (Array.isArray(page) ? page : [])
                if (Array.isArray(items)) for (let ch of items) push(ch)
            }
        }

        for (let key of Object.keys(apis)) {
            if (key === "__direct_chapters" || key === "__decoded_config" || key === "__byBase") continue
            let val = apis[key]
            if (!val || typeof val !== "object") continue
            let batch = val?.data?.chapters || val?.items || val?.chapters || null
            if (Array.isArray(batch)) { for (let ch of batch) push(ch); continue }
            if (val?.data && typeof val.data === "object") {
                for (let k of Object.keys(val.data)) {
                    let v = val.data[k]
                    if (Array.isArray(v) && v.length > 0 && (v[0]?.number !== undefined || v[0]?.id)) {
                        for (let ch of v) push(ch)
                    }
                }
            }
        }

        if (rawChapters.length === 0) {
            let html = json.body || ""
            let chRx = /\/title\/[^/]+\/chapter\/(\d+)/g
            let seen: Record<string, boolean> = {}
            while ((m = chRx.exec(html)) !== null) {
                let cid = m[1]
                if (seen[cid]) continue
                seen[cid] = true
                rawChapters.push({ id: cid, number: cid })
            }
        }

        let out: ChapterDetails[] = []
        for (let ch of rawChapters) {
            let num = String(ch.number || ch.num || ch.chapter || ch.id || "0")
            let cid = String(ch.id || "")
            let title = ch.title || "Chapter " + num
            if (!cid) continue
            let chapterUrl = api + "/title/" + mangaId + "/chapter/" + cid
            out.push({
                id: chapterUrl,
                url: chapterUrl,
                title: title,
                chapter: num,
                index: 0,
                language: ch.language || "en",
                updatedAt: ch.releaseDate || ch.updatedAt || "",
            })
        }

        out.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter))
        for (let i = 0; i < out.length; i++) out[i].index = i
        return out
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        let json = await this.postBypassd(chapterId, {
            timeoutMs: 45000, waitMs: 25000, scroll: true, loadMore: false,
        })

        let rawUrls: string[] = []
        let apis = json.api || {}

        for (let key of Object.keys(apis)) {
            if (key === "__decoded_config") continue
            let val = apis[key]
            if (!val || typeof val !== "object") continue

            let pages = val?.data?.pages || val?.pages || null
            if (pages) {
                if (Array.isArray(pages)) {
                    for (let p of pages) {
                        let u = p?.url || p?.src || (typeof p === "string" ? p : null)
                        if (u) rawUrls.push(u)
                    }
                } else if (typeof pages === "object" && pages?.url) {
                    let u = pages.url
                    if (Array.isArray(u)) for (let x of u) if (typeof x === "string") rawUrls.push(x)
                    else if (typeof u === "string") rawUrls.push(u)
                }
                if (rawUrls.length > 0) break
            }

            let imgs = val?.images || val?.data?.images || null
            if (Array.isArray(imgs)) {
                for (let img of imgs) {
                    let u = Array.isArray(img) ? img[0] : (img?.url || img?.src || (typeof img === "string" ? img : null))
                    if (u && typeof u === "string") rawUrls.push(u)
                }
                if (rawUrls.length > 0) break
            }
        }

        if (rawUrls.length === 0) {
            let html = json.body || ""
            let imgRx = /<img[^>]*src="(https:\/\/[^"]*\.mfcdn[^"]*)"/gi
            let m
            while ((m = imgRx.exec(html)) !== null) rawUrls.push(m[1])
        }

        let seen: Record<string, boolean> = {}
        let out: ChapterPage[] = []
        for (let i = 0; i < rawUrls.length; i++) {
            let u = rawUrls[i]
            if (!u || seen[u]) continue
            seen[u] = true
            out.push({ url: u, index: out.length, headers: { Referer: api + "/" } })
        }

        return out
    }
}
