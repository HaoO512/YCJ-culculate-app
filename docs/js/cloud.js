// 雲端同步 + 推播訂閱（Cloudflare Worker 後端）
const BASE = 'https://yiqiji-sync.haoo512.workers.dev';
const VAPID_PUBLIC = 'BIklPNnHHaruS7zCubOCiKLy2I58tV-PXqXVeADCl5zei_h7KK03X05OP4XwtqhVj5TBWLjGLqMLfut0OF_y8Tc';
const KEY_STORE = 'loanapp.synckey';
const META_STORE = 'loanapp.syncmeta';

export function getKey() {
  let k = localStorage.getItem(KEY_STORE);
  if (!k) {
    const buf = crypto.getRandomValues(new Uint8Array(24));
    k = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(KEY_STORE, k);
  }
  return k;
}

export function setKey(k) { localStorage.setItem(KEY_STORE, k.trim()); }

export function meta() {
  try { return JSON.parse(localStorage.getItem(META_STORE)) || {}; } catch { return {}; }
}

function setMeta(patch) {
  localStorage.setItem(META_STORE, JSON.stringify({ ...meta(), ...patch }));
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'x-key': getKey(), 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error('sync ' + res.status);
  return res.json();
}

// 拉雲端資料；回 {state, updatedAt} 或 null
export async function pull() {
  const r = await api('/data');
  return r && r.state ? r : null;
}

// 推上雲（去抖動 2 秒；失敗留待下次）
let timer = null;
export function schedulePush(getState, onDone) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const state = getState();
      await api('/data', { method: 'PUT', body: JSON.stringify({ state, updatedAt: state.updatedAt || Date.now() }) });
      setMeta({ lastSync: Date.now(), pending: false });
    } catch {
      setMeta({ pending: true });
    }
    if (onDone) onDone();
  }, 2000);
}

export async function pushNow(state) {
  await api('/data', { method: 'PUT', body: JSON.stringify({ state, updatedAt: state.updatedAt || Date.now() }) });
  setMeta({ lastSync: Date.now(), pending: false });
}

function b64uToU8(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

// 開啟自動提醒：要通知權限 + 訂閱推播 + 上報伺服器
export async function enablePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('這支手機的系統不支援通知（iPhone 要 iOS 16.4 以上，且要從主畫面圖示開啟）');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('沒有允許通知。到「設定 → 通知 → 億起記」打開');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64uToU8(VAPID_PUBLIC),
  });
  await api('/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
  setMeta({ pushOn: true });
}

export async function testPush() {
  return api('/test-push', { method: 'POST' });
}
