// 億起記 同步後端：Cloudflare Worker
// - PUT/GET /data     帳目同步（x-key 金鑰驗證，KV 儲存）
// - 每日快照保留 31 天，GET /snapshots、POST /restore
// - POST /subscribe   登記 Web Push 訂閱
// - POST /test-push   測試推播
// - cron 台北 09:30   明天/今天收息 → 推播

// ── 工具 ──
const enc = new TextEncoder();

function b64uToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function bufToB64u(buf) {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrs) {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function sha256hex(s) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 台北時間的今天（回傳 y/m/d，m 0-based）
function taipeiToday() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

function tpeDateStr() {
  const { y, m, d } = taipeiToday();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ── 收息日計算（與 App 端 calc.js 同邏輯的精簡版）──
function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
// 29–31：當月沒有該號就退到月底
function dueDayOf(y, m, dueDay) {
  const last = daysInMonth(y, m);
  return dueDay === 'EOM' ? last : Math.min(dueDay, last);
}

function cmpYMD(a, b) { // [y,m,d]
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d]; }

function addMonth([y, m, d], dueDay) {
  const ny = m === 11 ? y + 1 : y, nm = (m + 1) % 12;
  return [ny, nm, dueDayOf(ny, nm, dueDay)];
}

function firstDueAfter(loan, [y, m, d]) {
  let cur = [y, m, dueDayOf(y, m, loan.dueDay)];
  if (cmpYMD(cur, [y, m, d]) <= 0) cur = addMonth([y, m, cur[2]], loan.dueDay);
  return cur;
}

// 期初先收制：簽約日當期算第 1 期
function prepaidUntilYMD(loan) {
  const n = loan.prepaidMonths || 0;
  if (n <= 0) return null;
  const s = parseYMD(loan.startDate);
  let cur = [s[0], s[1], dueDayOf(s[0], s[1], loan.dueDay)];
  if (cmpYMD(cur, s) < 0) cur = addMonth(cur, loan.dueDay);
  for (let i = 1; i < n; i++) cur = addMonth(cur, loan.dueDay);
  return cur;
}

function monthlyInterest(loan) { return Math.round(loan.principal * loan.rate / 100); }

function settled(state, loan, y, m) {
  const paid = (state.payments || []).some(p => {
    if (p.loanId !== loan.id) return false;
    const [py, pm] = parseYMD(p.date);
    return py === y && pm === m;
  });
  if (paid) return true;
  const pu = prepaidUntilYMD(loan);
  if (!pu) return false;
  return cmpYMD([y, m, dueDayOf(y, m, loan.dueDay)], pu) <= 0;
}

// 算出今天要發的提醒
function buildReminders(state) {
  const { y, m, d } = taipeiToday();
  const tm = new Date(Date.UTC(y, m, d + 1));
  const tY = tm.getUTCFullYear(), tM = tm.getUTCMonth(), tD = tm.getUTCDate();
  const msgs = [];
  for (const loan of state.loans || []) {
    if (loan.status !== 'normal') continue;
    const s = parseYMD(loan.startDate);
    if (cmpYMD([tY, tM, tD], s) < 0) continue; // 借款日還沒到
    const mi = monthlyInterest(loan);
    if (dueDayOf(tY, tM, loan.dueDay) === tD && !settled(state, loan, tY, tM)) {
      msgs.push({ title: '明天要收利息', body: `明天收 ${loan.name} 利息 $${mi.toLocaleString('en-US')}` });
    }
    if (dueDayOf(y, m, loan.dueDay) === d && !settled(state, loan, y, m)) {
      msgs.push({ title: '今天要收利息', body: `今天收 ${loan.name} 利息 $${mi.toLocaleString('en-US')}` });
    }
  }
  return msgs;
}

// ── Web Push（RFC 8291 aes128gcm + RFC 8292 VAPID）──
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

async function vapidJWT(aud, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = bufToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bufToB64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:haoo.c.512@gmail.com',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${bufToB64u(sig)}`;
}

async function sendPush(sub, msg, env) {
  const payload = enc.encode(JSON.stringify(msg));
  const uaPubRaw = b64uToBuf(sub.keys.p256dh);
  const authSecret = b64uToBuf(sub.keys.auth);

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = await crypto.subtle.importKey('raw', uaPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPub }, asKeys.privateKey, 256));
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPubRaw, asPubRaw), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const record = concat(payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const body = concat(salt, rs, new Uint8Array([asPubRaw.length]), asPubRaw, ct);

  const jwt = await vapidJWT(new URL(sub.endpoint).origin, env);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400',
      'Urgency': 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    },
    body,
  });
  return res.status; // 201 成功；404/410 訂閱失效
}

