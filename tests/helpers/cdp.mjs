// 零依賴瀏覽器測試殼：以 Chrome DevTools Protocol 驅動本機 Chrome／Edge headless
// - 靜態伺服 docs/（ES module 不能走 file://）
// - 封鎖 *.workers.dev：測試資料絕不上雲、不佔雲端名額
// - alert/confirm/prompt 自動接受（App 仍有 alert 提示），並記錄下來供斷言
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);

export function findBrowser() {
  const p = CANDIDATES.find(existsSync);
  if (!p) throw new Error('找不到 Chrome／Edge，請設定環境變數 CHROME_PATH');
  return p;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

export async function serveStatic(root) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const buf = await readFile(join(root, p));
      res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r)) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    this.dialogs = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (!p) return;
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach(fn => fn(msg.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  once(method) { return new Promise(r => { const fn = p => { r(p); }; this.on(method, fn); }); }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    this.on('Page.javascriptDialogOpening', p => {
      this.dialogs.push({ type: p.type, message: p.message });
      this.send('Page.handleJavaScriptDialog', { accept: true, promptText: p.defaultPrompt || '' }).catch(() => {});
    });
  }
  // iPhone 尺寸模擬：寬度可換（320／375／430），啟用觸控
  async mobile(width, height = 667) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  async goto(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(80);   // module script 執行後首次 render
  }
  async reload() {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.reload');
    await loaded;
    await sleep(80);
  }
  // 在頁面執行表達式（可 await），回傳 JSON 值；頁面丟錯就在這裡丟錯
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('頁面錯誤: ' + (d.exception?.description || d.text));
    }
    return r.result.value;
  }
  async waitFor(selector, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
      await sleep(30);
    }
    throw new Error(`等不到元素 ${selector}`);
  }
  async waitGone(selector, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
      await sleep(30);
    }
    throw new Error(`元素未消失 ${selector}`);
  }
  async click(selector) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); el.click(); })()`);
    await sleep(40);
  }
  // 攔截雲端 API（*.workers.dev）：不出網，交給 handler({method,url,body}) 決定回應 {status, body}
  // 所有請求（含 CORS 預檢）都記在 page.cloudLog，測試可斷言上傳內容
  async mockCloud(handler) {
    this.cloudLog = [];
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*workers.dev*', requestStage: 'Request' }] });
    const cors = [
      { name: 'access-control-allow-origin', value: '*' },
      { name: 'access-control-allow-methods', value: 'GET,PUT,POST,OPTIONS' },
      { name: 'access-control-allow-headers', value: 'content-type,x-key' },
    ];
    this.on('Fetch.requestPaused', async p => {
      const req = p.request;
      let body = null;
      try { body = req.postData ? JSON.parse(req.postData) : null; } catch {}
      const entry = { method: req.method, url: req.url, body };
      this.cloudLog.push(entry);
      let r = req.method === 'OPTIONS' ? { status: 204 } : (handler(entry) || { status: 404, body: { error: 'not found' } });
      const text = r.body == null ? '' : JSON.stringify(r.body);
      await this.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: r.status || 200,
        responseHeaders: [...cors, { name: 'content-type', value: 'application/json' }],
        body: Buffer.from(text).toString('base64'),
      }).catch(() => {});
    });
  }
  // 把本機檔案塞進 <input type=file>（觸發 change → App 走真正的匯入流程）
  async setFile(selector, path) {
    await this.send('DOM.enable');
    const { root } = await this.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error('no ' + selector);
    await this.send('DOM.setFileInputFiles', { files: [path], nodeId });
    await sleep(60);
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  // 真實觸控拖動：touchStart → 多次 touchMove → touchEnd（走瀏覽器手勢辨識，受 touch-action 約束）
  // steps 少＝快速甩動；stepDelay 大＝慢速拖動
  async touchScroll(x, y, distance, { steps = 10, stepDelay = 0 } = {}) {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - distance * i / steps }] });
      if (stepDelay) await sleep(stepDelay);
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(150);
  }
}

export async function launch({ width = 375, height = 667 } = {}) {
  const bin = findBrowser();
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'loanapp-cdp-'));
  const proc = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-background-networking', '--disable-sync', '--disable-extensions',
    '--host-resolver-rules=MAP *.workers.dev ~NOTFOUND',   // 同步 API 一律連不上：測試資料不上雲
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      if (list.some(t => t.type === 'page')) targets = list;
    } catch { /* 尚未就緒 */ }
    if (!targets) await sleep(100);
  }
  if (!targets) { proc.kill(); throw new Error('瀏覽器 DevTools 未就緒'); }
  const t = targets.find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const page = new Page(ws);
  await page.init();
  await page.mobile(width, height);

  return {
    page, bin,
    async close() {
      try { ws.close(); } catch {}
      proc.kill();
      await sleep(200);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}
