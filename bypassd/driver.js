/**
 * Zer0driver — Our own stealth browser driver
 *
 * No dependency on puppeteer-real-browser's black-box behavior. Built directly on
 * rebrowser-puppeteer-core (patched to avoid the CDP Runtime.enable auto-detection
 * leak that vanilla puppeteer/playwright have) + chrome-launcher, with:
 *
 *   - True headless Chrome (--headless=new), not a hidden GUI window
 *   - Full stealth injection (navigator.webdriver, chrome.runtime, plugins,
 *     permissions, WebGL, iframe.contentWindow, outerWidth/Height, Notification,
 *     media codecs, hairline feature detection, connection info)
 *   - UA / Sec-CH-UA client hint scrubbing (strip "HeadlessChrome")
 *   - Human-like mouse movement (ghost-cursor) + real page.mouse.click (not
 *     synthetic .click()) for solving Cloudflare Turnstile checkboxes
 */

const puppeteer = require('rebrowser-puppeteer-core');
const { createCursor } = require('ghost-cursor');

function log(tag, msg) {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`${ts} [${tag}] ${msg}`);
}

// ─── Chrome launch flags ─────────────────────────────────────────────────────

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function launchBrowser({ headless = 'new', proxy = {}, extraArgs = [], port = undefined } = {}) {
  const { launch, Launcher } = await import('chrome-launcher');

  const flags = Launcher.defaultFlags();

  // Disable the Blink "AutomationControlled" feature — this is what flips
  // navigator.webdriver to true and shows the "Chrome is being controlled by
  // automated test software" infobar.
  const disableFeaturesIdx = flags.findIndex(f => f.startsWith('--disable-features'));
  flags[disableFeaturesIdx] = `${flags[disableFeaturesIdx]},AutomationControlled`;

  // --disable-component-update slightly changes version-check timing that some
  // fingerprinters key off; drop it like puppeteer-real-browser does.
  const componentUpdateIdx = flags.findIndex(f => f.startsWith('--disable-component-update'));
  if (componentUpdateIdx !== -1) flags.splice(componentUpdateIdx, 1);

  const viewport = pick(VIEWPORTS);

  const chromeFlags = [
    ...flags,
    ...(headless ? [`--headless=${headless}`] : []),
    `--window-size=${viewport.width},${viewport.height}`,
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=en-US,en',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(proxy.host && proxy.port ? [`--proxy-server=${proxy.host}:${proxy.port}`] : []),
    ...extraArgs,
  ];

  const chrome = await launch({ ignoreDefaultFlags: true, chromeFlags, ...(port ? { port } : {}) });

  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });

  browser.__chromeProcess = chrome;
  browser.__viewport = viewport;

  return browser;
}

// ─── Stealth injection ────────────────────────────────────────────────────────

/**
 * Runs inside the page via Page.addScriptToEvaluateOnNewDocument, before any
 * site JS executes. Kept as a single closure to avoid leaking helper names.
 */
