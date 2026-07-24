/// <reference path="./manga-provider.d.ts" />

let api = "https://api.mangadex.org"

class Provider {
    getSettings(): Settings {
        return { supportsMultiLanguage: true, supportsMultiScanlator: false }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        let res = await fetch(api + "/manga?title=" + encodeURIComponent(opts.query) + "&limit=20&includes[]=cover_art")
        if (!res.ok) return []
        let json = await res.json()
        let out: SearchResult[] = []
        for (let d of json.data || []) {
            let a = d.attributes
            let title = a.title.en || a.title.ja || a.title["ja-ro"] || Object.values(a.title)[0] || ""
            let year = a.year || 0
            let image = ""
            for (let r of d.relationships || []) {
                if (r.type === "cover_art" && r.attributes) {
                    let fn = r.attributes.fileName
                    if (fn) image = "https://uploads.mangadex.org/covers/" + d.id + "/" + fn
                }
            }
            let synonyms: string[] = []
            for (let k in a.title) if (k !== "en") synonyms.push(a.title[k])
            for (let at of a.altTitles || []) for (let k in at) synonyms.push(at[k])
            out.push({ id: d.id, title: title, synonyms: synonyms, year: year, image: image })
        }
        return out
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        let all: ChapterDetails[] = []
        let offset = 0
        while (true) {
            let res = await fetch(api + "/manga/" + mangaId + "/feed?translatedLanguage[]=en&limit=500&offset=" + offset + "&order[chapter]=desc")
            if (!res.ok) break
            let json = await res.json()
            for (let d of json.data || []) {
                let a = d.attributes
                let ch = a.chapter || "0"
                let title = a.title || ""
                all.push({
                    id: d.id,
                    url: "https://mangadex.org/chapter/" + d.id,
                    title: title ? "Ch. " + ch + " - " + title : "Ch. " + ch,
                    chapter: ch,
                    index: 0,
                    language: "en",
                    updatedAt: a.updatedAt || a.publishAt || "",
                })
            }
            if (!json.total || offset + 500 >= json.total) break
            offset += 500
        }
        all.reverse()
        for (let i = 0; i < all.length; i++) all[i].index = i
        return all
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        let res = await fetch(api + "/at-home/server/" + chapterId)
        if (!res.ok) return []
        let json = await res.json()
        let base = json.baseUrl + "/data/" + json.chapter.hash + "/"
        let out: ChapterPage[] = []
        for (let i = 0; i < (json.chapter.data || []).length; i++) {
            out.push({ url: base + json.chapter.data[i], index: i, headers: { Referer: "https://mangadex.org/" } })
        }
        return out
    }
}
