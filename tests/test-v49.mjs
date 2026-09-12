// v49：借款頁取消結案分頁＋結案刪除借款（完整封存 deletedRecords 供救援）＋舊 closed 遷移＋三層驗證
// 前半：來源層、純函式、三層驗證、Excel 往返；後半：真實 Chrome/Edge headless 跑 App（含雲端 API 攔截、Excel 匯入）
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  today, fmtDate, dueDateFor, monthlyInterest, monthReport, stats, upcomingDues, missedDues, monthlySeries,
  archiveAndDeleteLoan, mergeDeletedRecords, migrateLegacyClosed, ARCHIVE_REASONS, overdueInterest,
} from '../docs/js/calc.js';
import { buildStopAllICS, buildICS } from '../docs/js/ics.js';
import { validateState as workerValidate, buildReminders } from '../worker/src/index.js';
import { launch, serveStatic } from './helpers/cdp.mjs';

const read = f => readFileSync(new URL('../docs/' + f, import.meta.url), 'utf8');
const js = read('js/app.js');
const css = read('css/app.css');
const calcSrc = read('js/calc.js');
const storeSrc = read('js/store.js');
const xlsxSrc = read('js/xlsx-io.js');
const workerSrc = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');

// ───────────────── 測試資料（相對今天產生） ─────────────────
const now = today();
const Y = now.getFullYear(), M = now.getMonth();
const due = (k, day) => fmtDate(dueDateFor(Y, M + k, day));
const DEL_ID = 'del1', DEL_NAME = '彭琮翔';
const mkLoan = (o) => ({ overdueSince: null, finalReceived: null, writeoff: null, prepaidMonths: 0, referralFee: 0, note: '', rate: 2, ...o });

// v48 版資料：含兩筆舊 closed（一筆法院結案有沖銷、一筆舊版無結清日）＋ 39 筆收款的刪除目標
function fixture() {
  const loans = [], payments = [];
  for (let i = 1; i <= 20; i++) {
    const day = Math.min(1 + i, 28);
    loans.push(mkLoan({ id: 'n' + i, name: `借款人${String(i).padStart(2, '0')}`, principal: 100000 + i * 10000,
      startDate: due(-5, day), dueDay: day, status: 'normal', referralFee: 1000 }));
    for (let k = -4; k <= -1; k++) {
      payments.push({ id: `n${i}p${k}`, loanId: 'n' + i, date: due(k, day), dueDate: due(k, day), amount: monthlyInterest(loans.at(-1)) });
    }
  }
  // 刪除目標：本金 65 萬、月息 13,000、39 筆收款（開始 40 個月前）
  loans.push(mkLoan({ id: DEL_ID, name: DEL_NAME, principal: 650000, startDate: due(-40, 10), dueDay: 10, status: 'normal', referralFee: 6500, note: '大戶' }));
  for (let k = -39; k <= -1; k++) payments.push({ id: `dp${k}`, loanId: DEL_ID, date: due(k, 10), dueDate: due(k, 10), amount: 13000 });
  loans.push(mkLoan({ id: 'miss1', name: '漏收甲', principal: 300000, startDate: due(-4, 10), dueDay: 10, status: 'normal', referralFee: 3000 }));
  loans.push(mkLoan({ id: 'ovd1', name: '欠繳乙', principal: 400000, startDate: due(-6, 10), dueDay: 10, status: 'overdue', overdueSince: due(-2, 10), referralFee: 4000 }));
  loans.push(mkLoan({ id: 'leg1', name: '法院丙', principal: 500000, startDate: due(-8, 10), dueDay: 10, status: 'legal', overdueSince: due(-3, 10), referralFee: 5000 }));
  loans.push(mkLoan({ id: 'cls1', name: '結案丁', principal: 200000, startDate: due(-9, 10), dueDay: 10, status: 'closed',
    overdueSince: due(-5, 10), closedDate: due(-1, 10), finalReceived: 190000, writeoff: 22000, referralFee: 2000 }));
  payments.push({ id: 'cp1', loanId: 'cls1', date: due(-8, 10), dueDate: due(-8, 10), amount: 4000 });
  loans.push(mkLoan({ id: 'cls0', name: '舊結清戊', principal: 150000, startDate: due(-12, 10), dueDay: 10, status: 'closed', referralFee: 1500 }));
  payments.push({ id: 'cp2', loanId: 'cls0', date: due(-11, 10), dueDate: due(-11, 10), amount: 3000 });
  return { version: 1, loans, payments, lastExport: fmtDate(now), tombstones: [{ id: 'old-gone', name: '早已刪', dueDay: 5, startDate: '2024-01-05' }] };
}
const deepFreeze = o => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