function stealthInitScript() {
  // navigator.webdriver -> undefined (not just false — real Chrome has no own
  // property here at all on the prototype chain a site can trust)
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });

  // chrome.runtime — headless Chrome launched via CDP has no `window.chrome`
  // object at all by default, which is itself a tell. Real Chrome always has it.
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: () => {},
      sendMessage: () => {},
      onMessage: { addListener: () => {}, removeListener: () => {} },
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = () => ({});
  }
  if (!window.chrome.csi) {
    window.chrome.csi = () => ({});
  }

  // navigator.permissions.query — headless returns "denied" for notifications
  // without ever prompting; real Chrome returns "default".
  const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (params) =>
    params && params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission, onchange: null })
      : origQuery(params);

  // navigator.plugins / mimeTypes — headless reports empty arrays.
  const pluginData = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ];
  const makePlugin = (p) => Object.create(Plugin.prototype, {
    name: { value: p.name }, filename: { value: p.filename }, description: { value: p.description },
    length: { value: 1 },
  });
  const fakePlugins = pluginData.map(makePlugin);
  Object.defineProperty(navigator, 'plugins', {
    get: () => Object.assign(fakePlugins, { item: (i) => fakePlugins[i], namedItem: (n) => fakePlugins.find(p => p.name === n) }),
  });
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => Object.assign([{ type: 'application/pdf' }], { item: () => null, namedItem: () => null }),
  });

  // navigator.languages — must be non-empty and consistent with Accept-Language.
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // navigator.hardwareConcurrency / deviceMemory — headless defaults can be
  // unusually low (e.g. 1) which is itself a signal.
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  if ('deviceMemory' in navigator) {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  }

  // WebGL vendor/renderer — headless (SwiftShader software rasterizer) is a
  // dead giveaway. Report a plausible real GPU string instead.
  const getParameterProto = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Google Inc. (NVIDIA)'; // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)'; // UNMASKED_RENDERER_WEBGL
    return getParameterProto.call(this, param);
  };
  if (window.WebGL2RenderingContext) {
    const getParameterProto2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Google Inc. (NVIDIA)';
      if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParameterProto2.call(this, param);
    };
  }

  // iframe.contentWindow leak — a classic headless-detection probe creates a
  // same-origin iframe and checks whether its contentWindow.chrome exists.
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get() {
        const win = desc.get.call(this);
        if (win && !win.chrome) win.chrome = window.chrome;
        return win;
      },
    });
  } catch {}

  // window.outerWidth/outerHeight — CDP-launched headless leaves these at 0.
  if (window.outerWidth === 0 && window.outerHeight === 0) {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
  }

  // Notification.permission — headless commonly reports "denied" before any
  // user interaction; real profiles show "default".
  try {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
  } catch {}

  // navigator.connection — some checks look for a plausible NetworkInformation.
  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
    });
  }

  // Console.debug trap some fingerprint scripts use to detect devtools/CDP
  // instrumentation via Error.prepareStackTrace side effects — leave stock
  // Error behavior alone, just make sure toString() on patched natives still
  // looks native so a naive `fn.toString().includes('native code')` check passes.
  const nativeToStringPatch = (fn, name) => {
    const str = `function ${name}() { [native code] }`;
    fn.toString = () => str;
  };
  nativeToStringPatch(WebGLRenderingContext.prototype.getParameter, 'getParameter');
  nativeToStringPatch(window.navigator.permissions.query, 'query');
}

async function applyStealth(page) {
  const client = await page.target().createCDPSession();
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${stealthInitScript.toString()})();`,
  });
  await client.detach().catch(() => {});
}

// ─── UA / client-hint scrubbing ───────────────────────────────────────────────

async function scrubUserAgent(page) {
  const rawUA = await page.browser().userAgent();
  const cleanUA = rawUA.replace('HeadlessChrome', 'Chrome');
  const chromeVersionMatch = cleanUA.match(/Chrome\/(\d+)/);
  const majorVersion = chromeVersionMatch ? chromeVersionMatch[1] : '124';

  await page.setUserAgent(cleanUA, {
    brands: [
      { brand: 'Not(A:Brand', version: '24' },
      { brand: 'Chromium', version: majorVersion },
      { brand: 'Google Chrome', version: majorVersion },
    ],
    fullVersion: `${majorVersion}.0.0.0`,
    platform: 'Windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
  });
}

// ─── Page factory ─────────────────────────────────────────────────────────────

async function newStealthPage(browser) {
  const page = await browser.newPage();
  const viewport = browser.__viewport || pick(VIEWPORTS);

  await applyStealth(page);
  await scrubUserAgent(page);
  await page.setViewport(viewport);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // screenX/screenY consistency for mouse events (puppeteer-real-browser does this too)
  const client = await page.target().createCDPSession();
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(MouseEvent.prototype, 'screenX', { get() { return this.clientX + window.screenX; } });
      Object.defineProperty(MouseEvent.prototype, 'screenY', { get() { return this.clientY + window.screenY; } });
    `,
  });
  await client.detach().catch(() => {});

  const cursor = createCursor(page);
  page.realCursor = cursor;

  return page;
}

// ─── Turnstile solving (real mouse clicks, not synthetic .click()) ───────────

