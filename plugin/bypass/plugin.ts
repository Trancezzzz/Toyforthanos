/// <reference path="./online-streaming-provider.d.ts" />

$ui.register((ctx) => {
    let ready = false
    let pending: Record<string, { resolve: Function, reject: Function, timer: any }> = {}
    let cookies: Record<string, string> = {}
    let turnstileOrigins: Record<string, boolean> = {}

    const wv = ctx.newWebview({
        slot: "after-home-screen-toolbar",
        hidden: true,
        autoHeight: true,
    })

    wv.channel.on("bypass-ready", () => { ready = true })

    wv.channel.on("bypass-response", (msg: any) => {
        let p = pending[msg.id]
        if (!p) return
        clearTimeout(p.timer)
        delete pending[msg.id]
        if (msg.error) { p.reject(new Error(msg.error)); return }
        cookies[msg.origin] = msg.cookies || ""
        p.resolve(msg)
    })

    wv.channel.on("bypass-turnstile-done", (msg: any) => {
        turnstileOrigins[msg.origin] = true
        cookies[msg.origin] = msg.cookies || ""
    })

    wv.setContent(() => `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
<script>
window.webview.send("bypass-ready", {})

function parseCookies(hdr) {
    if (!hdr) return ""
    let c = ""
    if (Array.isArray(hdr)) { for (let s of hdr) { let m = s.match(/^([^=]+=[^;]+)/); if (m) c += m[1] + "; " } }
    else { let m = hdr.match(/^([^=]+=[^;]+)/); if (m) c += m[1] + "; " }
    return c
}

window.webview.on("bypass-fetch", async (msg) => {
    try {
        let opts = { method: msg.method || "GET", headers: msg.headers || {}, redirect: "follow" }
        if (msg.body && msg.method !== "GET") opts.body = msg.body
        let res = await fetch(msg.url, opts)
        let body = await res.text()
        let hdrs = {}
        res.headers.forEach((v, k) => { hdrs[k] = v })
        let origin = new URL(msg.url).origin
        window.webview.send("bypass-response", {
            id: msg.id, status: res.status, headers: hdrs,
            body: body, cookies: document.cookie || parseCookies(hdrs["set-cookie"]),
            origin: origin
        })
    } catch (e) {
        window.webview.send("bypass-response", { id: msg.id, error: e.message })
    }
})

window.webview.on("bypass-turnstile", async (msg) => {
    try {
        let origin = new URL(msg.url).origin
        // Load in iframe to let browser solve Turnstile naturally
        let iframe = document.createElement("iframe")
        iframe.style.display = "none"
        iframe.src = msg.url
        document.body.appendChild(iframe)

        // Poll for cf_clearance cookie
        let maxWait = msg.timeout || 30000
        let start = Date.now()
        let check = setInterval(() => {
            if (document.cookie.indexOf("cf_clearance") !== -1 || Date.now() - start > maxWait) {
                clearInterval(check)
                window.webview.send("bypass-turnstile-done", {
                    origin: origin,
                    cookies: document.cookie
                })
            }
        }, 500)
    } catch (e) {
        window.webview.send("bypass-turnstile-done", { origin: new URL(msg.url).origin, cookies: "", error: e.message })
    }
})
</script>
</body>
</html>`, { sandbox: false })

    let reqId = 0

    function nextId(): string { return "br" + (++reqId) + "_" + Date.now() }

    function waitReady(): Promise<void> {
        if (ready) return Promise.resolve()
        return new Promise((resolve) => {
            let check = setInterval(() => { if (ready) { clearInterval(check); resolve() } }, 100)
        })
    }

    async function send(msg: any, timeout = 30000): Promise<any> {
        await waitReady()
        return new Promise((resolve, reject) => {
            let id = nextId()
            msg.id = id
            let timer = setTimeout(() => { delete pending[id]; reject(new Error("bypass timeout")) }, timeout)
            pending[id] = { resolve, reject, timer }
            try { wv.channel.send("bypass-fetch", msg) } catch (e) { clearTimeout(timer); delete pending[id]; reject(e) }
        })
    }

    async function solveTurnstile(url: string, timeout = 30000): Promise<string> {
        await waitReady()
        return new Promise((resolve) => {
            let origin = new URL(url).origin
            turnstileOrigins[origin] = false
            let timer = setTimeout(() => resolve(cookies[origin] || ""), timeout + 1000)
            let check = setInterval(() => {
                if (turnstileOrigins[origin]) {
                    clearInterval(timer); clearInterval(check)
                    resolve(cookies[origin] || "")
                }
            }, 200)
            wv.channel.send("bypass-turnstile", { url, timeout })
        })
    }

    function getCookie(origin: string): string { return cookies[origin] || "" }

    return { send, solveTurnstile, getCookie }
})
