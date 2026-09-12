// v49.1：救援封存永不遺失 —— 舊裝置本機時間戳較新、直接 PUT 覆蓋的路徑
// 1) Worker PUT /data 伺服器端保底（直接呼叫正式 fetch handler，KV 用記憶體假物件）
// 2) App 端：cloud.pull() 成功後不論誰新都先合併封存，再決定拉或推（真瀏覽器＋雲端攔截）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker, { reconcileArchive, validateState } from '../worker/src/index.js';
import { archiveAndDeleteLoan, today, fmtDate, dueDateFor } from '../docs/js/calc.js';
import { launch, serveStatic } from './helpers/cdp.mjs';

const js = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const workerSrc = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');

const now = today();
const Y = now.getFullYear(), M = now.getMonth();
const due = (k, day) => fmtDate(dueDateFor(Y, M + k, day));
const mkLoan = o => ({ overdueSince: null, finalReceived: null, writeoff: null, prepaidMonths: 0, referralFee: 0, note: '', rate: 2, status: 'normal', ...o });

// 基準帳本：A（已在雲端封存）＋ B（進行中）
const A = mkLoan({ id: 'A', name: '王先生', principal: 300000, startDate: due(-6, 5), dueDay: 5 });
const B = mkLoan({ id: 'B', name: '進行中', principal: 100000, startDate: due(-3, 8), dueDay: 8 });
const payA = [-5, -4, -3].map(k => ({ id: 'pa' + k, loanId: 'A', date: due(k, 5), dueDate: due(k, 5), amount: 6000 }));
const payB = [-2, -1].map(k => ({ id: 'pb' + k, loanId: 'B', date: due(k, 8), dueDate: due(k, 8), amount: 2000 }));
const oldLedger = { version: 1, loans: [A, B], payments: [...payA, ...payB], lastExport: null };   // 舊裝置帳本：沒有 deletedRecords
const T_ARCHIVE = 1789142400000;
const cloudLedger = { ...archiveAndDeleteLoan(oldLedger, 'A', 'closed', T_ARCHIVE), updatedAt: T_ARCHIVE };   // 雲端：A 已封存

// ───────────────── 來源層 ─────────────────
{
  const put = workerSrc.slice(workerSrc.indexOf("url.pathname === '/data' && req.method === 'PUT'"), workerSrc.indexOf("url.pathname === '/snapshots'"));
  const order = ['env.KV.get(`data:${uid}`)', 'reconcileArchive(parsed.state, prev)', 'validateState(rc.state)', "stored.length > 2_000_000", 'env.KV.put(`data:${uid}`, stored)']
    .map(t => put.indexOf(t));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), 'PUT 順序：讀 KV → 合併 → 重新驗證 → 重新檢查 2MB → 寫回');
  assert.ok(workerSrc.includes("import { mergeDeletedRecords } from '../../docs/js/calc.js'"), 'Worker 與 App 同一份合併規則');
  assert.ok(js.includes('function absorbArchive') && js.includes('absorbArchive(r.state);   // 先合併雙方封存，再決定拉或推'), '開機拉取先合併封存');
  const sync = js.slice(js.indexOf("async 'cloud-sync-now'"), js.indexOf("async 'cloud-push-enable'"));
  assert.ok(sync.indexOf('absorbArchive(r.state)') > 0 && sync.indexOf('absorbArchive(r.state)') < sync.indexOf('cloudAt > (state.updatedAt || 0)'), '立即同步也先合併再判斷');
}

