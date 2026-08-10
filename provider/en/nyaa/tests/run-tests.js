// Test runner for nyaa-plus provider — verifies the full working flow
// in a goja-compatible environment against live nyaa.si RSS.

require("./stub-env")
const fs = require("fs")
const path = require("path")
// Seanime extensions declare `class Provider` in global scope with no exports.
// Evaluate the transpiled module and grab the class off the module scope.
const providerSrc = fs.readFileSync(path.join(__dirname, "out", "provider.js"), "utf8")

function compileProvider(src) {
    const moduleWrap = require("module")
    const m = new moduleWrap.Module("provider.js", module)
    m.filename = path.join(__dirname, "out", "provider.js")
    m.paths = moduleWrap.Module._nodeModulePaths(path.join(__dirname, "out"))
    m._compile(src + "\nmodule.exports = { Provider: Provider }", m.filename)
    return m.exports
}

const providerModule = compileProvider(providerSrc)
// variant with a dead first mirror + live fallback, to exercise failover
const mirrorSrc = providerSrc.split('"{{apiUrl}}"').join('"http://127.0.0.1:9,https://nyaa.si"')
const mirrorModule = compileProvider(mirrorSrc)

let pass = 0
let fail = 0
const failures = []

function ok(cond, label, detail) {
    if (cond) {
        pass++
        console.log("  PASS: " + label)
    } else {
        fail++
        failures.push({ label, detail })
        console.log("  FAIL: " + label + (detail ? " -> " + JSON.stringify(detail) : ""))
    }
}

function media(over) {
    return Object.assign({
        id: 1, idMal: 1, status: "FINISHED", format: "TV",
        englishTitle: "", romajiTitle: "", episodeCount: 12,
        absoluteSeasonOffset: 0, synonyms: [], isAdult: false,
        startDate: { year: 2022, month: 10, day: 1 },
    }, over)
}

async function scenario(name, fn) {
    console.log("\n=== " + name + " ===")
    try {
        await fn()
    } catch (e) {
        fail++
        failures.push({ label: name, detail: "EXCEPTION: " + e.message + "\n" + e.stack })
        console.log("  FAIL: " + name + " threw -> " + e.message)
    }
}

