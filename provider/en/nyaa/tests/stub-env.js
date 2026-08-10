// goja-compatible environment stubs for testing the nyaa-plus provider
// Mirrors Seanime's extension runtime:
//  - fetch() returns a Promise resolving to an object with SYNC text()/json()
//  - $habari.parse(filename) -> Metadata
//  - $scannerUtils helpers
//  - $getUserPreference, LoadDoc

const https = require("https")
const http = require("http")

function httpRequest(url, method = "GET", body = null, headers = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url)
        const mod = u.protocol === "https:" ? https : http
        const opts = {
            method,
            headers: Object.assign({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }, headers),
        }
        if (body) opts.headers["Content-Length"] = Buffer.byteLength(body)
        const req = mod.request(url, opts, (res) => {
            const chunks = []
            res.on("data", (c) => chunks.push(c))
            res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }))
        })
        req.setTimeout(timeoutMs, () => { req.destroy(new Error("timeout")) })
        req.on("error", reject)
        if (body) req.write(body)
        req.end()
    })
}

// ------------------------------------------------------------------
// fetch — mimics Seanime's goja fetch: awaitable, res.text() is SYNC
// ------------------------------------------------------------------
global.fetch = async function (url, options) {
    options = options || {}
    const method = String(options.method || "GET").toUpperCase()
    let body = null
    if (options.body && typeof options.body === "string") body = options.body
    else if (options.body && typeof options.body === "object") body = JSON.stringify(options.body)
    const r = await httpRequest(url, method, body, options.headers || {})
    const resBody = r.body
    return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: String(r.status),
        text: () => resBody,
        json: () => { try { return JSON.parse(resBody) } catch (e) { return null } },
        headers: {},
    }
}

module.exports = { httpGet: httpRequest }

// ------------------------------------------------------------------
// $habari.parse — reasonable approximation of habari filename parsing
// ------------------------------------------------------------------
function habariParse(filename) {
    const meta = {
        title: undefined,
        formatted_title: undefined,
        episode_number: [],
        other_episode_number: [],
        episode_number_alt: [],
        season_number: [],
        part_number: [],
        video_resolution: undefined,
        release_group: undefined,
        language: [],
        audio_term: [],
        source: [],
        subtitles: [],
        volume_number: [],
        year: undefined,
        anime_type: [],
    }

    let name = filename

    // leading release group: [Group] ...
    let m = name.match(/^\[([^\]]+)\]\s*/)
    if (m) {
        meta.release_group = m[1]
        name = name.slice(m[0].length)
    }

    // SxxEyy / Sxx / Season N / Nth Season
    m = name.match(/\bS(\d{1,2})E(\d{1,3})(?:v\d+)?/i)
    if (m) {
        meta.season_number.push(m[1])
        meta.episode_number.push(m[2])
        name = name.replace(m[0], " ")
    } else {
        m = name.match(/\bS(\d{1,2})\b/i)
        if (m) {
            meta.season_number.push(m[1])
            name = name.replace(m[0], " ")
        }
        m = name.match(/\bSeason\s+(\d{1,2})\b/i)
        if (m) {
            meta.season_number.push(m[1])
            name = name.replace(m[0], " ")
        }
        m = name.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i)
        if (m) {
            meta.season_number.push(m[1])
            name = name.replace(m[0], " ")
        }
    }

    // Part / Cour
    m = name.match(/\bPart\s+(\d{1,2})\b/i)
    if (m) {
        meta.part_number.push(m[1])
        name = name.replace(m[0], " ")
    }
    m = name.match(/\bCour\s*(\d{1,2})\b/i)
    if (m) {
        meta.part_number.push(m[1])
        name = name.replace(m[0], " ")
    }

    // episode: " - 05", "- 05", "[05]" (trailing position)
    if (meta.episode_number.length === 0) {
        m = name.match(/[\-–—]\s*(\d{1,3})(?:v\d+)?(?=\s*(?:\(|\[|$))/)
        if (m) {
            meta.episode_number.push(m[1])
            name = name.replace(m[0], " ")
        }
    }

    // trailing tags: (1080p), [1080p], [HEVC], [Multi-Subs], (Dual Audio)
    m = name.match(/[\(\[]\s*(\d{3,4})[pP]\s*[\)\]]/)
    if (m) {
        meta.video_resolution = m[1]
    }
    m = name.match(/[\(\[]\s*(\d{3,4})\s*[\)\]]/)
    if (m && !meta.video_resolution) {
        meta.video_resolution = m[1]
    }
    m = name.match(/[\(\[]\s*(Multi-Subs|English|Spanish|Português|Japanese|Sub)\s*[\)\]]/i)
    if (m) {
        meta.language.push(m[1])
    }
    m = name.match(/[\(\[]\s*(Dual[- ]Audio)\s*[\)\]]/i)
    if (m) {
        meta.audio_term.push(m[1])
    }

    // title: strip [tags...] groups and (tags) at the end
    let title = name
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/[\(\[]\s*(?:v\d+|END)\s*[\)\]]/gi, " ")
        .replace(/\b(2160|1440|1080|720|540|480|360)\s?[pP]\b/g, " ")
        .replace(/\s+/g, " ")
        .trim()

    if (meta.episode_number.length > 0 && title) {
        title = title.replace(new RegExp("[-–—\\s]*\\d{1,3}\\s*$"), "").trim()
    }

    meta.title = title || filename
    meta.formatted_title = title || filename

    return meta
}