// ───────────────── Worker：PUT 保底 ─────────────────
function mkEnv(initial) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    KV: {
      get: async k => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
      list: async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }),
    },
  };
}
const KEY = 'k'.repeat(32);
async function sha(s) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32); }
const uid = await sha(KEY);
const put = (env, state, updatedAt) => worker.fetch(new Request('https://x.workers.dev/data', {
  method: 'PUT', headers: { 'x-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ state: { ...state, updatedAt }, updatedAt }),
}), env);
const stored = env => JSON.parse(env.store.get(`data:${uid}`));

{
  // 必加測試：雲端已有封存 A；舊裝置沒有 deletedRecords、updatedAt 較新、把 A 當正式借款上傳
  const env = mkEnv({ [`data:${uid}`]: JSON.stringify({ state: cloudLedger, updatedAt: T_ARCHIVE }) });
  const newer = T_ARCHIVE + 60_000;
  const res = await put(env, { ...oldLedger, note: undefined }, newer);
  assert.equal(res.status, 200, 'PUT 接受：' + await res.clone().text());
  const body = await res.json();
  assert.equal(body.archiveReconciled, true, '回應標記已合併');
  const kv = stored(env);
  assert.equal(kv.state.deletedRecords.length, 1, 'KV 仍保留封存 A');
  assert.equal(kv.state.deletedRecords[0].loan.id, 'A');
  assert.equal(kv.state.deletedRecords[0].deletedAt, T_ARCHIVE);
  assert.equal(kv.state.deletedRecords[0].payments.length, 3, '封存收款完整');
  assert.ok(!kv.state.loans.some(l => l.id === 'A'), '正式借款 A 不得復活');
  assert.ok(!kv.state.payments.some(p => p.loanId === 'A'), 'A 的收款不得復活');
  assert.ok(kv.state.loans.some(l => l.id === 'B') && kv.state.payments.filter(p => p.loanId === 'B').length === 2, '其他資料照上傳');
  assert.ok(kv.state.tombstones.some(t => t.id === 'A'), '墓碑補上');
  assert.ok(kv.updatedAt > newer && kv.state.updatedAt === kv.updatedAt, '時間戳改成現在：上傳裝置下次會拉回');
  assert.equal(validateState(kv.state), null, '寫回的資料通過驗證');
  assert.ok(env.store.has(`snap:${uid}:${Object.keys(Object.fromEntries(env.store)).find(k => k.startsWith('snap:')).split(':')[2]}`), '覆蓋前仍留快照');

  // 舊裝置再拉回、再正常上傳（已無 A、帶著封存）→ 不再改寫、不動時間戳
  const again = await put(env, { ...kv.state, updatedAt: undefined }, kv.updatedAt + 1);
  assert.equal((await again.json()).archiveReconciled, undefined, '內容一致不再標記合併');
  assert.equal(stored(env).updatedAt, kv.updatedAt + 1, '一致時原樣存、時間戳照上傳');
}
{
  // 雙方都有封存：同 ID 取較新 deletedAt，聯集
  const cloudRec = cloudLedger.deletedRecords[0];
  const olderA = { ...cloudRec, deletedAt: T_ARCHIVE - 1, loan: { ...cloudRec.loan, note: '舊' } };
  const recC = { deletedAt: T_ARCHIVE + 5, reason: 'legal-settled', loan: mkLoan({ id: 'C', name: '法院', principal: 50000, startDate: due(-9, 3), dueDay: 3, status: 'closed', overdueSince: due(-6, 3), closedDate: due(-1, 3), finalReceived: 50000, writeoff: 0 }), payments: [] };
  const env = mkEnv({ [`data:${uid}`]: JSON.stringify({ state: cloudLedger, updatedAt: T_ARCHIVE }) });
  const res = await put(env, { version: 1, loans: [B], payments: payB, lastExport: null, deletedRecords: [olderA, recC] }, T_ARCHIVE + 10);
  assert.equal(res.status, 200);
  const kv = stored(env);
  assert.deepEqual(kv.state.deletedRecords.map(r => r.loan.id), ['A', 'C'], '聯集');
  assert.equal(kv.state.deletedRecords[0].loan.note, '', '同 ID 取雲端較新的');
  // 純函式：完全一致（順序不同）不算變動
  const rc = reconcileArchive({ ...kv.state, deletedRecords: [...kv.state.deletedRecords].reverse() }, kv.state);
  assert.equal(rc.changed, false, '只有順序不同不算變動');
  assert.equal(reconcileArchive(oldLedger, { deletedRecords: [] }).changed, false, '雲端沒有封存就不干預');
}
{
  // 合併後超過 2MB → 413，KV 不變（不能只檢查上傳前 body）
  const bigNote = 'x'.repeat(1_950_000);
  const bigA = { ...cloudLedger.deletedRecords[0], loan: { ...cloudLedger.deletedRecords[0].loan, note: 'y'.repeat(100_000) } };
  const cloud = { ...cloudLedger, deletedRecords: [bigA] };
  const env = mkEnv({ [`data:${uid}`]: JSON.stringify({ state: cloud, updatedAt: T_ARCHIVE }) });
  const res = await put(env, { version: 1, loans: [{ ...B, note: bigNote }], payments: [], lastExport: null }, T_ARCHIVE + 10);
  assert.equal(res.status, 413, '合併後超限拒絕');
  assert.equal(stored(env).state.deletedRecords[0].loan.note.length, 100_000, 'KV 原樣不動');
  // 合併後驗證失敗 → 400（上傳的收款 ID 撞到封存收款 ID）
  const env2 = mkEnv({ [`data:${uid}`]: JSON.stringify({ state: cloudLedger, updatedAt: T_ARCHIVE }) });
  const res2 = await put(env2, { version: 1, loans: [B], payments: [{ ...payB[0], id: 'pa-5' }], lastExport: null }, T_ARCHIVE + 10);
  assert.equal(res2.status, 400);
  assert.ok((await res2.json()).error.startsWith('合併救援封存後驗證失敗'), '合併後重新驗證');
  assert.equal(JSON.parse(env2.store.get(`data:${uid}`)).updatedAt, T_ARCHIVE, '驗證失敗 KV 不動');
}

// ───────────────── App：本機較新也先合併封存 ─────────────────
const srv = await serveStatic(fileURLToPath(new URL('../docs/', import.meta.url)));
const browser = await launch({ width: 375, height: 667 });
const page = browser.page;
let cloudState = null;
await page.mockCloud(e => {
  if (e.method === 'GET') return { status: 200, body: cloudState ? { state: cloudState, updatedAt: cloudState.updatedAt } : { state: null } };
  if (e.method === 'PUT') { cloudState = e.body.state; return { status: 200, body: { ok: true, savedAt: Date.now() } }; }
});
const getState = () => page.eval(`JSON.parse(localStorage.getItem('loanapp.v1'))`);
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await page.goto(srv.url);
  // 本機＝舊裝置帳本（沒有 deletedRecords、A 仍在），且 updatedAt 比雲端新；雲端已封存 A
  cloudState = cloudLedger;
  const localNewer = { ...oldLedger, updatedAt: T_ARCHIVE + 60_000 };
  await page.eval(`localStorage.setItem('loanapp.v1', ${JSON.stringify(JSON.stringify(localNewer))}); localStorage.setItem('loanapp.syncmeta', '{"cloudExists":true}')`);
  await page.reload();
  await wait(2800);   // 開機拉取 → 合併 → 本機較新 → 2 秒去抖動後推送
  const s = await getState();
  assert.equal(s.deletedRecords.length, 1, '本機補回雲端封存 A');
  assert.ok(!s.loans.some(l => l.id === 'A') && !s.payments.some(p => p.loanId === 'A'), '本機的復活 A 被移出');
  assert.equal(s.updatedAt, T_ARCHIVE + 60_000, '合併不動本機時間戳');
  const puts = page.cloudLog.filter(e => e.method === 'PUT');
  assert.ok(puts.length >= 1, '本機較新 → 有推送');
  const last = puts.at(-1).body.state;
  assert.equal(last.deletedRecords.length, 1, '推送內容帶著封存 A');
  assert.ok(!last.loans.some(l => l.id === 'A'), '推送內容沒有復活的 A');
  await page.click('.tab[data-view="people"]');
  await page.waitFor('.plist');
  const txt = await page.eval(`document.getElementById('view').innerText`);
  assert.ok(!txt.includes('王先生') && txt.includes('進行中'), '畫面：A 不出現、B 在');
  assert.equal(page.dialogs.length, 0, '過程無 alert');
} finally {
  await browser.close();
  await srv.close();
}

console.log('v49.1 封存永不遺失（Worker 保底＋App 先合併）全過');
