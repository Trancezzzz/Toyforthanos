/**
 * bypassd — HTTP wrapper around driver.js
 *
 * Launches one stealth Chrome via driver.js, reuses it for all requests.
 * Exposes a REST API that Seanime providers (Goja) can call via fetch().
 *
 * Usage:
 *   node server.js                    # port 8191
 *   BYPASSD_PORT=9191 node server.js
 *
 * Endpoints:
 *   POST /solve    { url, method?, headers?, body? } -> { status, body, headers, cookies }
 *   POST /turnstile { url, timeoutMs? }              -> { solved, cookies }
 *   POST /health                                       -> { ok }
 */

const { launchBrowser, newStealthPage, solveTurnstile, closeBrowser } = require('./driver.js');
const http = require('http');
const url = require('url');

const PORT = parseInt(process.env.BYPASSD_PORT || '8191', 10);

let browser = null;
let busy = false;

// ─── Lifecycle ────────────────────────────────────────────────────────────

async function ensureBrowser() {
  if (browser) {
    try {
      const pages = await browser.pages();
      if (pages.length > 0) return browser;
    } catch { /* dead — relaunch */ }
    try { await closeBrowser(browser); } catch {}
  }
  console.log(`[bypassd] launching stealth Chrome...`);
  browser = await launchBrowser({ headless: 'new' });
  console.log(`[bypassd] Chrome PID=${browser.__chromeProcess?.pid}, port=${browser.__chromeProcess?.port}`);
  return browser;
}

// ─── Request handler ──────────────────────────────────────────────────────

async function handleSolve(reqBody) {
  const br = await ensureBrowser();
  const page = await newStealthPage(br);

  try {
    const target = reqBody.url;
    const method = (reqBody.method || 'GET').toUpperCase();
    const customHeaders = reqBody.headers || {};

    if (customHeaders.Cookie) {
      await page.setCookie(
        ...customHeaders.Cookie.split(';').map(c => {
          const [n, ...v] = c.trim().split('=');
          return { name: n, value: v.join('='), domain: new URL(target).hostname, path: '/' };
        }).filter(c => c.name)
      );
      delete customHeaders.Cookie;
    }

    // Log browser console for diagnostics
    let consoleLogs = [];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('requestfailed', req => {
      consoleLogs.push(`[FAIL] ${req.resourceType()} ${req.url()} ${req.failure()?.errorText || ''}`);
    });
    page.on('response', resp => {
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('javascript')) {
        consoleLogs.push(`[API] ${resp.status()} ${resp.url().slice(0, 200)}`);
      }
    });

    const resp = await page.goto(target, { waitUntil: 'networkidle0', timeout: parseInt(reqBody.timeoutMs || '30000') });

    // Wait for SPA to render — hard delay + poll
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(() => new Promise(r => {
      let tries = 0
      const check = () => {
        const links = document.querySelectorAll('a').length
        const text = (document.body?.innerText || '').length
        if (links > 20 || text > 2000 || tries >= 60) return r()
        tries++
        setTimeout(check, 300)
      }
      check()
    }));

    const body = await page.evaluate(() => document.documentElement.outerHTML);
    const currentUrl = page.url();

    const cookies = (await page.cookies()).map(c => `${c.name}=${c.value}`).join('; ');

    // Collect response headers from the navigation
    let respHeaders = {};
    if (resp) {
      const h = resp.headers();
      for (const [k, v] of Object.entries(h)) {
        respHeaders[k] = v;
      }
    }

    await page.close().catch(() => {});

    return {
      status: resp ? resp.status() : 200,
      body,
      headers: respHeaders,
      cookies,
      url: currentUrl,
      logs: consoleLogs,
    };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

async function handleTurnstile(reqBody) {
  const br = await ensureBrowser();
  const page = await newStealthPage(br);

  try {
    const resp = await page.goto(reqBody.url, { waitUntil: 'networkidle0', timeout: parseInt(reqBody.timeoutMs || '30000') });
    const solved = await solveTurnstile(page, { timeoutMs: parseInt(reqBody.timeoutMs || '15000') });
    const cookies = (await page.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
    const body = await page.evaluate(() => document.documentElement.outerHTML);
    await page.close().catch(() => {});
    return { solved, cookies, body, url: page.url() };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const parsed = url.parse(req.url, true);

  if (req.method === 'POST' && parsed.pathname === '/solve') {
    if (busy) return json(res, 503, { error: 'busy — one request at a time' });
    busy = true;
    try {
      const body = await readBody(req);
      const result = await handleSolve(body);
      json(res, 200, result);
    } catch (err) {
      json(res, 502, { error: err.message });
    } finally {
      busy = false;
    }
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/turnstile') {
    if (busy) return json(res, 503, { error: 'busy' });
    busy = true;
    try {
      const body = await readBody(req);
      const result = await handleTurnstile(body);
      json(res, 200, result);
    } catch (err) {
      json(res, 502, { error: err.message });
    } finally {
      busy = false;
    }
    return;
  }

  if (parsed.pathname === '/health' || parsed.pathname === '/') {
    return json(res, 200, { ok: true, browser: !!browser, busy });
  }

  json(res, 404, { error: 'not found' });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────

async function shutdown() {
  console.log('\n[bypassd] shutting down...');
  if (browser) await closeBrowser(browser);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start ────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[bypassd] listening on :${PORT}`);
  console.log(`[bypassd] POST /solve  — fetch a URL through stealth Chrome`);
  console.log(`[bypassd] POST /turnstile — solve Cloudflare Turnstile then fetch`);
  console.log(`[bypassd] GET  /health — ping`);
});