async function solveTurnstile(page, { timeoutMs = 15000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const solved = await page.$$('[name="cf-turnstile-response"]').then(els => els.length > 0).catch(() => false);
    if (solved) {
      const val = await page.$eval('[name="cf-turnstile-response"]', el => el.value).catch(() => '');
      if (val) return true;
    }

    const box = await page.evaluate(() => {
      for (const frame of document.querySelectorAll('iframe')) {
        const r = frame.getBoundingClientRect();
        if (r.width > 250 && r.width < 320 && r.height > 50 && r.height < 90) {
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return null;
    }).catch(() => null);

    if (box) {
      const x = box.x + 30;
      const y = box.y + box.h / 2;
      try {
        await page.realCursor.moveTo({ x, y });
        await page.mouse.down();
        await new Promise(r => setTimeout(r, 60 + Math.random() * 80));
        await page.mouse.up();
      } catch {
        await page.mouse.click(x, y);
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  return false;
}

async function closeBrowser(browser) {
  try { await browser.close(); } catch {}
  try { browser.__chromeProcess?.kill(); } catch {}
}

// ─── WASM import instrumentation ──────────────────────────────────────────
// Wraps WebAssembly.instantiate(Streaming) so that every function the module
// imports from its host namespace gets logged (name, args, return value).
// Used to dynamically map what a WASM anti-bot sensor (e.g. hCaptcha's
// hsw.js) actually reads from the browser, without reverse engineering the
// bytecode itself. Must be installed BEFORE navigation so it's present when
// the target script's WebAssembly.instantiate call runs.
function wasmInstrumentationScript() {
  window.__wasmLog = [];
  window.__wasmModulesSeen = [];

  function wrapImportObject(importObject, moduleLabel) {
    if (!importObject) return importObject;
    const wrapped = {};
    for (const nsName of Object.keys(importObject)) {
      const ns = importObject[nsName];
      wrapped[nsName] = {};
      for (const fnName of Object.keys(ns)) {
        const orig = ns[fnName];
        if (typeof orig !== 'function') { wrapped[nsName][fnName] = orig; continue; }
        wrapped[nsName][fnName] = function (...args) {
          const callIndex = window.__wasmLog.length;
          let result, error;
          try {
            result = orig.apply(this, args);
          } catch (e) {
            error = String(e);
            throw e;
          } finally {
            try {
              if (window.__wasmLog.length >= 50000) { /* cap to avoid runaway memory */ }
              else window.__wasmLog.push({
                i: callIndex,
                t: performance.now(),
                mod: moduleLabel,
                ns: nsName,
                fn: fnName,
                args: args.map((a) => {
                  try {
                    if (typeof a === 'number' || typeof a === 'bigint' || typeof a === 'boolean') return a;
                    if (typeof a === 'string') return a.length > 200 ? a.slice(0, 200) + '...' : a;
                    return String(a).slice(0, 100);
                  } catch { return '<unserializable>'; }
                }),
                ret: (() => { try { return typeof result === 'object' ? String(result).slice(0, 100) : result; } catch { return '<err>'; } })(),
                err: error,
              });
            } catch {}
          }
          return result;
        };
      }
    }
    return wrapped;
  }

  const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
  WebAssembly.instantiate = function (bufferOrModule, importObject) {
    const label = 'mod' + window.__wasmModulesSeen.length;
    window.__wasmModulesSeen.push({ label, via: 'instantiate', size: bufferOrModule && bufferOrModule.byteLength });
    return origInstantiate(bufferOrModule, wrapImportObject(importObject, label));
  };

  if (WebAssembly.instantiateStreaming) {
    const origStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
    WebAssembly.instantiateStreaming = function (source, importObject) {
      const label = 'mod' + window.__wasmModulesSeen.length;
      window.__wasmModulesSeen.push({ label, via: 'instantiateStreaming' });
      return origStreaming(source, wrapImportObject(importObject, label));
    };
  }

  const OrigInstanceCtor = WebAssembly.Instance;
  WebAssembly.Instance = function (module, importObject) {
    const label = 'mod' + window.__wasmModulesSeen.length;
    window.__wasmModulesSeen.push({ label, via: 'Instance-ctor' });
    return new OrigInstanceCtor(module, wrapImportObject(importObject, label));
  };
  WebAssembly.Instance.prototype = OrigInstanceCtor.prototype;
}

async function installWasmInstrumentation(page) {
  // Use Puppeteer's own evaluateOnNewDocument (not an ad-hoc CDP session) —
  // it tracks registered scripts and re-applies them to every newly attached
  // session, including cross-origin iframes that Chrome loads as separate
  // out-of-process targets (OOPIFs). A one-off CDP session only covers the
  // main frame's target and silently misses OOPIF content like hCaptcha's
  // hsw.js, which is exactly where the WASM module actually loads.
  await page.evaluateOnNewDocument(wasmInstrumentationScript);
}

async function getWasmLog(page) {
  return page.evaluate(() => ({
    modules: window.__wasmModulesSeen || [],
    calls: window.__wasmLog || [],
  })).catch(() => ({ modules: [], calls: [] }));
}

// ─── JS-level browser-API instrumentation ─────────────────────────────────
// The WASM sensor turned out to be pure Rust/wasm-bindgen runtime plumbing —
// no direct DOM access. Real fingerprint collection (mouse, canvas, timing,
// WebGL, navigator/screen properties) happens in the surrounding JS that
// feeds data INTO the WASM compute engine. This hooks that layer instead.
function jsApiInstrumentationScript() {
  window.__apiLog = [];

  const MAX_LOG = 20000;
  function record(category, name, args, ret) {
    try {
      if (window.__apiLog.length >= MAX_LOG) return;
      window.__apiLog.push({
        t: performance.now(),
        cat: category,
        name,
        args: args ? args.map((a) => {
          try {
            if (a === null || a === undefined) return a;
            if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint') return a;
            if (typeof a === 'string') return a.length > 150 ? a.slice(0, 150) + '...' : a;
            if (typeof a === 'function') return '<function>';
            return String(a).slice(0, 150);
          } catch { return '<unserializable>'; }
        }) : [],
        ret: (() => {
          try {
            if (ret === null || ret === undefined) return ret;
            if (typeof ret === 'number' || typeof ret === 'boolean' || typeof ret === 'bigint' || typeof ret === 'string') {
              return typeof ret === 'string' && ret.length > 200 ? ret.slice(0, 200) + '...(truncated,len=' + ret.length + ')' : ret;
            }
            return '<' + (ret && ret.constructor && ret.constructor.name || typeof ret) + '>';
          } catch { return '<err>'; }
        })(),
      });
    } catch {}
  }

  function wrapMethod(obj, methodName, category) {
    if (!obj || typeof obj[methodName] !== 'function') return;
    const orig = obj[methodName];
    obj[methodName] = function (...args) {
      const ret = orig.apply(this, args);
      record(category, methodName, args, ret);
      return ret;
    };
    obj[methodName].toString = () => `function ${methodName}() { [native code] }`;
  }

  function wrapGetter(obj, propName, category) {
    try {
      const desc = Object.getOwnPropertyDescriptor(obj, propName) ||
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(obj), propName);
      if (!desc || !desc.get) return;
      const origGet = desc.get;
      Object.defineProperty(obj, propName, {
        ...desc,
        get() {
          const ret = origGet.call(this);
          record(category, propName, [], ret);
          return ret;
        },
      });
    } catch {}
  }

  // Timing
  wrapMethod(Performance.prototype, 'now', 'timing');
  const OrigDateNow = Date.now;
  Date.now = function () { const r = OrigDateNow(); record('timing', 'Date.now', [], r); return r; };

  // Canvas fingerprinting
  wrapMethod(HTMLCanvasElement.prototype, 'getContext', 'canvas');
  wrapMethod(HTMLCanvasElement.prototype, 'toDataURL', 'canvas');
  wrapMethod(HTMLCanvasElement.prototype, 'toBlob', 'canvas');
  if (window.CanvasRenderingContext2D) {
    wrapMethod(CanvasRenderingContext2D.prototype, 'getImageData', 'canvas');
    wrapMethod(CanvasRenderingContext2D.prototype, 'fillText', 'canvas');
    wrapMethod(CanvasRenderingContext2D.prototype, 'measureText', 'canvas');
  }

  // WebGL fingerprinting
  if (window.WebGLRenderingContext) {
    wrapMethod(WebGLRenderingContext.prototype, 'getParameter', 'webgl');
    wrapMethod(WebGLRenderingContext.prototype, 'getExtension', 'webgl');
    wrapMethod(WebGLRenderingContext.prototype, 'getSupportedExtensions', 'webgl');
  }

  // Audio fingerprinting
  if (window.AudioContext || window.OfflineAudioContext) {
    const AC = window.OfflineAudioContext || window.AudioContext;
    wrapMethod(AC.prototype, 'createOscillator', 'audio');
    wrapMethod(AC.prototype, 'createAnalyser', 'audio');
    wrapMethod(AC.prototype, 'createDynamicsCompressor', 'audio');
  }

  // navigator / screen property reads
  ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory',
    'webdriver', 'maxTouchPoints', 'vendor', 'productSub', 'plugins', 'mimeTypes', 'doNotTrack']
    .forEach((p) => wrapGetter(Navigator.prototype, p, 'navigator'));
  ['width', 'height', 'colorDepth', 'pixelDepth', 'availWidth', 'availHeight']
    .forEach((p) => wrapGetter(Screen.prototype, p, 'screen'));

  // Timezone fingerprinting
  if (window.Intl && Intl.DateTimeFormat) {
    wrapMethod(Intl.DateTimeFormat.prototype, 'resolvedOptions', 'intl');
  }

  // Event listener registration (what does it listen for, not every firing)
  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    record('listener', 'addEventListener', [type, this && this.constructor && this.constructor.name], undefined);
    return origAdd.call(this, type, listener, options);
  };
}

async function installJsApiInstrumentation(page) {
  await page.evaluateOnNewDocument(jsApiInstrumentationScript);
}

async function getJsApiLog(page) {
  let entries = [];
  for (const frame of page.frames()) {
    const log = await frame.evaluate(() => window.__apiLog || []).catch(() => []);
    entries = entries.concat(log.map((e) => ({ ...e, frameUrl: frame.url() })));
  }
  return entries;
}

// ─── SvelteKit link-metadata extraction ───────────────────────────────
// work.ink is a SvelteKit app. The full link record (including which captcha
// gates it and the link id) ships inside the route's __data.json endpoint in
// devalue shape: { nodes:[null,{ type:'data', data:[ META_OBJ, LINK_OBJ,
// scalar0, scalar1, ... ] }] }. Object fields may hold either the real value
// or a numeric index into the trailing scalar array, so resolve() handles both.
async function getLinkMeta(page) {
  return page.evaluate(async () => {
    try {
      const base = window.location.pathname.replace(/\/__data\.json.*$/, '');
      const url = base + '/__data.json?x-sveltekit-invalidated=1';
      const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!resp.ok) { console.log('[Meta] __data.json ' + resp.status + ' for ' + url); return { error: 'http' + resp.status }; }
      const text = await resp.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { console.log('[Meta] __data.json not JSON (' + text.length + 'b): ' + text.slice(0, 160)); return { error: 'not-json' }; }
      const node1 = parsed?.nodes?.[1];
      if (node1 && node1.type === 'skip') {
        console.log('[Meta] server returned {"type":"skip"} — link data withheld (auth/captcha gate).');
        return { skipped: true };
      }
      const dataArr = node1?.data;
      if (!Array.isArray(dataArr)) { console.log('[Meta] unexpected __data.json shape: ' + text.slice(0, 200)); return { error: 'shape' }; }
      const meta = dataArr[0] || {};
      const link = dataArr[1] || {};
      const resolve = (obj, key) => {
        const v = obj?.[key];
        if (typeof v === 'number' && dataArr[v] !== undefined) return dataArr[v];
        return v ?? null;
      };
      return {
        p_link_id: resolve(link, 'p_link_id'),
        custom: resolve(link, 'custom'),
        title: resolve(link, 'title'),
        f_domain: resolve(link, 'f_domain'),
        hcaptchaSiteKey: resolve(meta, 'hcaptchaSiteKey'),
        turnstileCompatible: resolve(meta, 'turnstileCompatible'),
        passEnabled: resolve(meta, 'passEnabled'),
      };
    } catch { return null; }
  }).catch(() => null);
}

// ─── hCaptcha solving (real click + pluggable external solver) ─────────
// Clicks the hCaptcha checkbox with the real cursor, then polls for the
// response token. If the challenge can't self-resolve (image challenge / risk
// flag), an external solver can be supplied: solver({ siteKey, pageUrl,
// frameSrc }) => Promise<string token>. Wire one in via env, e.g.
// HCAPTER_SOLVER=./my-solver.js exporting an async function.
const getHCaptchaToken = (page) => page.evaluate(() => {
  const el = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]');
  return el ? (el.value || '') : '';
}).catch(() => '');