global.$habari = { parse: habariParse }

// ------------------------------------------------------------------
// $scannerUtils — approximation of the Go bindings
// ------------------------------------------------------------------
const STOPWORDS = new Set([
    "a", "an", "the", "of", "and", "or", "to", "in", "on", "at", "for", "with", "from",
    "da", "de", "do", "di", "del", "la", "el", "le", "il", "no", "na", "ni", "wa",
])

function normTitle(title) {
    return String(title)
        .replace(/[’'‘]/g, "'")
        .replace(/[\u0300-\u036f]/g, "")
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9\s\u3040-\u30ff\u4e00-\u9fff]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function tokenize(title) {
    return normTitle(title).split(/\s+/).filter(Boolean)
}

function significantTokens(title) {
    const toks = []
    for (const t of tokenize(title)) {
        if (t.length >= 3 || /[\u3040-\u30ff\u4e00-\u9fff]/.test(t)) {
            toks.push(t)
        }
    }
    return toks
}

function compareTitles(t1, t2) {
    const a = significantTokens(t1)
    const b = significantTokens(t2)
    if (!a.length || !b.length) return 0
    const setB = new Set(b)
    let hits = 0
    for (const tok of a) {
        if (setB.has(tok)) hits++
    }
    // favor the longer (more specific) side
    const denom = Math.max(a.length, b.length)
    let ratio = hits / denom
    // partial credit for prefix matches (e.g. "sousou no frieren" vs "frieren")
    for (const tok of a) {
        for (const bt of b) {
            if (tok.length >= 5 && bt.length >= 5 && (tok.startsWith(bt) || bt.startsWith(tok))) {
                ratio += 0.25 / denom
            }
        }
    }
    return Math.min(1, ratio)
}

function extractSeasonNumber(title) {
    let m = String(title).match(/\bS(\d{1,2})\s*(?:E|$)/i)
    if (m) return parseInt(m[1], 10)
    m = String(title).match(/\bSeason\s+(\d{1,2})\b/i)
    if (m) return parseInt(m[1], 10)
    m = String(title).match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i)
    if (m) return parseInt(m[1], 10)
    m = String(title).match(/(\d{1,2})\s*期/)
    if (m) return parseInt(m[1], 10)
    m = String(title).match(/\b(\d{1,2})\s*$/)
    if (m) return parseInt(m[1], 10) // trailing number (matches goja bindings)
    return -1
}

function extractPartNumber(title) {
    let m = String(title).match(/\bPart\s+(\d{1,2})\b/i)
    if (m) return parseInt(m[1], 10)
    m = String(title).match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Part\b/i)
    if (m) return parseInt(m[1], 10)
    m = String(title).match(/\bCour\s*(\d{1,2})\b/i)
    if (m) return parseInt(m[1], 10)
    m = String(title).match(/\bPart\s+(II|III|IV)\b/i)
    if (m) return { II: 2, III: 3, IV: 4 }[m[1].toUpperCase()]
    return -1
}