// ───────────────── 一、來源層 ─────────────────
{
  // 1：借款頁完全沒有分頁；結案資料無入口
  for (const t of ['peopleTab', "'people-tab'", 'data-tab="closed"', 'data-tab="running"', '結案紀錄', '沒有結案紀錄',
    '借款 → 結案紀錄', 'noClosedDate', 'loanapp.closedNotice', "'reopen'", "'fill-closed'", '撤銷結清', '補填結清日',
    '刪除錯帳', '本金已還清', 'close-normal', "closed: '已結清'", "closed: 'done'"]) {
    assert.ok(!js.includes(t), `app.js 不得再含：${t}`);
  }
  assert.ok(js.includes("'<div class=\"empty\">還沒有借款，按上面「＋新增」</div>'"), '空狀態只剩一句');
  assert.ok(css.includes('.seg {'), '.seg 樣式保留（月報頁仍用）');
  assert.ok(js.includes('data-action="stats-tab"'), '月報分段切換仍在');
  // 3：進行中四種詳情（正常漏收／正常／欠繳／法院）更多操作各一顆紅色「結案刪除借款」，沿用 delete-loan
  const detail = js.slice(js.indexOf('function viewDetail'), js.indexOf('function viewForm'));
  const btns = detail.match(/<button class="btn outline-red" data-action="delete-loan" data-id="\$\{l\.id\}">結案刪除借款<\/button>/g) || [];
  assert.equal(btns.length, 4, '四種狀態各一顆結案刪除借款（紅色）');
  assert.equal((detail.match(/data-action="delete-loan"/g) || []).length, 4, '沒有第二顆同功能按鈕');
  assert.ok(!detail.includes('已結清'), '詳情頁不再有已結清畫面');
  // 確認面板與訊息
  for (const t of ['結案並刪除這筆借款？', '將移除 ${pays.length} 筆收款，共 ${money(total)}',
    'App、月報、總覽及一般 Excel 將不再顯示', '完整資料會保留供救援', "ok: '結案刪除借款', danger: true",
    'toast(`「${l.name}」已結案刪除`)']) {
    assert.ok(js.includes(t), `文案：${t}`);
  }
  // 4：單次原子操作：純函式產生 nextState、只 save 一次、失敗不動原資料
  assert.ok(js.includes("archiveAndDeleteLoan(state, l.id, 'closed', Date.now())"), '結案刪除走純函式');
  assert.ok(js.includes("archiveAndDeleteLoan(patched, l.id, 'legal-settled', Date.now())"), '法院結案走純函式封存');
  assert.ok(!js.includes("l.status = 'closed'"), '法院結案不再直接把正式區借款改成 closed');
  const ca = js.slice(js.indexOf('function commitArchive'), js.indexOf('function adoptState'));
  assert.ok(ca.includes('try { save(next); }') && ca.includes('結案失敗，原本資料沒有變動') && ca.includes('state = next;'), '寫入成功才換 state');
  assert.ok(ca.indexOf('save(next)') < ca.indexOf('state = next;'), '先存檔、後換畫面');
  assert.ok(ca.includes('cloud.payloadSize(next) > cloud.MAX_BODY') && ca.includes('請先到設定「匯出 Excel 檔」備份'), '容量上限：阻止並提示匯出');
  assert.equal((js.match(/save\(next\)/g) || []).length, 1, '封存流程只呼叫一次 save');
  const del = js.slice(js.indexOf("async 'delete-loan'"), js.indexOf("async 'delegal'"));
  assert.ok(!del.includes('state.payments.push') && !del.includes('writeoff'), '刪除不補利息、不產生壞帳');
  assert.ok(!del.includes('state.loans =') && !del.includes('state.payments ='), '刪除不直接改 state，只換整份 nextState');
  // 3（純函式）：deletedRecords 不裁切
  const af = calcSrc.slice(calcSrc.indexOf('export function archiveAndDeleteLoan'), calcSrc.indexOf('export function mergeDeletedRecords'));
  assert.ok(!/deletedRecords[^\n]*slice\(/.test(af), 'deletedRecords 不得 slice 裁切');
  assert.deepEqual(ARCHIVE_REASONS, ['closed', 'legal-settled', 'legacy-closed'], 'reason 枚舉');
  // 7：遷移套用在本機載入、雲端拉取、Excel 匯入
  assert.ok(storeSrc.includes('migrateLegacyClosed(s)') && storeSrc.includes('if (m.changed) save(s, false)'), '本機載入遷移、只存一次');
  assert.ok(storeSrc.indexOf('migrateLegacyClosed(s)') < storeSrc.indexOf('validateState(s);'), '遷移先於驗證：舊 closed 不判損壞');
  assert.equal((js.match(/state = adoptState\(r\.state/g) || []).length, 3, '雲端拉取三處都經 adoptState（合併封存＋遷移）');
  assert.ok(js.includes('state = migrateLegacyClosed(result.state).state'), 'Excel 匯入後遷移');
  // 8、9：匯入不得復活、救援合併
  assert.ok(js.includes('已結案刪除，不能透過一般匯入復活。'), '匯入阻擋復活');
  assert.ok(js.includes('mergeDeletedRecords(state.deletedRecords, result.state.deletedRecords)'), '匯入合併救援資料');
  assert.ok(!js.includes('restore-archive') && !js.includes('還原封存'), 'App 不提供還原按鈕');
  // 10：三層驗證都認得 deletedRecords 與 closed 相容
  for (const [name, src] of [['store.js', storeSrc], ['Worker', workerSrc], ['xlsx-io.js', xlsxSrc]]) {
    assert.ok(src.includes('deletedRecords') || src.includes('系統救援'), `${name} 有救援封存驗證`);
  }
  assert.ok(storeSrc.includes("['normal', 'overdue', 'legal', 'closed']") && workerSrc.includes("['normal', 'overdue', 'legal', 'closed']"), '相容層仍接受 closed');
  assert.ok(workerSrc.includes('body.length > 2_000_000'), 'Worker 2MB 上限維持');
  assert.ok(xlsxSrc.includes("'系統救援_借款'") && xlsxSrc.includes("'系統救援_收款'"), 'Excel 兩張救援表');
}

// ───────────────── 二、純函式：封存、隔離、遷移、合併 ─────────────────
const fx = fixture();
{
  const base = migrateLegacyClosed(structuredClone(fx)).state;
  const before = JSON.stringify(base);
  deepFreeze(base);
  const t0 = 1789142400000;
  const next = archiveAndDeleteLoan(base, DEL_ID, 'closed', t0);
  assert.equal(JSON.stringify(base), before, '原 state 完全不動（純函式）');
  // 5、6：借款與 39 筆收款從正式區消失，完整進封存
  assert.ok(!next.loans.some(l => l.id === DEL_ID), '借款移出正式區');
  assert.equal(next.payments.filter(p => p.loanId === DEL_ID).length, 0, '收款移出正式區');
  assert.equal(next.payments.length, base.payments.length - 39, '其他收款不動');
  const rec = next.deletedRecords.find(r => r.loan.id === DEL_ID);
  assert.deepEqual(rec.loan, base.loans.find(l => l.id === DEL_ID), '借款所有欄位原樣保留');
  assert.equal(rec.payments.length, 39, '39 筆收款完整封存');
  assert.ok(rec.payments.every(p => p.dueDate && p.loanId === DEL_ID), '收款含 dueDate');
  assert.equal(rec.deletedAt, t0); assert.equal(rec.reason, 'closed');
  assert.deepEqual(next.tombstones.find(t => t.id === DEL_ID), { id: DEL_ID, name: DEL_NAME, dueDay: 10, startDate: due(-40, 10) }, '墓碑更新');
  // 9：再執行一次 → null（不重複封存）
  assert.equal(archiveAndDeleteLoan(next, DEL_ID, 'closed', t0 + 1), null, '借款已不存在回傳 null');
  assert.equal(next.deletedRecords.filter(r => r.loan.id === DEL_ID).length, 1, '封存只一份');
  // 7：隔離 —— 名單／首頁待辦／月報／總覽／本金／利息／介紹費／沖銷／提醒／行事曆／一般 Excel
  const st0 = stats(base, now), st1 = stats(next, now);
  assert.equal(st1.principalOut, st0.principalOut - 650000, '本金統計排除');
  assert.equal(st1.received, st0.received - 39 * 13000, '利息收入排除');
  assert.equal(st1.referralTotal, st0.referralTotal - 6500, '介紹費排除');
  assert.equal(st1.writeoffTotal, 0, '封存的壞帳沖銷不再顯示於總覽');
  const d = dueDateFor(Y, M - 1, 10);
  const rp = monthReport(next, d.getFullYear(), d.getMonth(), now);
  assert.ok(!rp.payList.some(p => p.loanId === DEL_ID) && ![...rp.unpaidRows, ...rp.notYetRows].some(r => r.loan.id === DEL_ID), '月報排除');
  assert.ok(!upcomingDues(next, now, 50).some(x => x.loan.id === DEL_ID) && !missedDues(next, now).some(x => x.loan.id === DEL_ID), '首頁待辦排除');
  assert.equal(monthlySeries(next.payments, now, 7).reduce((s, x) => s + x.total, 0),
    monthlySeries(base.payments, now, 7).reduce((s, x) => s + x.total, 0) - monthlySeries(base.payments.filter(p => p.loanId === DEL_ID), now, 7).reduce((s, x) => s + x.total, 0), '近 7 月排除');
  assert.ok(!buildICS(next.loans.filter(l => l.status === 'normal')).includes(`UID:loan-${DEL_ID}@`), '行事曆下載排除');
  // 8：停止行事曆提醒仍涵蓋已封存帳（墓碑）
  assert.ok(buildStopAllICS([...next.loans, ...(next.tombstones || [])]).includes(`UID:loan-${DEL_ID}@`), '停止檔仍含已結案的帳');
  // 18：Worker 提醒 —— 明天到期的封存帳不發提醒
  const tmr = new Date(Y, M, now.getDate() + 1);
  const L = mkLoan({ id: 'r1', name: '明天到期', principal: 100000, startDate: fmtDate(new Date(Y, M - 3, tmr.getDate())), dueDay: tmr.getDate(), status: 'normal' });
  const sA = { loans: [L], payments: [] };
  const sB = archiveAndDeleteLoan(sA, 'r1', 'closed', t0);
  const tp = { y: Y, m: M, d: now.getDate() };
  assert.equal(buildReminders(sA, tp).length, 1, '對照：未封存會發提醒');
  assert.equal(buildReminders(sB, tp).length, 0, 'Worker 不替封存借款發提醒');
  assert.equal(workerValidate(structuredClone(next)), null, '封存後資料通過 Worker 驗證');
}
{
  // 13：舊 closed 自動遷移
  const m = migrateLegacyClosed(structuredClone(fx), 1789142400000);
  assert.ok(m.changed, '有東西要搬');
  assert.equal(m.state.loans.filter(l => l.status === 'closed').length, 0, '正式區不再有 closed');
  assert.equal(m.state.loans.length, fx.loans.length - 2);
  const r1 = m.state.deletedRecords.find(r => r.loan.id === 'cls1');
  assert.equal(r1.reason, 'legacy-closed'); assert.equal(r1.deletedAt, 1789142400000);
  assert.equal(r1.loan.closedDate, due(-1, 10)); assert.equal(r1.loan.finalReceived, 190000); assert.equal(r1.loan.writeoff, 22000);
  assert.equal(r1.loan.overdueSince, due(-5, 10), '停繳日保留');
  assert.deepEqual(r1.payments.map(p => p.id), ['cp1'], '收款跟著搬');
  const r0 = m.state.deletedRecords.find(r => r.loan.id === 'cls0');
  assert.equal(r0.loan.closedDate, undefined, '舊版無結清日原樣保留');
  assert.ok(!m.state.payments.some(p => p.loanId === 'cls0' || p.loanId === 'cls1'), '正式區收款移除');
  assert.ok(m.state.tombstones.some(t => t.id === 'cls1') && m.state.tombstones.some(t => t.id === 'cls0'), '遷移同時補墓碑');
  const m2 = migrateLegacyClosed(m.state);
  assert.equal(m2.changed, false, '冪等：第二次不動');
  assert.equal(m2.state, m.state, '冪等：回傳原物件');
  // 8：正式區與封存區同 ID → 封存為準，正式區移出（舊裝置復活防線）
  const revived = { ...m.state, loans: [...m.state.loans, { ...r1.loan, status: 'normal', closedDate: null }], payments: [...m.state.payments, { id: 'zz', loanId: 'cls1', date: due(0, 10), amount: 1 }] };
  const m3 = migrateLegacyClosed(revived);
  assert.ok(m3.changed && !m3.state.loans.some(l => l.id === 'cls1') && !m3.state.payments.some(p => p.loanId === 'cls1'), '復活的正式借款被移出');
  assert.deepEqual(m3.state.deletedRecords.find(r => r.loan.id === 'cls1'), r1, '封存原樣保留');
  // 9：救援合併
  const A = [{ deletedAt: 10, reason: 'closed', loan: { id: 'a', name: 'A' }, payments: [] }, { deletedAt: 5, reason: 'closed', loan: { id: 'b', name: 'B' }, payments: [] }];
  const B = [{ deletedAt: 20, reason: 'closed', loan: { id: 'a', name: 'A2' }, payments: [{ id: 'p' }] }, { deletedAt: 1, reason: 'closed', loan: { id: 'b', name: 'B-old' }, payments: [] }, { deletedAt: 7, reason: 'legal-settled', loan: { id: 'c', name: 'C' }, payments: [] }];
  const mg = mergeDeletedRecords(A, B);
  assert.deepEqual(mg.map(r => r.loan.id + ':' + r.loan.name), ['b:B', 'c:C', 'a:A2'], '聯集、較新 deletedAt 為準、依時間排序');
  assert.deepEqual(mergeDeletedRecords(A, undefined), [...A].sort((x, y) => x.deletedAt - y.deletedAt), '舊資料沒有救援表 → 保留既有');
}

// ───────────────── 三、三層驗證：本機 store.js / Worker / Excel ─────────────────
const mem = new Map();
let setCalls = 0;
globalThis.localStorage = {
  getItem: k => mem.has(k) ? mem.get(k) : null,
  setItem: (k, v) => { if (k === 'loanapp.v1') setCalls++; mem.set(k, String(v)); },
  removeItem: k => mem.delete(k),
};
const { load, validateState: localValidate } = await import('../docs/js/store.js');
const require = createRequire(import.meta.url);
globalThis.XLSX = require('../docs/vendor/xlsx.full.min.js');
const { exportXlsx, parseXlsx } = await import('../docs/js/xlsx-io.js');
const xdir = mkdtempSync(join(tmpdir(), 'v49-xlsx-'));
let lastFile = null;
XLSX.writeFile = (wb, name) => { lastFile = join(xdir, name); writeFileSync(lastFile, Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))); };
const toXlsx = (state, name) => { exportXlsx(structuredClone(state)); const f = join(xdir, name); writeFileSync(f, readFileSync(lastFile)); return f; };
{
  // 13：舊 closed 本機載入 → 不判損壞、自動遷移、只存一次
  mem.set('loanapp.v1', JSON.stringify(fx)); setCalls = 0;
  const s = load();
  assert.ok(!mem.has('loanapp.v1.corrupt'), '舊 closed 不被判損壞');
  assert.equal(s.loans.filter(l => l.status === 'closed').length, 0, '載入即遷移');
  assert.equal(s.deletedRecords.length, 2);
  assert.equal(setCalls, 1, '遷移完成只儲存一次');
  assert.equal(s.updatedAt, fx.updatedAt, '遷移不動 updatedAt');
  setCalls = 0; load();
  assert.equal(setCalls, 0, '已遷移的資料再載入不再寫入');
  // 驗證規則（本機與 Worker 對齊）
  const good = migrateLegacyClosed(structuredClone(fx), 1789142400000).state;
  assert.doesNotThrow(() => localValidate(structuredClone(good)));
  assert.equal(workerValidate(structuredClone(good)), null);
  const bad = (mut, label) => {
    const s2 = structuredClone(good); mut(s2);
    assert.throws(() => localValidate(s2), `本機拒絕：${label}`);
    assert.notEqual(workerValidate(s2), null, `Worker 拒絕：${label}`);
  };
  bad(s2 => { s2.deletedRecords = {}; }, 'deletedRecords 不是陣列');
  bad(s2 => { s2.deletedRecords.push(structuredClone(s2.deletedRecords[0])); }, '封存借款 ID 重複');
  bad(s2 => { s2.loans.push({ ...s2.deletedRecords[0].loan, status: 'normal', closedDate: null }); }, '正式與封存同 ID');
  bad(s2 => { s2.deletedRecords[0].loan.principal = -1; }, '封存借款欄位驗證');
  bad(s2 => { s2.deletedRecords[0].payments[0].id = s2.payments[0].id; }, '收款 ID 跨區重複');
  bad(s2 => { s2.deletedRecords[0].payments[0].loanId = 'someone-else'; }, '救援收款對不上封存借款');
  bad(s2 => { s2.deletedRecords[0].deletedAt = 0; }, 'deletedAt 非正整數');
  bad(s2 => { s2.deletedRecords[0].deletedAt = 1.5; }, 'deletedAt 非整數');
  bad(s2 => { s2.deletedRecords[0].reason = 'oops'; }, 'reason 不在枚舉');
  bad(s2 => { s2.deletedRecords[0].payments = null; }, '救援收款不是陣列');
  // 壞封存本機視為損壞（留副本），不會靜默丟掉
  mem.set('loanapp.v1', JSON.stringify({ ...good, deletedRecords: [{ deletedAt: 1, reason: 'closed', loan: null, payments: [] }] }));
  assert.equal(load().loans.length, 0, '壞封存整份視為損壞');
  assert.ok(mem.has('loanapp.v1.corrupt'), '留副本');
  mem.delete('loanapp.v1.corrupt');

  // 16：Excel 救援資料完整往返；一般表不含已刪資料
  const s0 = archiveAndDeleteLoan(good, DEL_ID, 'closed', 1789142400001);
  const f = toXlsx(s0, 'full.xlsx');
  const wb = XLSX.read(readFileSync(f), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['借款主表', '問題帳目', '收款記錄', '系統資料', '系統救援_借款', '系統救援_收款'], '工作表組成');
  for (const sh of ['借款主表', '問題帳目', '收款記錄']) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sh]);
    assert.ok(!csv.includes(DEL_NAME) && !csv.includes('結案丁') && !csv.includes('舊結清戊'), `一般表「${sh}」不含已刪資料`);
  }
  const rl = XLSX.utils.sheet_to_json(wb.Sheets['系統救援_借款']);
  assert.equal(rl.length, 3, '救援借款 3 筆');
  const rowDel = rl.find(r => r['編號'] === DEL_ID);
  assert.equal(rowDel['刪除時間'], 1789142400001); assert.equal(rowDel['封存原因'], 'closed'); assert.equal(rowDel['備註'], '大戶');
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['系統救援_收款']).filter(r => r['借款編號'] === DEL_ID).length, 39, '救援收款 39 筆');
  const back = parseXlsx(readFileSync(f));
  assert.ok(back.ok, '救援表匯入驗證通過：' + back.errors.join('；'));
  assert.equal(back.state.loans.length, s0.loans.length, '一般借款不含救援資料');
  const rb = back.state.deletedRecords.find(r => r.loan.id === DEL_ID);
  const norm = l => JSON.parse(JSON.stringify({ ...l, closedDate: l.closedDate ?? null }));
  assert.deepEqual(norm(rb.loan), norm(s0.deletedRecords.find(r => r.loan.id === DEL_ID).loan), '封存借款欄位往返一致');
  assert.deepEqual(rb.payments, s0.deletedRecords.find(r => r.loan.id === DEL_ID).payments, '封存收款往返一致（含 dueDate）');
  assert.equal(rb.deletedAt, 1789142400001); assert.equal(rb.reason, 'closed');
  assert.equal(back.state.deletedRecords.find(r => r.loan.id === 'cls1').loan.writeoff, 22000, '法院沖銷往返');
  assert.equal(back.state.deletedRecords.find(r => r.loan.id === 'cls1').reason, 'legacy-closed');
  // 空救援表也保留表頭 → 匯入得到 deletedRecords: []
  const fEmpty = toXlsx({ version: 1, loans: good.loans.slice(0, 2), payments: [], lastExport: null }, 'empty.xlsx');
  const be = parseXlsx(readFileSync(fEmpty));
  assert.ok(be.ok && Array.isArray(be.state.deletedRecords) && be.state.deletedRecords.length === 0, '空救援表 → 空陣列');
  // 15：舊 Excel（無救援表）→ 不帶 deletedRecords（呼叫端保留既有）
  const wbOld = XLSX.read(readFileSync(f), { type: 'buffer' });
  delete wbOld.Sheets['系統救援_借款']; delete wbOld.Sheets['系統救援_收款'];
  wbOld.SheetNames = wbOld.SheetNames.filter(n => !n.startsWith('系統救援'));
  const fOld = join(xdir, 'old.xlsx');
  writeFileSync(fOld, Buffer.from(XLSX.write(wbOld, { type: 'array', bookType: 'xlsx' })));
  const bo = parseXlsx(readFileSync(fOld));
  assert.ok(bo.ok && !('deletedRecords' in bo.state), '舊 Excel 沒有救援表 → 不覆蓋');
  // 17：救援表 ID 出現在借款主表 → 阻擋
  const wbRev = XLSX.read(readFileSync(f), { type: 'buffer' });
  const revRow = { ...loanRowOf(s0.deletedRecords.find(r => r.loan.id === DEL_ID).loan), '狀態': '正常', '結清日': '' };
  XLSX.utils.sheet_add_json(wbRev.Sheets['借款主表'], [revRow], { skipHeader: true, origin: -1 });
  const fRev = join(xdir, 'rev.xlsx');
  writeFileSync(fRev, Buffer.from(XLSX.write(wbRev, { type: 'array', bookType: 'xlsx' })));
  const br = parseXlsx(readFileSync(fRev));
  assert.ok(!br.ok && br.errors.some(e => e === `「${DEL_NAME}」已結案刪除，不能透過一般匯入復活。`), '主表含封存 ID 被擋：' + br.errors.join('；'));
  // 救援收款對不上救援借款、封存原因看不懂 → 擋
  const wbBad = XLSX.read(readFileSync(f), { type: 'buffer' });
  XLSX.utils.sheet_add_json(wbBad.Sheets['系統救援_收款'], [{ '編號': 'zz1', '借款編號': 'nobody', '姓名': '', '日期': due(-1, 1), '歸屬期': '', '金額': 100, '刪除時間': 1, '封存原因': 'closed' }], { skipHeader: true, origin: -1 });
  const fBad = join(xdir, 'bad.xlsx');
  writeFileSync(fBad, Buffer.from(XLSX.write(wbBad, { type: 'array', bookType: 'xlsx' })));
  const bb = parseXlsx(readFileSync(fBad));
  assert.ok(!bb.ok && bb.errors.some(e => e.includes('對不上系統救援_借款')), '救援收款必須對應救援借款');
}
function loanRowOf(l) {
  return { '編號': l.id, '姓名': l.name, '本金': l.principal, '月利率%': l.rate, '借款日期': l.startDate, '收息日': l.dueDay,
    '預收月數': l.prepaidMonths || 0, '每月利息': monthlyInterest(l), '狀態': '正常', '停繳日': '', '結清日': '', '介紹費': l.referralFee || 0,
    '結案實收': '', '壞帳沖銷': '', '備註': l.note || '' };
}