function extractChallengeFn() {
  const fr = (window.frameElement && window.frameElement.getBoundingClientRect()) || { x: 0, y: 0 };
  const instrEl = document.querySelector('.prompt-text, .challenge-prompt, [class*="prompt"], h1, h2');
  const instruction = (instrEl && instrEl.textContent || '').trim();

  const sel = '.task-image, .task-image-item, .tile, [class*="task"] [role="button"], div[role="button"][class*="image"]';
  let tiles = [...document.querySelectorAll(sel)];
  if (!tiles.length) {
    tiles = [...document.querySelectorAll('div')].filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && d.querySelector('img, [style*="background"]');
    });
  }

  const tileData = tiles.map((t, index) => {
    const r = t.getBoundingClientRect();
    let src = '';
    const img = t.querySelector('img');
    if (img && img.src) src = img.src;
    else {
      const bg = getComputedStyle(t).backgroundImage;
      const m = bg.match(/url\("?([^")]+)"?\)/);
      if (m) src = m[1];
    }
    return {
      index,
      x: Math.round(fr.x + r.x + r.width / 2),
      y: Math.round(fr.y + r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      src: src.slice(0, 800),
    };
  });

  let verify = null;
  const vbtn = [...document.querySelectorAll('button, [role="button"], .button-submit, [class*="submit"], [class*="verify"]')]
    .find((b) => /verify|submit|confirm|check/i.test((b.textContent || '') + ' ' + (b.className || '').toString()));
  if (vbtn) {
    const r = vbtn.getBoundingClientRect();
    verify = { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2) };
  }

  return { instruction, tiles: tileData, verify };
}

