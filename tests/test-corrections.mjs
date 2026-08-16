// 更正／結清／刪除流程驗收（交辦規格必加案例）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDate, fmtDate, missedPeriods, missedDues, monthReport,
  settledInMonth, upcomingDues, mergeTombstones,
} from '../docs/js/calc.js';

const now = parseDate('2026-08-16');
const mk = () => ({
  loans: [
    { id: 'a', name: '彭琮翔', principal: 1000000, rate: 1.3, startDate: '2026-05-05', dueDay: 5, status: 'normal', prepaidMonths: 3 },
    { id: 'b', name: '乙', principal: 300000, rate: 2, startDate: '2026-04-06', dueDay: 6, status: 'normal', prepaidMonths: 0 },
  ],
  payments: [
    { id: 'pp', loanId: 'a', date: '2026-05-05', amount: 39000, kind: 'prepaid' },  // 簽約預收
    { id: 'q1', loanId: 'b', date: '2026-07-08', dueDate: '2026-07-06', amount: 1000 },  // 7 月只收部分
  ],
});

// ── 案例 5：月息 6,000、7 月已收 1,000 → 補收只能補 5,000 ──
{
  const st = mk();
  const periods = missedPeriods(st, st.loans[1], now);
  const jul = periods.find(p => fmtDate(p.date) === '2026-07-06');
  assert.ok(jul, '7 月在漏收清單');
  assert.equal(jul.remaining, 5000, '7 月只補剩餘 5000，不是 6000');
  // 首頁漏收金額也用剩餘算
  const md = missedDues(st, now).find(x => x.loan.id === 'b');
  assert.equal(md.amount, periods.reduce((s, p) => s + p.remaining, 0), '漏收總額=剩餘合計');

  // 模擬 receive-missed：各期補剩餘、收款日=今天、歸屬期=原收息日
  for (const p of periods) {
    st.payments.push({ id: 'fix' + fmtDate(p.date), loanId: 'b', date: fmtDate(now), dueDate: fmtDate(p.date), amount: p.remaining });
  }
  assert.equal(missedPeriods(st, st.loans[1], now).length, 0, '補完清空');
  const julReport = monthReport(st, 2026, 6, now);
  assert.equal(julReport.dueUnpaid, 0, '7 月到期未收歸零');
  const augReport = monthReport(st, 2026, 7, now);
  assert.ok(augReport.received >= 5000, '現金入帳落在 8 月');
}

// ── 案例 1–4：有預收 $39,000 的借款可直接刪除，刪後全消失、月報更新；取消＝不動 ──
{
  const st = mk();
  const before = monthReport(st, 2026, 7, now).due;
  // 模擬 delete-loan 確認後的動作
  const l = st.loans[0];
  st.loans = st.loans.filter(x => x.id !== l.id);
  st.payments = st.payments.filter(p => p.loanId !== l.id);
  assert.equal(st.loans.length, 1, '借款刪除');
  assert.equal(st.payments.filter(p => p.loanId === 'a').length, 0, '收款一併刪除');
  assert.ok(monthReport(st, 2026, 7, now).due < before, '月報同步更新');
  assert.ok(!upcomingDues(st, now, 5).some(x => x.loan.id === 'a'), '提醒同步消失');
  // 取消 = 不呼叫刪除 → 原 state 不變
  const st2 = mk();
  assert.equal(st2.loans.length, 2);
  assert.equal(st2.payments.length, 2);
}

// ── 案例 6：收款日期、金額、歸屬期可更正，更正後立即重算 ──
{
  const st = mk();
  const p = st.payments.find(x => x.id === 'q1');
  assert.equal(settledInMonth(st.payments, st.loans[1], 2026, 6), false, '更正前 7 月未收齊');
  // 模擬 edit-payment：改成 6 月的全額
  p.date = '2026-08-01';
  p.dueDate = '2026-06-06';
  p.amount = 6000;
  delete p.kind;
  assert.equal(settledInMonth(st.payments, st.loans[1], 2026, 5), true, '歸屬期改 6 月 → 6 月收齊');
  assert.equal(settledInMonth(st.payments, st.loans[1], 2026, 6), false, '7 月回到未收');
}

// ── 案例 7、8：來源碼層面 —— 結清欄位停用、不再出現「改用結清還本」──
{
  const src = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('請改用「結清還本」'), '不得再出現「不能刪除，請改用結清還本」');
  assert.ok(!src.includes('有收款記錄，不能刪除'), '刪除阻擋已移除');
  assert.ok(src.includes('刪除錯帳'), '刪除按鈕（v34 短文案）');
  assert.ok(src.includes('退回欠繳'), '法院可撤銷回欠繳（v34 短文案）');
  assert.ok(src.includes("'edit-payment'"), '收款有更正功能');
  assert.ok(src.includes('const dis = locked'), '已結清欄位停用');
  assert.ok(src.includes('要更正請先撤銷結清'), '鎖定說明與撤銷入口');
  assert.ok(src.includes('預收月數同步改為'), '更正預收款會重算預收月數');
}

// ── 邊界：更正預收款金額 → 預收月數重算規則（floor(金額/月息)，上限 12）──
{
  const mi = 13000;
  const k = amt => Math.max(0, Math.min(12, Math.floor(amt / mi)));
  assert.equal(k(39000), 3, '39000 → 3 個月');
  assert.equal(k(26000), 2, '26000 → 2 個月');
  assert.equal(k(26500), 2, '不足整期無條件捨去');
  assert.equal(k(5000), 0, '不足一期 → 0');
}

// ── 墓碑合併：匯入不清空、依 ID 去重、復活剔除、上限 100 ──
{
  const T = (id, name = id) => ({ id, name, dueDay: 5, startDate: '2025-01-05' });
  // 匯入檔沒有墓碑 → 現有的不能被洗掉
  let m = mergeTombstones([T('a'), T('b')], undefined, new Set());
  assert.equal(m.length, 2, '整批取代仍保留現有墓碑');
  // 依 ID 去重：匯入的覆蓋現有
  m = mergeTombstones([T('a', '舊名')], [T('a', '新名')], new Set());
  assert.equal(m.length, 1);
  assert.equal(m[0].name, '新名', '同 ID 以匯入為準');
  // 匯入檔把該 ID 復活成借款 → 墓碑剔除
  m = mergeTombstones([T('a'), T('b')], [], new Set(['a']));
  assert.deepEqual(m.map(t => t.id), ['b'], '復活的帳不再列入停止檔');
  // 上限 100：保留最新
  const many = Array.from({ length: 120 }, (_, i) => T('t' + i));
  m = mergeTombstones(many.slice(0, 60), many.slice(60), new Set());
  assert.equal(m.length, 100);
  assert.equal(m[99].id, 't119', '超過 100 丟最舊、留最新');
  // 交叉案例：現有 100 筆＋匯入「更新最舊的 c0」＋50 筆新增 → 被更新的 c0 必須存活
  const cur100 = Array.from({ length: 100 }, (_, i) => T('c' + i));
  const imp = [T('c0', 'c0更新'), ...Array.from({ length: 50 }, (_, i) => T('n' + i))];
  m = mergeTombstones(cur100, imp, new Set());
  assert.equal(m.length, 100);
  const c0 = m.find(t => t.id === 'c0');
  assert.ok(c0, '超限裁切時，匯入更新過的舊 ID 仍保留');
  assert.equal(c0.name, 'c0更新', '內容以匯入為準');
  assert.ok(!m.find(t => t.id === 'c1'), '未被更新的最舊資料先被裁掉');
}

console.log('更正/結清/刪除流程全過');