// ───────────────── 四、真實瀏覽器 ─────────────────
const srv = await serveStatic(fileURLToPath(new URL('../docs/', import.meta.url)));
const browser = await launch({ width: 375, height: 667 });
const page = browser.page;
// 雲端攔截：預設雲端沒資料；PUT 全收下並記錄
let cloudState = null;
await page.mockCloud(e => {
  if (e.method === 'GET') return { status: 200, body: cloudState ? { state: cloudState, updatedAt: cloudState.updatedAt } : { state: null } };
  if (e.method === 'PUT') { cloudState = e.body.state; return { status: 200, body: { ok: true, savedAt: Date.now() } }; }
});
const getState = () => page.eval(`JSON.parse(localStorage.getItem('loanapp.v1'))`);
const viewText = () => page.eval(`document.getElementById('view').innerText`);
const wait = ms => new Promise(r => setTimeout(r, ms));
let stateAfter;
try {
  await page.goto(srv.url);
  await page.eval(`localStorage.setItem('loanapp.v1', ${JSON.stringify(JSON.stringify(fx))})`);
  await page.reload();
  // 2、13：舊 closed 載入即遷移，不白屏、不跳提示
  assert.equal(page.dialogs.length, 0, '開機沒有舊結清提示');
  assert.ok(await page.eval(`!!document.querySelector('.cal')`), '首頁正常畫出（不白屏）');
  let s = await getState();
  assert.equal(s.loans.filter(l => l.status === 'closed').length, 0, '正式區無 closed');
  assert.equal(s.deletedRecords.length, 2, '兩筆舊結清進封存');
  assert.ok(s.deletedRecords.every(r => r.reason === 'legacy-closed'));
  // 1、19：借款頁沒有分頁、三種寬度都只有單一名單
  for (const width of [320, 375, 430]) {
    await page.mobile(width, 667);
    await page.click('.tab[data-view="people"]');
    await page.waitFor('.plist');
    const r = await page.eval(`({ seg: document.querySelectorAll('#view .seg').length, lists: document.querySelectorAll('.plist').length, rows: document.querySelectorAll('.prow').length, text: document.getElementById('view').innerText })`);
    assert.equal(r.seg, 0, `${width}px 無分頁`);
    assert.equal(r.lists, 1, `${width}px 單一名單`);
    assert.equal(r.rows, 24, `${width}px 只列進行中 24 筆`);
    assert.ok(!r.text.includes('結案紀錄') && !r.text.includes('已結清') && !r.text.includes('結案丁') && !r.text.includes('舊結清戊'), `${width}px 結案資料不出現`);
  }
  await page.mobile(375, 667);
  // 3：四種進行中狀態都有「結案刪除借款」
  const openDetail = async id => {
    await page.click('.tab[data-view="people"]');
    await page.click(`.prow[data-id="${id}"]`);
    await page.waitFor('.backrow');
  };
  for (const id of [DEL_ID, 'miss1', 'ovd1', 'leg1']) {
    await openDetail(id);
    const r = await page.eval(`(() => {
      const acc = [...document.querySelectorAll('details.acc')].find(d => d.querySelector('summary').textContent.includes('更多操作'));
      const b = [...acc.querySelectorAll('[data-action="delete-loan"]')];
      return { txt: b.map(x => x.textContent.trim()), red: b.every(x => x.classList.contains('outline-red')), all: document.querySelectorAll('[data-action="delete-loan"]').length };
    })()`);
    assert.deepEqual(r.txt, ['結案刪除借款'], `${id}：結案刪除借款`);
    assert.ok(r.red && r.all === 1, `${id}：紅色且只有一顆`);
  }
  // 4：取消後任何資料不變
  await openDetail(DEL_ID);
  const before = await page.eval(`localStorage.getItem('loanapp.v1')`);
  await page.click('[data-action="delete-loan"]');
  await page.waitFor('.ov .panel');
  const panel = await page.eval(`(() => { const p = document.querySelector('.ov .panel'); return {
    title: p.querySelector('.p-title').textContent, lines: [...p.querySelectorAll('.p-line')].map(x => x.textContent),
    ok: p.querySelector('[data-p="ok"]').textContent, danger: p.querySelector('[data-p="ok"]').classList.contains('pdanger'), no: p.querySelector('[data-p="no"]').textContent }; })()`);
  assert.equal(panel.title, '結案並刪除這筆借款？');
  assert.deepEqual(panel.lines, [DEL_NAME, '將移除 39 筆收款，共 $507,000', 'App、月報、總覽及一般 Excel 將不再顯示', '完整資料會保留供救援']);
  assert.equal(panel.ok, '結案刪除借款'); assert.ok(panel.danger); assert.equal(panel.no, '取消');
  await page.click('.ov [data-p="no"]');
  await page.waitGone('.ov');
  assert.equal(await page.eval(`localStorage.getItem('loanapp.v1')`), before, '取消後資料不變');
  assert.ok(await page.eval(`!!document.querySelector('.backrow')`), '取消後仍在詳情');
  // 10：儲存失敗 → 原借款與收款仍在、有明確訊息
  await wait(900);
  await page.eval(`window.__origSet = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'loanapp.v1') throw new Error('QuotaExceeded'); return window.__origSet.call(this, k, v); };`);
  await page.click('[data-action="delete-loan"]');
  await page.waitFor('.ov .panel');
  await page.click('.ov [data-p="ok"]');
  await page.waitGone('.ov');
  await wait(200);
  assert.ok(page.dialogs.some(d => d.message === '結案失敗，原本資料沒有變動。'), '儲存失敗提示');
  await page.eval(`Storage.prototype.setItem = window.__origSet`);
  assert.equal(await page.eval(`localStorage.getItem('loanapp.v1')`), before, '儲存失敗：本機資料不變');
  assert.ok(await page.eval(`!!document.querySelector('.backrow')`), '儲存失敗：仍在詳情、借款沒消失');
  await page.click('.tab[data-view="people"]');
  assert.ok(await page.eval(`!!document.querySelector('.prow[data-id="${DEL_ID}"]')`), '儲存失敗：名單仍有該借款');
  s = await getState();
  assert.equal(s.payments.filter(p => p.loanId === DEL_ID).length, 39, '儲存失敗：收款仍在');
  page.dialogs.length = 0;
  // 5、6、9：結案 39 筆收款的借款；快速點兩次只產生一份封存
  await openDetail(DEL_ID);
  await wait(900);
  await page.click('[data-action="delete-loan"]');
  await page.waitFor('.ov .panel');
  await page.eval(`(() => { const b = document.querySelector('.ov [data-p="ok"]'); b.click(); b.click(); })()`);
  await page.waitGone('.ov');
  await page.waitFor('.toast');
  assert.equal(await page.eval(`document.querySelector('.toast').textContent`), `「${DEL_NAME}」已結案刪除`, '成功訊息');
  assert.ok(await page.eval(`!!document.querySelector('.plist') && !document.querySelector('.prow[data-id="${DEL_ID}"]')`), 'App 立即消失');
  stateAfter = await getState();
  assert.ok(!stateAfter.loans.some(l => l.id === DEL_ID) && !stateAfter.payments.some(p => p.loanId === DEL_ID), '正式區移除');
  const recs = stateAfter.deletedRecords.filter(r => r.loan.id === DEL_ID);
  assert.equal(recs.length, 1, '只產生一份封存');
  assert.equal(recs[0].payments.length, 39, '39 筆收款完整存在 deletedRecords');
  assert.equal(recs[0].reason, 'closed'); assert.ok(Number.isInteger(recs[0].deletedAt) && recs[0].deletedAt > 0);
  assert.deepEqual(recs[0].loan, fx.loans.find(l => l.id === DEL_ID), '借款完整欄位');
  assert.ok(stateAfter.tombstones.some(t => t.id === DEL_ID), '墓碑仍存在');
  assert.equal(stateAfter.deletedRecords.length, 3, '封存＝2 舊結清＋1');
  assert.equal(page.dialogs.length, 0, '結案不跳 alert');
  // 7：首頁、月報、總覽、欠繳都不再計入
  for (const v of ['home', 'problems', 'stats']) {
    await page.click(`.tab[data-view="${v}"]`);
    assert.ok(!(await viewText()).includes(DEL_NAME), `${v} 不含該帳`);
  }
  await page.click('[data-action="stats-prev"]');
  assert.ok(!(await viewText()).includes(DEL_NAME), '上月月報不含該帳');
  await page.click('[data-action="stats-tab"][data-tab="overview"]');
  const ov = await viewText();
  assert.ok(!ov.includes(DEL_NAME) && !ov.includes('壞帳沖銷'), '總覽不含該帳、封存的沖銷不顯示');
  // 雲端同步帶著封存上傳（等去抖動 2 秒）
  await wait(2600);
  const put = page.cloudLog.filter(e => e.method === 'PUT').at(-1);
  assert.ok(put && put.body.state.deletedRecords.length === 3, '同步上傳含完整封存');
  // 11：重開 App 後仍不顯示、封存仍在
  await page.reload();
  await page.click('.tab[data-view="people"]');
  await page.waitFor('.plist');
  assert.ok(!(await viewText()).includes(DEL_NAME), '重開後仍不顯示');
  assert.equal((await getState()).deletedRecords.filter(r => r.loan.id === DEL_ID).length, 1, '重開後封存仍在');
  // 14：法院結案 → 完整封存並從 App 消失（prompt 預設值＝應收全額）
  await openDetail('leg1');
  const owed = 500000 + overdueInterest(fx.loans.find(l => l.id === 'leg1'), now, fx.payments);
  await page.click('[data-action="settle-legal"]');
  await page.waitFor('.ov .panel');
  await page.click('.ov [data-p="ok"]');
  await page.waitGone('.ov');
  await page.waitFor('.toast');
  assert.ok((await page.eval(`document.querySelector('.toast').textContent`)).includes('法院已結案'), '法院結案訊息');
  assert.ok(!(await viewText()).includes('法院丙'), '法院案件從 App 消失');
  s = await getState();
  const lr = s.deletedRecords.find(r => r.loan.id === 'leg1');
  assert.ok(lr && lr.reason === 'legal-settled', '封存原因 legal-settled');
  assert.equal(lr.loan.finalReceived, owed); assert.equal(lr.loan.writeoff, 0); assert.equal(lr.loan.closedDate, fmtDate(now));
  assert.equal(lr.loan.status, 'closed'); assert.equal(lr.loan.overdueSince, due(-3, 10), '法院應收／停繳日保留');
  assert.ok(!s.loans.some(l => l.id === 'leg1'), '正式區移除');
  await page.click('.tab[data-view="problems"]');
  assert.ok(!(await viewText()).includes('法院丙'), '欠繳頁不含已結案');
  // 15、16、17：Excel 匯入（真正走 input change → doImport）
  const doImport = async (file, expectPanel = true) => {
    await wait(900);   // 前一個寫入動作的 800ms 鎖：鎖住期間選檔會被忽略（防連點設計）
    await page.click('.tab[data-view="home"]');
    await page.click('[data-view="settings"]');
    await page.setFile('#import-file', file);
    if (expectPanel) {
      try { await page.waitFor('.ov .panel'); }
      catch (e) { throw new Error(e.message + ' | dialogs: ' + JSON.stringify(page.dialogs.slice(-2))); }
      await page.click('.ov [data-p="ok"]'); await page.waitGone('.ov');
    }
    await wait(300);
  };
  // 15：舊 Excel（無救援表）→ 現有救援資料不清空
  const curr = await getState();
  const fOld = toXlsx({ version: 1, loans: curr.loans, payments: curr.payments, lastExport: null }, 'b-old.xlsx');
  const wbOld = XLSX.read(readFileSync(fOld), { type: 'buffer' });
  delete wbOld.Sheets['系統救援_借款']; delete wbOld.Sheets['系統救援_收款'];
  wbOld.SheetNames = wbOld.SheetNames.filter(n => !n.startsWith('系統救援'));
  writeFileSync(fOld, Buffer.from(XLSX.write(wbOld, { type: 'array', bookType: 'xlsx' })));
  await doImport(fOld);
  s = await getState();
  assert.equal(s.deletedRecords.length, 4, '匯入舊 Excel 不清空救援資料（2 舊結清＋結案＋法院）');
  assert.equal(s.loans.length, curr.loans.length);
  // 16：救援表往返 —— 檔內有較新的同 ID 封存（改了備註）→ 以較新為準；另含一筆新封存 → 併入
  const newer = structuredClone(s.deletedRecords.find(r => r.loan.id === DEL_ID));
  newer.deletedAt += 1000; newer.loan.note = '救援表較新';
  const extra = { deletedAt: 1789142400000, reason: 'closed', loan: mkLoan({ id: 'ext1', name: '外來封存', principal: 10000, startDate: '2025-01-05', dueDay: 5, status: 'normal' }), payments: [{ id: 'extp1', loanId: 'ext1', date: '2025-02-05', dueDate: '2025-02-05', amount: 200 }] };
  const fRt = toXlsx({ version: 1, loans: s.loans, payments: s.payments, lastExport: null, deletedRecords: [newer, extra] }, 'b-rt.xlsx');
  await doImport(fRt);
  s = await getState();
  assert.equal(s.deletedRecords.length, 5, '合併後 5 筆（既有 4＋外來 1）');
  assert.equal(s.deletedRecords.find(r => r.loan.id === DEL_ID).loan.note, '救援表較新', '相同 ID 以較新 deletedAt 為準');
  assert.equal(s.deletedRecords.find(r => r.loan.id === 'ext1').payments.length, 1, '外來封存含收款');
  assert.ok(!s.loans.some(l => l.id === 'ext1' || l.id === DEL_ID), '救援資料沒進一般借款');
  // 17：匯入相同封存 ID（主表復活）→ 阻擋、資料不變
  const beforeRev = await page.eval(`localStorage.getItem('loanapp.v1')`);
  const fRev = toXlsx({ version: 1, loans: [...s.loans, { ...fx.loans.find(l => l.id === DEL_ID) }], payments: s.payments, lastExport: null }, 'b-rev.xlsx');
  const wbRev = XLSX.read(readFileSync(fRev), { type: 'buffer' });
  delete wbRev.Sheets['系統救援_借款']; delete wbRev.Sheets['系統救援_收款'];
  wbRev.SheetNames = wbRev.SheetNames.filter(n => !n.startsWith('系統救援'));
  writeFileSync(fRev, Buffer.from(XLSX.write(wbRev, { type: 'array', bookType: 'xlsx' })));
  page.dialogs.length = 0;
  await doImport(fRev, false);
  await wait(500);
  assert.ok(page.dialogs.some(d => d.message.includes(`「${DEL_NAME}」已結案刪除，不能透過一般匯入復活。`)), '復活被擋並提示');
  assert.equal(await page.eval(`localStorage.getItem('loanapp.v1')`), beforeRev, '被擋後資料不變');
  // 12：換裝置同步 —— 新裝置空資料，從雲端拉到這份 → 結果一致；舊裝置上傳的復活資料 → 封存為準
  cloudState = { ...s, updatedAt: Date.now() + 5000 };
  await page.eval(`localStorage.clear()`);
  await page.reload();
  await wait(500);
  await page.click('.tab[data-view="people"]');
  await page.waitFor('.plist');
  let s2 = await getState();
  assert.equal(s2.loans.length, s.loans.length, '新裝置：借款數一致');
  assert.equal(s2.deletedRecords.length, 5, '新裝置：封存一致');
  assert.ok(!(await viewText()).includes(DEL_NAME), '新裝置：不顯示已結案');
  // 舊裝置（無 deletedRecords 欄位）把已結案的帳連同收款一起上傳 → 本機拉取後：借款不復活、封存不遺失
  const oldDevice = { ...s, loans: [...s.loans, fx.loans.find(l => l.id === DEL_ID)], payments: [...s.payments, ...fx.payments.filter(p => p.loanId === DEL_ID)], updatedAt: Date.now() + 9000 };
  delete oldDevice.deletedRecords;
  cloudState = oldDevice;
  await page.reload();
  await wait(500);
  s2 = await getState();
  assert.ok(!s2.loans.some(l => l.id === DEL_ID) && !s2.payments.some(p => p.loanId === DEL_ID), '舊裝置上傳不會把帳復活');
  assert.equal(s2.deletedRecords.length, 5, '封存不因舊裝置上傳而遺失');
  await page.click('.tab[data-view="people"]');
  assert.ok(!(await viewText()).includes(DEL_NAME), '畫面也不出現');
} finally {
  await browser.close();
  await srv.close();
  rmSync(xdir, { recursive: true, force: true });
}

console.log('v49 結案封存＋救援往返全過');