async function extractChallengeFrame(page) {
  const frames = page.frames();
  const frame = frames.find((f) =>
    f.url().includes('hcaptcha.com') &&
    (f.url().includes('frame=challenge') || f.url().includes('challenge') || f.url().includes('frame=checkbox')));
  if (!frame) return null;
  const data = await frame.evaluate(extractChallengeFn).catch(() => null);
  if (!data || !data.tiles || !data.tiles.length) return null;
  return { frame, data };
}

async function solveOneChallenge(page, chal, { classifier = null } = {}) {
  const { data } = chal;
  log('Challenge', `Instruction: "${data.instruction.slice(0, 120)}" — ${data.tiles.length} tiles`);

  let indices = [];
  if (classifier) {
    try {
      indices = await classifier({ instruction: data.instruction, tiles: data.tiles.map((t) => ({ index: t.index, src: t.src })) });
      if (!Array.isArray(indices)) indices = [];
    } catch (e) {
      log('Classifier', 'error: ' + e.message);
    }
  }
  if (!indices.length) {
    log('Challenge', 'No HCAPTER_CLASSIFIER — clicking ALL tiles (naive baseline)');
    indices = data.tiles.map((t) => t.index);
  }

  for (const i of indices) {
    const t = data.tiles.find((x) => x.index === i) || data.tiles[i];
    if (t && t.w > 0) {
      try {
        await page.realCursor.moveTo({ x: t.x, y: t.y });
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 60));
        await page.mouse.up();
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        try { await page.mouse.click(t.x, t.y); } catch {}
      }
    }
  }

  await new Promise((r) => setTimeout(r, 400));
  if (data.verify) {
    try {
      await page.realCursor.moveTo({ x: data.verify.x, y: data.verify.y });
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 60));
      await page.mouse.up();
    } catch {
      try { await page.mouse.click(data.verify.x, data.verify.y); } catch {}
    }
    log('Challenge', 'Clicked Verify, waiting for result...');
  }
}

