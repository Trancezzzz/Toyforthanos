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
 *   POST /solve    { url, method?, headers?, body? } -> { status, body, headers, cookies, api, logs }
 *   POST /turnstile { url, timeoutMs? }              -> { solved, cookies }
 *   POST /crypt     { action:encrypt|decrypt, data, iv?, tag?, key? } -> { ok, data|iv|tag|data }
 *   POST /health                                       -> { ok }
 */

const { launchBrowser, newStealthPage, solveTurnstile, closeBrowser } = require('./driver.js');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

const PORT = parseInt(process.env.BYPASSD_PORT || '8191', 10);
const ENC_KEY = Buffer.from((process.env.BYPASSD_KEY || 'this-is-a-32byte-dev-key-for-bypa').padEnd(32, '!'), 'utf8').subarray(0, 32); // exactly 32 bytes for AES-256

// ─── AES-256-GCM ───────────────────────────────────────────────────────────

function encryptAESGCM(plaintext, key = ENC_KEY) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    data: encrypted.toString('base64url'),
  };
}

function decryptAESGCM(payload, key = ENC_KEY) {
  const iv = Buffer.from(payload.iv, 'base64url');
  const tag = Buffer.from(payload.tag, 'base64url');
  const encrypted = Buffer.from(payload.data, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

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
    let apiResponses = {};
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('requestfailed', req => {
      consoleLogs.push(`[FAIL] ${req.resourceType()} ${req.url()} ${req.failure()?.errorText || ''}`);
    });
    page.on('response', async resp => {
      const ct = resp.headers()['content-type'] || '';
      const url = resp.url();
      if (ct.includes('json') || ct.includes('javascript')) {
        consoleLogs.push(`[API] ${resp.status()} ${url.slice(0, 200)}`);
      }
      // Capture ALL JSON responses (search API, chapter API, etc.)
      if (ct.includes('json')) {
        try {
          const json = await resp.json();
          const key = url.split('?')[0];
          apiResponses[key] = json;
          const summary = json?.items ? `items:${json.items.length}` : json?.data?.chapters ? `chapters:${json.data.chapters.length}` : json?.data?.pages ? `pages:${json.data.pages.length}` : json?.data?.titles ? `titles:${json.data.titles.length}`:'ok';
          consoleLogs.push(`[CAPTURE] ${resp.status()} ${key.slice(0, 120)} ${summary}`);
        } catch {}
      }
    });

    const resp = await page.goto(target, { waitUntil: 'networkidle0', timeout: parseInt(reqBody.timeoutMs || '30000') });

    // Wait for SPA to render — hard delay + poll
    await new Promise(r => setTimeout(r, 3000));

    // Scroll through page to trigger lazy loading
    if (reqBody.scroll !== false) {
      await page.evaluate(async () => {
        const scrollHeight = () => Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          document.documentElement.clientHeight
        );
        const total = scrollHeight();
        const step = Math.max(400, Math.floor(total / 20));
        for (let y = 0; y < total; y += step) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      });
    }

    // Load more content: scroll all containers + trigger SPA lazy loading
    if (reqBody.loadMore) {
      const slug = new URL(target).pathname.replace('/title/', '').split('/')[0];
      for (let attempt = 0; attempt < 20; attempt++) {
        const beforeCount = Object.keys(apiResponses).filter(k => k.includes('/chapters')).length;
        const beforeRows = await page.evaluate(() => document.querySelectorAll('.title-detail__row, [class*="chapter-row"], tbody tr, .chapters-list > *').length);

        // Phase 1: Aggressive scroll of ALL scrollable containers
        await page.evaluate(async () => {
          // Scroll every element that can scroll
          const els = document.querySelectorAll('body *');
          for (const el of els) {
            const s = window.getComputedStyle(el);
            const isScroll = (s.overflow === 'auto' || s.overflow === 'scroll' ||
                             s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                            el.scrollHeight > el.clientHeight + 10;
            if (!isScroll) continue;
            const max = el.scrollHeight - el.clientHeight;
            for (let y = 0; y < max; y += Math.max(200, Math.floor(max / 10))) {
              el.scrollTop = y;
              await new Promise(r => setTimeout(r, 50));
            }
            el.scrollTop = 0;
          }
          // Also scroll window to bottom
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise(r => setTimeout(r, 300));
          window.scrollTo(0, 0);
        });

        // Phase 2: Direct API fetch from page context (uses page cookies, same origin)
        if (slug) {
          const moreChapters = await page.evaluate(async (slug) => {
            const results = [];
            for (let p = 1; p <= 10; p++) {
              try {
                const r = await fetch(`/api/titles/${slug}/chapters?language=en&sort=number&order=desc&page=${p}&limit=20`, {
                  credentials: 'include',
                  headers: { 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' }
                });
                if (!r.ok) break;
                const d = await r.json();
                results.push(d);
                if (!d.meta?.hasNext) break;
              } catch { break; }
            }
            return results;
          }, slug);
          if (moreChapters && moreChapters.length > 1) {
            apiResponses['__direct_chapters'] = moreChapters;
            consoleLogs.push(`[DIRECT] fetched ${moreChapters.length} chapter pages from context`);
          }
        }

        // Phase 3: Click any interactive load triggers
        await page.evaluate(() => {
          document.querySelectorAll('button, a, [role="button"]').forEach(b => {
            const t = (b.textContent || '').toLowerCase();
            if (t.includes('load') || t.includes('show') || t.includes('more') || t.includes('all') || t === '+')
              b.click();
          });
        });

        await new Promise(r => setTimeout(r, 1500));

        const afterCount = Object.keys(apiResponses).filter(k => k.includes('/chapters')).length;
        const afterRows = await page.evaluate(() => document.querySelectorAll('.title-detail__row, [class*="chapter-row"], tbody tr, .chapters-list > *').length);
        if (afterRows > beforeRows || afterCount > beforeCount) {
          consoleLogs.push(`[LOADMORE] attempt ${attempt}: rows ${beforeRows}→${afterRows}, api ${beforeCount}→${afterCount}`);
        } else {
          consoleLogs.push(`[LOADMORE] no more content after ${attempt} tries`);
          break;
        }
      }
    }

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

    // Try to decode MangaFire __config if present
    let decodedConfig = null;
    try {
      decodedConfig = await page.evaluate(() => {
        if (typeof window.__config !== 'string') return null;
        // Try to find the decoder — MangaFire's SPA usually exposes it via internal functions
        // Search for a function on window that takes a base64 string and returns something
        const keys = Object.keys(window).filter(k =>
          typeof window[k] === 'function' &&
          window[k].toString().includes('base64') &&
          window[k].toString().includes('fromCharCode')
        );
        // Try common decoder names
        for (const name of ['decryptConfig', 'decodeConfig', '_dec', 'dC']) {
          if (typeof window[name] === 'function') {
            try { return window[name](window.__config); } catch {}
          }
        }
        return null;
      });
    } catch {}
    if (decodedConfig) {
      apiResponses['__decoded_config'] = decodedConfig;
    }

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
      api: apiResponses,
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

  if (req.method === 'POST' && parsed.pathname === '/crypt') {
    try {
      const body = await readBody(req);
      if (body.action === 'encrypt') {
        const result = encryptAESGCM(body.data, body.key ? Buffer.from(body.key, 'hex') : undefined);
        return json(res, 200, { ok: true, ...result });
      }
      if (body.action === 'decrypt') {
        const plain = decryptAESGCM(body, body.key ? Buffer.from(body.key, 'hex') : undefined);
        return json(res, 200, { ok: true, data: plain });
      }
      return json(res, 400, { error: 'action must be encrypt or decrypt' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
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