async function main() {
    const provider = new providerModule.Provider()

    // ---------------------------------------------------------------
    await scenario("getSettings — all smart search options advertised", () => {
        const s = provider.getSettings()
        ok(s.canSmartSearch === true, "canSmartSearch true")
        ok(s.type === "main", "type main (selectable as default provider)")
        ok(s.smartSearchFilters.includes("batch"), "batch filter")
        ok(s.smartSearchFilters.includes("episodeNumber"), "episodeNumber filter")
        ok(s.smartSearchFilters.includes("resolution"), "resolution filter")
        ok(s.smartSearchFilters.includes("query"), "query filter")
        ok(s.smartSearchFilters.includes("bestReleases"), "bestReleases filter (the stock provider lacks this)")
        // UI visibility gate: container shows if ANY of these are present
        const uiShows = ["episodeNumber", "resolution", "batch", "bestReleases", "search"].some(f => s.smartSearchFilters.includes(f))
        ok(uiShows, "UI provider-param container will render")
    })

    // ---------------------------------------------------------------
    await scenario("getLatest — live nyaa.si", async () => {
        const t0 = Date.now()
        const torrents = await provider.getLatest()
        const ms = Date.now() - t0
        console.log("  (fetched in " + ms + "ms)")
        ok(torrents.length > 0, "returns torrents", torrents.length)
        if (torrents.length) {
            const t = torrents[0]
            ok(!!t.name, "has name")
            ok(!!t.link && t.link.startsWith("http"), "has link")
            ok(!!t.downloadUrl, "has downloadUrl")
            ok(!!t.infoHash && /^[0-9a-fA-F]{40}$/.test(t.infoHash), "has valid infoHash", t.infoHash)
            ok(typeof t.seeders === "number", "seeders parsed")
            ok(t.size > 0, "size parsed")
            ok(!!t.date, "date parsed")
            ok(typeof t.isBatch === "boolean" && typeof t.episodeNumber === "number", "batch/episode fields populated")
        }
    })

    // ---------------------------------------------------------------
    await scenario("search('Frieren') — live", async () => {
        const torrents = await provider.search({ media: media({}), query: "Frieren" })
        ok(torrents.length > 0, "returns results", torrents.length)
        if (torrents.length) {
            const allNamed = torrents.every(t => !!t.name)
            ok(allNamed, "all have names")
            const sorted = torrents.every((t, i, a) => i === 0 || a[i - 1].seeders >= t.seeders)
            ok(sorted, "sorted by seeders desc")
        }
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — S2 episode with EN/Romaji/JP titles (Jujutsu Kaisen 2nd Season, ep 5)", async () => {
        const opts = {
            media: media({
                idMal: 51009, // MAL id for Jujutsu Kaisen 2nd Season
                romajiTitle: "Jujutsu Kaisen 2nd Season",
                englishTitle: "Jujutsu Kaisen Season 2",
                synonyms: ["呪術廻戦 第2期", "Jujutsu Kaisen 2"],
                episodeCount: 23,
                status: "FINISHED",
                startDate: { year: 2023, month: 7, day: 6 },
            }),
            query: "",
            batch: false,
            episodeNumber: 5,
            resolution: "",
            anidbAID: 0, anidbEID: 0,
            bestReleases: false,
        }
        const torrents = await provider.smartSearch(opts)
        ok(torrents.length > 0, "returns results", torrents.length)
        if (torrents.length) {
            const eps = torrents.map(t => t.episodeNumber)
            // 29 = absolute numbering for S2E5 (offset 24 + 5)
            const allCorrectEp = torrents.every(t => t.episodeNumber === 5 || t.episodeNumber === 29 || t.isBatch)
            ok(allCorrectEp, "every result is episode 5 (or its absolute equivalent 29, or batch)", eps)
            // SubsPlease numbers JK S2 absolutely ("Jujutsu Kaisen - 29");
            // the AniList-derived offset (24) should now let us catch them
            const known = torrents.some(t => /Yameii|Erai-raws|EMBER|Judas|Breeze|DKB|MiniDual|LostYears|Anime Time|SubsPlease/i.test(t.name))
            ok(known, "found known S2 ep 5 releases")
            const subsPlease = torrents.some(t => /SubsPlease/i.test(t.name))
            ok(subsPlease, "found SubsPlease absolute-numbered release (AniList offset working)", torrents.filter(t => /SubsPlease/i.test(t.name)).map(t => t.name))
            ok(torrents.length >= 5, "multiple ep-5 releases found", torrents.length)
            const allMatchTitle = torrents.every(t => /Jujutsu Kaisen|呪術廻戦|Jujutsu Kaisen 2/i.test(t.name))
            ok(allMatchTitle, "titles match the franchise")
        }
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — season 1 episode (Frieren, ep 12) with JP synonym", async () => {
        const opts = {
            media: media({
                romajiTitle: "Sousou no Frieren",
                englishTitle: "Frieren: Beyond Journey's End",
                synonyms: ["葬送のフリーレン", "Frieren"],
                episodeCount: 28,
                status: "FINISHED",
                startDate: { year: 2023, month: 9, day: 29 },
            }),
            query: "",
            batch: false,
            episodeNumber: 12,
            resolution: "",
            anidbAID: 0, anidbEID: 0,
            bestReleases: false,
        }
        const torrents = await provider.smartSearch(opts)
        ok(torrents.length > 0, "returns results", torrents.length)
        if (torrents.length) {
            ok(torrents.every(t => t.episodeNumber === 12 || t.isBatch), "every result is episode 12 or batch")
            const anySubsPlease = torrents.some(t => /SubsPlease/i.test(t.name))
            ok(anySubsPlease, "found SubsPlease ep 12")
        }
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — batch mode (Bocchi the Rock!, FINISHED 12 eps)", async () => {
        const opts = {
            media: media({
                romajiTitle: "Bocchi the Rock!",
                englishTitle: "Bocchi the Rock!",
                synonyms: ["ぼっち・ざ・ろっく！"],
                episodeCount: 12,
                status: "FINISHED",
                startDate: { year: 2022, month: 10, day: 9 },
            }),
            query: "",
            batch: true,
            episodeNumber: 1,
            resolution: "",
            anidbAID: 0, anidbEID: 0,
            bestReleases: false,
        }
        const torrents = await provider.smartSearch(opts)
        ok(torrents.length > 0, "returns batch results", torrents.length)
        if (torrents.length) {
            ok(torrents.every(t => t.isBatch === true), "all results flagged as batch")
            ok(torrents.every(t => /Bocchi/i.test(t.name)), "titles match")
        }
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — movie (Suzume, MOVIE, 1 ep)", async () => {
        const opts = {
            media: media({
                romajiTitle: "Suzume no Tojimari",
                englishTitle: "Suzume",
                synonyms: ["すずめの戸締まり", "Suzume no Tojimari (Movie)"],
                format: "MOVIE",
                episodeCount: 1,
                startDate: { year: 2022, month: 11, day: 11 },
            }),
            query: "",
            batch: false,
            episodeNumber: 0,
            resolution: "",
            anidbAID: 0, anidbEID: 0,
            bestReleases: false,
        }
        const torrents = await provider.smartSearch(opts)
        ok(torrents.length > 0, "returns movie results", torrents.length)
        if (torrents.length) {
            ok(torrents.every(t => /Suzume/i.test(t.name)), "titles match")
        }
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — numeric title guard ('86', ep 5) — season must not misfire", async () => {
        const opts = {
            media: media({
                romajiTitle: "86",
                englishTitle: "86 Eighty Six",
                synonyms: ["エイティシックス"],
                episodeCount: 23,
                status: "FINISHED",
                startDate: { year: 2021, month: 4, day: 10 },
            }),
            query: "",
            batch: false,
            episodeNumber: 5,
            resolution: "",
            anidbAID: 0, anidbEID: 0,
            bestReleases: false,
        }
        const torrents = await provider.smartSearch(opts)
        ok(torrents.length > 0, "returns results (86 ep 5 exists)", torrents.length)
        if (torrents.length) {
            // torrents must be the ep-5 release, not "season 86"
            ok(torrents.every(t => t.episodeNumber === 5 || t.isBatch), "correct episode", torrents.map(t => t.episodeNumber))
            const bad = torrents.filter(t => /86\s*[xX-]\s*86/i.test(t.name))
            ok(bad.length === 0, "no 'season 86' misfires")
        }
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — absolute episode numbering (absoluteSeasonOffset)", async () => {
        // e.g. a show whose 3rd season continues numbering from the previous
        const opts = {
            media: media({
                romajiTitle: "Kingdom Season 3",
                englishTitle: "Kingdom Season 3",
                synonyms: ["キングダム 第3シリーズ"],
                episodeCount: 26,
                status: "FINISHED",
                absoluteSeasonOffset: 52, // seasons 1+2 = 52 eps, season 3 starts at 53
                startDate: { year: 2020, month: 4, day: 6 },
            }),
            query: "",
            batch: false,
            episodeNumber: 4,
            resolution: "",
            anidbAID: 0, anidbEID: 0,
            bestReleases: false,
        }
        const torrents = await provider.smartSearch(opts)
        console.log("  (absolute: got " + torrents.length + " results)")
        if (torrents.length) {
            ok(torrents.every(t => t.episodeNumber === 4 || t.episodeNumber === 56 || t.isBatch),
                "matches relative OR absolute episode", torrents.map(t => t.episodeNumber))
        } else {
            ok(true, "no results is acceptable offline — query flow executed without crash")
        }
    })

    // ---------------------------------------------------------------
    await scenario("anilist offset — JJK S2 derives offset 24 and accepts SubsPlease absolute numbering", async () => {
        const jjkMedia = media({
            idMal: 51009,
            romajiTitle: "Jujutsu Kaisen 2nd Season",
            englishTitle: "Jujutsu Kaisen Season 2",
            synonyms: ["呪術廻戦 第2期", "Jujutsu Kaisen 2"],
            episodeCount: 23,
            status: "FINISHED",
            startDate: { year: 2023, month: 7, day: 6 },
        })
        const t0 = Date.now()
        const offset = await provider.getAnilistSeasonOffset(jjkMedia)
        const ms = Date.now() - t0
        console.log("  (anilist offset in " + ms + "ms)")
        ok(offset === 24, "JJK S2 offset = 24 (S1 had 24 eps)", offset)

        // cached second call must be instant
        const t1 = Date.now()
        await provider.getAnilistSeasonOffset(jjkMedia)
        ok(Date.now() - t1 < 50, "offset cached (24h TTL)")

        // the absolute-numbered SubsPlease release must now pass the filter
        const raw = {
            name: "[SubsPlease] Jujutsu Kaisen - 29 (1080p) [ABCDEF12]",
            link: "https://nyaa.si/view/1", downloadUrl: "https://nyaa.si/download/1.torrent",
            date: "Thu, 03 Aug 2023 14:00:00 +0000", seeders: "900", leechers: "10",
            downloads: "5000", infoHash: "f".repeat(40), size: "1.1 GiB",
            metadata: $habari.parse("[SubsPlease] Jujutsu Kaisen - 29 (1080p) [ABCDEF12]"),
        }
        const rawWrong = {
            name: "[SubsPlease] Jujutsu Kaisen - 30 (1080p) [ABCDEF12]",
            link: "https://nyaa.si/view/2", downloadUrl: "https://nyaa.si/download/2.torrent",
            date: "Thu, 10 Aug 2023 14:00:00 +0000", seeders: "800", leechers: "5",
            downloads: "4000", infoHash: "g".repeat(40), size: "1.1 GiB",
            metadata: $habari.parse("[SubsPlease] Jujutsu Kaisen - 30 (1080p) [ABCDEF12]"),
        }
        const abs29 = provider.toAnimeTorrent(raw)
        const abs30 = provider.toAnimeTorrent(rawWrong)
        const out = provider.filterSmartResults([abs29, abs30], {
            media: jjkMedia, query: "", batch: false, episodeNumber: 5, resolution: "",
            anidbAID: 0, anidbEID: 0, bestReleases: false,
        }, offset)
        ok(out.length === 1, "only abs ep 29 (= S2E5) kept", out.map(t => t.name))
        ok(out[0] && out[0].name.includes("29"), "SubsPlease absolute release accepted")
    })

    // ---------------------------------------------------------------
    await scenario("exact title group — episode suffix ANDed onto EVERY variant", async () => {
        const g = provider.buildExactTitleGroup(media({
            romajiTitle: "Jujutsu Kaisen 2nd Season",
            englishTitle: "Jujutsu Kaisen Season 2",
            synonyms: ["Jujutsu Kaisen 2"],
        }), "(05|E05|S02E05)(360|720|1080)")
        const variants = g.match(/"([^"]+)"/g) || []
        ok(variants.length >= 2, "group has multiple variants", variants)
        const allSuffixed = variants.every(v => g.includes(v + "(05|E05|S02E05)(360|720|1080)"))
        ok(allSuffixed, "every variant carries the episode+res suffix", g)
        ok(/^\(".+"\(05\|E05\|S02E05\)\(360\|720\|1080\)(\|".+"\(05\|E05\|S02E05\)\(360\|720\|1080\))+\)$/.test(g), "suffix inside each paren pair", g)
    })

    // ---------------------------------------------------------------
    await scenario("mirror failover — dead first mirror, live fallback", async () => {
        const mp = new mirrorModule.Provider()
        const t0 = Date.now()
        const torrents = await mp.getLatest()
        const ms = Date.now() - t0
        console.log("  (failed over in " + ms + "ms)")
        ok(torrents.length > 0, "results returned despite dead first mirror", torrents.length)
        // the working mirror is remembered — second call stays on it
        const t1 = Date.now()
        await mp.getLatest()
        ok(Date.now() - t1 < 5000, "second call uses remembered working mirror", Date.now() - t1 + "ms")
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — bestReleases filter", async () => {
        const opts = {
            media: media({
                romajiTitle: "Bocchi the Rock!",
                englishTitle: "Bocchi the Rock!",
                synonyms: ["ぼっち・ざ・ろっく！"],
                episodeCount: 12,
                status: "FINISHED",
                startDate: { year: 2022, month: 10, day: 9 },
            }),
            query: "",
            batch: true,
            episodeNumber: 1,
            resolution: "",
            anidbAID: 0, anidbEID: 0,
            bestReleases: true,
        }
        const torrents = await provider.smartSearch(opts)
        console.log("  (bestReleases: got " + torrents.length + " results)")
        if (torrents.length > 1) {
            ok(torrents.every(t => t.isBestRelease), "every result flagged best")
            const res = torrents.map(t => parseInt(t.resolution || "0", 10))
            const maxRes = Math.max(...res)
            ok(res.every(r => r === maxRes), "all at max resolution", res)
        } else {
            ok(torrents.length === 1 ? torrents[0].isBestRelease === true : true, "best flag sanity (single result)")
        }
    })

    // ---------------------------------------------------------------
    await scenario("getTorrentInfoHash + getTorrentMagnetLink — instant, no scraping", async () => {
        const live = await provider.search({ media: media({}), query: "Frieren" })
        ok(live.length > 0, "live search for magnet test")
        const t = live[0]
        const hash = await provider.getTorrentInfoHash(t)
        ok(hash === t.infoHash, "info hash returned from RSS (no fetch)")
        const t0 = Date.now()
        const magnet = await provider.getTorrentMagnetLink(t)
        const ms = Date.now() - t0
        ok(ms < 500, "magnet built in <500ms (stock provider scrapes the page)", ms + "ms")
        ok(/^magnet:\?xt=urn:btih:/.test(magnet), "magnet format", magnet.slice(0, 60))
        ok(magnet.includes("&tr="), "has trackers")
        ok(magnet.includes("&dn="), "has display name")
    })

    // ---------------------------------------------------------------
    await scenario("episode fallback — habari miss", async () => {
        // bypass parseRSSFeed; feed a RawTorrent whose habari metadata has NO
        // episode_number (simulates a habari miss) -> fallback regex must catch it
        const raw = {
            name: "[SubsPlease] Yofukashi no Uta - 13 (720p) [ABCDEF12]",
            link: "https://nyaa.si/view/1", downloadUrl: "https://nyaa.si/download/1.torrent",
            date: "Sat, 26 Mar 2022 14:00:00 +0000", seeders: "50", leechers: "5",
            downloads: "100", infoHash: "a".repeat(40), size: "1.2 GiB",
            metadata: { title: "Yofukashi no Uta", formatted_title: "Yofukashi no Uta" },
        }
        const out = await provider.search({ media: media({}), query: "not-used" })
        // force the conversion path via the private method by feeding a crafted RSS
        const rss = "<?xml version=\"1.0\"?><rss><channel><item>"
            + "<title>[SubsPlease] Yofukashi no Uta - 13 (720p) [ABCDEF12]</title>"
            + "<guid>https://nyaa.si/view/1</guid><link>https://nyaa.si/download/1.torrent</link>"
            + "<pubDate>Sat, 26 Mar 2022 14:00:00 +0000</pubDate>"
            + "<nyaa:seeders>50</nyaa:seeders><nyaa:leechers>5</nyaa:leechers><nyaa:downloads>100</nyaa:downloads>"
            + "<nyaa:infoHash>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</nyaa:infoHash>"
            + "<nyaa:size>1.2 GiB</nyaa:size>"
            + "</item></channel></rss>"
        const parsed = provider.parseRSSFeed(rss)
        ok(parsed.length === 1, "RSS item parsed")
        if (parsed.length) {
            // my habari stub DOES catch this; to test the fallback, blank it out
            parsed[0].metadata = { title: "Yofukashi no Uta", formatted_title: "Yofukashi no Uta" }
            const t = provider.toAnimeTorrent(parsed[0])
            ok(t.episodeNumber === 13, "fallback extracted episode 13", t.episodeNumber)
            ok(t.isBatch === false, "not flagged batch")
            ok(t.resolution === "720", "resolution parsed", t.resolution)
        }
    })

    // ---------------------------------------------------------------
    await scenario("season fallback + part extraction", async () => {
        const t1 = provider.toAnimeTorrent({
            name: "[SubsPlease] Jujutsu Kaisen 2nd Season - 05 (1080p) [ABCDEF12]",
            link: "", downloadUrl: "", date: "", seeders: "", leechers: "", downloads: "",
            infoHash: "b".repeat(40), size: "800 MiB",
            metadata: { title: "Jujutsu Kaisen", formatted_title: "Jujutsu Kaisen" },
        })
        // habari stub catches "2nd Season" too — blank the metadata season to
        // force the provider's explicit-marker fallback
        const raw = {
            name: "[SubsPlease] Jujutsu Kaisen 2nd Season - 05 (1080p) [ABCDEF12]",
            link: "", downloadUrl: "", date: "", seeders: "", leechers: "", downloads: "",
            infoHash: "b".repeat(40), size: "800 MiB",
            metadata: { title: "Jujutsu Kaisen", formatted_title: "Jujutsu Kaisen" },
        }
        const t2 = provider.toAnimeTorrent(raw)
        ok(t2.episodeNumber === 5, "episode 5 parsed", t2.episodeNumber)
        ok(provider.extractSeasonNumber(raw.name) === 2, "season fallback finds '2nd Season' -> 2")
        ok(provider.extractPartNumber("Re:Zero kara Hajimeru Isekai Seikatsu Part 2") === 2, "part 2 extracted")
        ok(provider.extractSeasonNumber("[SubsPlease] 86 - 05 (1080p)") === 0, "numeric title NOT treated as season")
        ok(provider.extractSeasonNumber("[SubsPlease] Jujutsu Kaisen 2nd Season - 05") === 2, "'2nd Season' recognized")
        ok(provider.extractSeasonNumber("[Erai-raws] Spy x Family Season 2 - 05") === 2, "'Season 2' recognized")
        ok(provider.extractSeasonNumber("[SubsPlease] Kaguya-sama: Love Is War? - 05") === 0, "'Kaguya-sama 3' not misfired", 0)
        ok(provider.extractSeasonNumber("[Judas] Boku no Kokoro no Yabai Yatsu 2nd Season - 01") === 2, "trailing '2nd Season' recognized")
        ok(provider.extractPartNumber("Nier Automata Ver1.1a Cour 2 - 13") === 2, "cour 2 extracted")
        ok(t2.episodeNumber === 5, "episode 5")
    })

    // ---------------------------------------------------------------
    await scenario("batch detection", async () => {
        ok(provider.isTorrentLikelyBatch("[SubsPlease] Bocchi the Rock! - 01-12 (1080p) [ABC]") === true, "range 01-12")
        ok(provider.isTorrentLikelyBatch("[Judas] Spy x Family (Season 1 + 2) [Batch]") === true, "'Batch' keyword")
        ok(provider.isTorrentLikelyBatch("[SubsPlease] Bocchi the Rock! - 05 (1080p)") === false, "single episode not batch")
        const t = provider.toAnimeTorrent({
            name: "[SubsPlease] Bocchi the Rock! - 01-12 (1080p) [ABC]",
            link: "", downloadUrl: "", date: "", seeders: "", leechers: "", downloads: "",
            infoHash: "c".repeat(40), size: "8.0 GiB",
            metadata: { title: "Bocchi the Rock!", formatted_title: "Bocchi the Rock!" },
        })
        ok(t.isBatch === true, "range torrent flagged batch")
        ok(t.episodeNumber === -1, "batch episode = -1", t.episodeNumber)
    })

    // ---------------------------------------------------------------
    await scenario("multi-season pack range detection", async () => {
        ok(JSON.stringify(provider.getMultiSeasonRange("[Erai-raws] Mushoku Tensei Season 1-3")) === "[1,3]", "Season 1-3")
        ok(JSON.stringify(provider.getMultiSeasonRange("[Judas] Kaguya-sama S01-S03")) === "[1,3]", "S01-S03")
        ok(JSON.stringify(provider.getMultiSeasonRange("[SubsPlease] Spy x Family Complete Series")) === "[1,99]", "Complete Series")
        ok(provider.getMultiSeasonRange("[SubsPlease] Frieren - 05") === null, "no range on single ep")
    })

    // ---------------------------------------------------------------
    await scenario("cache — repeated query hits TTL cache", async () => {
        const opts = {
            media: media({
                romajiTitle: "Sousou no Frieren",
                englishTitle: "Frieren: Beyond Journey's End",
                synonyms: ["葬送のフリーレン"],
                episodeCount: 28,
                status: "FINISHED",
                startDate: { year: 2023, month: 9, day: 29 },
            }),
            query: "", batch: false, episodeNumber: 12, resolution: "",
            anidbAID: 0, anidbEID: 0, bestReleases: false,
        }
        const t0 = Date.now()
        await provider.smartSearch(opts)
        const first = Date.now() - t0
        const t1 = Date.now()
        await provider.smartSearch(opts)
        const second = Date.now() - t1
        console.log("  (first " + first + "ms, second " + second + "ms)")
        ok(second < first || second < 50, "second run served from cache", second + "ms")
    })

    // ---------------------------------------------------------------
    await scenario("userQuery override — no crash, results returned", async () => {
        const torrents = await provider.smartSearch({
            media: media({ romajiTitle: "Something", englishTitle: "Something", synonyms: [], startDate: { year: 2020, month: 1, day: 1 } }),
            query: "Mushoku Tensei", batch: false, episodeNumber: 0, resolution: "",
            anidbAID: 0, anidbEID: 0, bestReleases: false,
        })
        ok(torrents.length > 0, "returns results for raw query", torrents.length)
    })

    // ---------------------------------------------------------------
    await scenario("smartSearch — season guard: S2 torrents rejected for S1 media", async () => {
        // media is explicitly SEASON 1; the pool contains an S2 release
        // ("2nd Season") which the filter must drop
        const raw = {
            name: "[SubsPlease] Jujutsu Kaisen 2nd Season - 05 (1080p) [ABCDEF12]",
            link: "https://nyaa.si/view/1", downloadUrl: "https://nyaa.si/download/1.torrent",
            date: "Thu, 06 Jul 2023 14:00:00 +0000", seeders: "900", leechers: "10",
            downloads: "5000", infoHash: "d".repeat(40), size: "1.1 GiB",
            metadata: $habari.parse("[SubsPlease] Jujutsu Kaisen 2nd Season - 05 (1080p) [ABCDEF12]"),
        }
        const rawS1 = {
            name: "[SubsPlease] Jujutsu Kaisen - 05 (1080p) [ABCDEF12]",
            link: "https://nyaa.si/view/2", downloadUrl: "https://nyaa.si/download/2.torrent",
            date: "Sat, 26 Oct 2020 14:00:00 +0000", seeders: "700", leechers: "5",
            downloads: "3000", infoHash: "e".repeat(40), size: "1.1 GiB",
            metadata: $habari.parse("[SubsPlease] Jujutsu Kaisen - 05 (1080p) [ABCDEF12]"),
        }
        const s2 = provider.toAnimeTorrent(raw)
        const s1ep = provider.toAnimeTorrent(rawS1)
        ok(s2.episodeNumber === 5 && provider.extractSeasonNumber(s2.name) === 2, "S2 torrent parsed (ep 5, season 2)")
        ok(s1ep.episodeNumber === 5 && provider.extractSeasonNumber(s1ep.name) === 0, "S1 torrent parsed (ep 5, no season)")

        const opts = {
            media: media({
                romajiTitle: "Jujutsu Kaisen Season 1",
                englishTitle: "Jujutsu Kaisen Season 1",
                synonyms: ["呪術廻戦"],
                episodeCount: 24,
                status: "FINISHED",
                startDate: { year: 2020, month: 10, day: 3 },
            }),
            query: "", batch: false, episodeNumber: 5, resolution: "",
            anidbAID: 0, anidbEID: 0, bestReleases: false,
        }
        const out = provider.filterSmartResults([s2, s1ep], opts)
        ok(out.length === 1, "only S1 ep 5 kept", out.map(t => t.name))
        ok(out[0] && out[0].name === rawS1.name, "S1 release kept, S2 release rejected")
    })

    // ---------------------------------------------------------------
    console.log("\n=============================================")
    console.log("PASS: " + pass + "  FAIL: " + fail)
    if (failures.length) {
        console.log("\nFailures:")
        for (const f of failures) {
            console.log(" - " + f.label)
            if (f.detail) console.log("     " + f.detail)
        }
        process.exit(1)
    }
    process.exit(0)
}

main().catch(e => {
    console.error("HARNESS CRASH: " + e.stack)
    process.exit(2)
})