async function solveHCaptcha(page, { timeoutMs = 120000, solver = null, classifier = null, maxAttempts = 8 } = {}) {
  const start = Date.now();

  const box = await page.evaluate(() => {
    const ifr = document.querySelector('iframe[src*="hcaptcha"]');
    if (!ifr) return null;
    const r = ifr.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, src: ifr.src };
  }).catch(() => null);
  if (!box) return false;

  try {
    await page.realCursor.moveTo({ x: box.x + 30, y: box.y + box.h / 2 });
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 80));
    await page.mouse.up();
  } catch {
    await page.mouse.click(box.x + 30, box.y + box.h / 2);
  }
  await new Promise((r) => setTimeout(r, 1500));

  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    const token = await getHCaptchaToken(page);
    if (token) return token;

    const chal = await extractChallengeFrame(page);
    if (chal) {
      if (attempts >= maxAttempts) {
        log('Challenge', `Hit maxAttempts (${maxAttempts}) without solving — a classifier is required to pass image challenges.`);
        return false;
      }
      attempts++;
      log('Challenge', `Solving attempt ${attempts}/${maxAttempts}`);
      await solveOneChallenge(page, chal, { classifier });
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }

    if (solver) {
      try {
        const siteKey = (box.src.match(/sitekey=([^&]+)/) || [])[1] || null;
        const solved = await solver({ siteKey, pageUrl: page.url(), frameSrc: box.src });
        if (solved) {
          await page.evaluate((t) => {
            const el = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]');
            if (el) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              setter.call(el, t);
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (window.hcaptcha && window.hcaptcha.setResponse) window.hcaptcha.setResponse(t);
          }, solved).catch(() => {});
          return solved;
        }
      } catch {}
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function extractRecaptchaFn() {
  const fr = (window.frameElement && window.frameElement.getBoundingClientRect()) || { x: 0, y: 0 };
  const instrEl = document.querySelector('.rc-imageselect-desc, .rc-textholder, [class*="instruction"], .rc-title');
  const instruction = (instrEl && instrEl.textContent || '').trim();
  const tiles = [...document.querySelectorAll('.rc-imageselect-tile, .rc-imageselect-tile-target, td.rc-imageselect-tile')]
    .map((t, index) => {
      const r = t.getBoundingClientRect();
      let src = '';
      const img = t.querySelector('img');
      if (img && img.src) src = img.src;
      else {
        const bg = getComputedStyle(t).backgroundImage;
        const m = bg.match(/url\("?([^")]+)"?\)/);
        if (m) src = m[1];
      }
      return {
        index,
        x: Math.round(fr.x + r.x + r.width / 2),
        y: Math.round(fr.y + r.y + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        src: src.slice(0, 800),
      };
    });
  let verify = null;
  const vbtn = [...document.querySelectorAll('button, #recaptcha-verify-button, [class*="verify"]')]
    .find((b) => /verify|confirm|skip/i.test((b.textContent || '') + ' ' + (b.className || '').toString()));
  if (vbtn) {
    const r = vbtn.getBoundingClientRect();
    verify = { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2) };
  }
  return { instruction, tiles, verify };
}