async function pushAll(uid, msgs, env) {
  const raw = await env.KV.get(`push:${uid}`);
  if (!raw) return 0;
  let subs = JSON.parse(raw);
  const dead = [];
  let sent = 0;
  for (const sub of subs) {
    for (const msg of msgs) {
      const st = await sendPush(sub, msg, env).catch(() => 0);
      if (st === 404 || st === 410) { dead.push(sub.endpoint); break; }
      if (st >= 200 && st < 300) sent++;
    }
  }
  if (dead.length) {
    subs = subs.filter(s => !dead.includes(s.endpoint));
    await env.KV.put(`push:${uid}`, JSON.stringify(subs));
  }
  return sent;
}

// ── HTTP ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-key',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const key = req.headers.get('x-key') || '';
    if (url.pathname === '/health') return json({ ok: true });
    if (key.length < 24) return json({ error: 'bad key' }, 401);
    const uid = (await sha256hex(key)).slice(0, 32);

    if (url.pathname === '/data' && req.method === 'GET') {
      const raw = await env.KV.get(`data:${uid}`);
      return raw ? new Response(raw, { headers: { 'content-type': 'application/json', ...CORS } }) : json({ state: null });
    }

    if (url.pathname === '/data' && req.method === 'PUT') {
      const body = await req.text();
      if (body.length > 2_000_000) return json({ error: 'too big' }, 413);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400); }
      if (!parsed.state || !Array.isArray(parsed.state.loans)) return json({ error: 'bad shape' }, 400);
      // 當日第一次寫入前，把舊資料存成快照
      const day = tpeDateStr();
      const snapKey = `snap:${uid}:${day}`;
      const existing = await env.KV.get(`data:${uid}`);
      if (existing && !(await env.KV.get(snapKey))) {
        await env.KV.put(snapKey, existing, { expirationTtl: 31 * 86400 });
      }
      await env.KV.put(`data:${uid}`, body);
      return json({ ok: true, savedAt: Date.now() });
    }

    if (url.pathname === '/snapshots' && req.method === 'GET') {
      const list = await env.KV.list({ prefix: `snap:${uid}:` });
      return json({ dates: list.keys.map(k => k.name.split(':')[2]) });
    }

    if (url.pathname === '/restore' && req.method === 'POST') {
      const { date } = await req.json();
      const snap = await env.KV.get(`snap:${uid}:${date}`);
      if (!snap) return json({ error: 'no snapshot' }, 404);
      const cur = await env.KV.get(`data:${uid}`);
      if (cur) await env.KV.put(`snap:${uid}:restore-${Date.now()}`, cur, { expirationTtl: 31 * 86400 });
      await env.KV.put(`data:${uid}`, snap);
      return json({ ok: true });
    }

    if (url.pathname === '/subscribe' && req.method === 'POST') {
      const { subscription } = await req.json();
      if (!subscription || !subscription.endpoint) return json({ error: 'bad sub' }, 400);
      const raw = await env.KV.get(`push:${uid}`);
      const subs = raw ? JSON.parse(raw) : [];
      if (!subs.some(s => s.endpoint === subscription.endpoint)) subs.push(subscription);
      await env.KV.put(`push:${uid}`, JSON.stringify(subs));
      return json({ ok: true, count: subs.length });
    }

    if (url.pathname === '/test-push' && req.method === 'POST') {
      const sent = await pushAll(uid, [{ title: '億起記', body: '測試成功！收息前一天早上 9:30 會在這裡提醒你。' }], env);
      return json({ ok: true, sent });
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const list = await env.KV.list({ prefix: 'data:' });
      for (const k of list.keys) {
        const uid = k.name.slice(5);
        const raw = await env.KV.get(k.name);
        if (!raw) continue;
        let state;
        try { state = JSON.parse(raw).state; } catch { continue; }
        if (!state) continue;
        const msgs = buildReminders(state);
        if (msgs.length) await pushAll(uid, msgs, env);
      }
    })());
  },
};