function buildSearchQuery(title) {
    const toks = significantTokens(title)
    if (!toks.length) return ""
    return toks.join(" ")
}

function buildSmartSearchTitles(titles) {
    const out = []
    const seen = new Set()
    let season = -1
    let part = -1

    for (const raw of titles) {
        if (!raw) continue
        for (const s of [extractSeasonNumber(raw)]) {
            if (s > season) season = s
        }
        for (const p of [extractPartNumber(raw)]) {
            if (p > part) part = p
        }
        const cleaned = raw
            .replace(/:/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/[()[\]{}|"'~?\\^!]/g, "")
        const q = buildSearchQuery(cleaned)
        if (q && !seen.has(q)) {
            seen.add(q)
            out.push(q)
        }
        // colon-split variant
        const ci = cleaned.indexOf(":")
        if (ci > 4) {
            const q2 = buildSearchQuery(cleaned.slice(0, ci))
            if (q2 && !seen.has(q2)) {
                seen.add(q2)
                out.push(q2)
            }
        }
    }
    return { titles: out, season, part }
}

function buildSeasonQuery(title, season) {
    if (season <= 1) return title
    const s2 = String(season).padStart(2, "0")
    return "(" + title + " S" + s2 + " | " + title + " Season " + season + " | " + title + " " + season + "nd Season)"
}

function buildPartQuery(title, part) {
    if (part <= 1) return title
    return "(" + title + " Part " + part + " | " + title + " Part " + ["", "I", "II", "III", "IV"][part] + " | " + title + " " + part + "nd Cour)"
}

function sanitizeQuery(q) {
    return String(q).replace(/[()[\]{}|"'~?\\^!]/g, " ").replace(/\s+/g, " ").trim()
}

function buildAdvancedQuery(titles) {
    const clean = titles.filter(Boolean).slice(0, 5).map((t) => sanitizeQuery(t))
    if (!clean.length) return ""
    return "(" + clean.join(" | ") + ")"
}

function findBestMatch(target, candidates) {
    let best = ""
    let bestR = 0
    for (const c of candidates) {
        const r = compareTitles(target, c)
        if (r > bestR) {
            bestR = r
            best = c
        }
    }
    return best
}

global.$scannerUtils = {
    normalizeTitle: (t) => ({
        original: t,
        normalized: normTitle(t),
        cleanBaseTitle: normTitle(t),
        denoisedTitle: normTitle(t),
        tokens: tokenize(t),
        season: extractSeasonNumber(t),
        part: extractPartNumber(t),
        year: -1,
        isMain: true,
    }),
    extractPartNumber,
    extractSeasonNumber,
    extractYear: () => -1,
    compareTitles,
    findBestMatch,
    getSignificantTokens: significantTokens,
    buildSearchQuery,
    buildAdvancedQuery,
    sanitizeQuery,
    buildSeasonQuery,
    buildPartQuery,
    buildSmartSearchTitles,
}

global.$getUserPreference = () => undefined

// LoadDoc — minimal for magnet fallback test
function fakeDoc(html) {
    const hasMagnet = /href="magnet:[^"]*"/.test(html)
    return (selector) => {
        if (selector.includes("magnet") && hasMagnet) {
            return {
                each: (cb) => {
                    const m = html.match(/href="(magnet:[^"]*)"/)
                    if (m) cb(0, { attr: (k) => (k === "href" ? m[1] : "") })
                    return false
                },
            }
        }
        return { each: () => {} }
    }
}
global.LoadDoc = fakeDoc