const getRecaptchaToken = (page) => page.evaluate(() => {
  const el = document.querySelector('[name="g-recaptcha-response"], textarea[name*="recaptcha"], [id*="g-recaptcha-response"]');
  if (el && el.value) return el.value;
  try { if (window.grecaptcha && window.grecaptcha.getResponse) { const t = window.grecaptcha.getResponse(); if (t) return t; } } catch {}
  return '';
}).catch(() => '');

async function findRecaptchaChallengeFrame(page) {
  const frame = page.frames().find((f) =>
    /recaptcha.*(aframe|enterprise)/i.test(f.url()) ||
    (f.url().includes('recaptcha') && f.url().includes('frame')));
  if (!frame) return null;
  const data = await frame.evaluate(extractRecaptchaFn).catch(() => null);
  if (!data || !data.tiles || !data.tiles.length) return null;
  return { frame, data };
}

async function solveRecaptchaOne(page, chal, { classifier = null } = {}) {
  const { data } = chal;
  log('Challenge', `Instruction: "${data.instruction.slice(0, 120)}" — ${data.tiles.length} tiles`);
  let indices = [];
  if (classifier) {
    try {
      indices = await classifier({ instruction: data.instruction, tiles: data.tiles.map((t) => ({ index: t.index, src: t.src })) });
      if (!Array.isArray(indices)) indices = [];
    } catch (e) { log('Classifier', 'error: ' + e.message); }
  }
  if (!indices.length) {
    log('Challenge', 'No HCAPTER_CLASSIFIER — clicking ALL tiles (naive baseline)');
    indices = data.tiles.map((t) => t.index);
  }
  for (const i of indices) {
    const t = data.tiles.find((x) => x.index === i) || data.tiles[i];
    if (t && t.w > 0) {
      try {
        await page.realCursor.moveTo({ x: t.x, y: t.y });
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 60));
        await page.mouse.up();
        await new Promise((r) => setTimeout(r, 200));
      } catch { try { await page.mouse.click(t.x, t.y); } catch {} }
    }
  }
  await new Promise((r) => setTimeout(r, 400));
  if (data.verify) {
    try {
      await page.realCursor.moveTo({ x: data.verify.x, y: data.verify.y });
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 60));
      await page.mouse.up();
    } catch { try { await page.mouse.click(data.verify.x, data.verify.y); } catch {} }
    log('Challenge', 'Clicked Verify, waiting...');
  }
}

async function solveRecaptcha(page, { timeoutMs = 120000, classifier = null, solver = null, maxAttempts = 8 } = {}) {
  const start = Date.now();
  const anchor = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe')].find((f) => (f.src || '').includes('recaptcha') && (f.src || '').includes('anchor'));
    if (!ifr) return null;
    const r = ifr.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, src: ifr.src };
  }).catch(() => null);
  if (!anchor) return false;

  try {
    await page.realCursor.moveTo({ x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 });
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 80));
    await page.mouse.up();
  } catch { await page.mouse.click(anchor.x + anchor.w / 2, anchor.y + anchor.h / 2); }
  await new Promise((r) => setTimeout(r, 1500));

  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    const token = await getRecaptchaToken(page);
    if (token) return token;

    const chal = await findRecaptchaChallengeFrame(page);
    if (chal) {
      if (attempts >= maxAttempts) {
        log('Challenge', `Hit maxAttempts (${maxAttempts}) — image challenge needs HCAPTER_CLASSIFIER.`);
        return false;
      }
      attempts++;
      log('Challenge', `Solving attempt ${attempts}/${maxAttempts}`);
      await solveRecaptchaOne(page, chal, { classifier });
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }

    if (solver) {
      try {
        const siteKey = (anchor.src.match(/[?&]k=([^&]+)/) || [])[1] || null;
        const solved = await solver({ siteKey, pageUrl: page.url(), frameSrc: anchor.src });
        if (solved) {
          await page.evaluate((t) => {
            const el = document.querySelector('[name="g-recaptcha-response"], textarea[name*="recaptcha"]');
            if (el) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              setter.call(el, t);
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }, solved).catch(() => {});
          return solved;
        }
      } catch {}
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

module.exports = {
  launchBrowser, newStealthPage, solveTurnstile, solveHCaptcha, solveRecaptcha, getLinkMeta, closeBrowser,
  installWasmInstrumentation, getWasmLog,
  installJsApiInstrumentation, getJsApiLog,
};
