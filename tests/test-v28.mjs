// v28：補繳歸屬期語意、本機完整驗證
import assert from 'node:assert/strict';
import { parseDate, settledInMonth, monthReport, monthPaidAmount } from '../docs/js/calc.js';

// ── 歸屬期：8/9 收到補 6 月的錢 → 6 月算收清、現金記在 8 月 ──
const L = { id: 'x', name: '乙', principal: 300000, rate: 2, startDate: '2026-05-05', dueDay: 5, status: 'normal', prepaidMonths: 0 };
const st = {
  loans: [L],
  payments: [{ id: 'p', loanId: 'x', date: '2026-08-09', dueDate: '2026-06-05', amount: 6000 }],
};
const now = parseDate('2026-08-09');

assert.equal(settledInMonth(st.payments, L, 2026, 5), true, '6月靠歸屬期收清');
assert.equal(settledInMonth(st.payments, L, 2026, 7), false, '8月沒被這筆誤標');
assert.equal(monthPaidAmount(st.payments, 'x', 2026, 5), 6000, '歸屬 6 月');
assert.equal(monthPaidAmount(st.payments, 'x', 2026, 7), 0, '不歸屬 8 月');

const jun = monthReport(st, 2026, 5, now);
assert.equal(jun.dueUnpaid, 0, '6月到期未收=0（已補）');
assert.equal(jun.received, 0, '6月入帳=0（現金是 8 月進的）');

const aug = monthReport(st, 2026, 7, now);
assert.equal(aug.received, 6000, '8月入帳=6000（真收款日）');
assert.equal(aug.dueUnpaid, 6000, '8月自己那期還沒收');

// ── 本機驗證：與雲端同套規則 ──
const storage = new Map();
globalThis.localStorage = {
  getItem: k => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
};
const { load } = await import('../docs/js/store.js');

const base = {
  version: 1,
  loans: [{ id: 'a', name: '甲', principal: 100000, rate: 2, startDate: '2026-01-05', dueDay: 5, status: 'normal', prepaidMonths: 0 }],
  payments: [],
};
const tryLoad = (mutate, label) => {
  const bad = JSON.parse(JSON.stringify(base));
  mutate(bad);
  storage.set('loanapp.v1', JSON.stringify(bad));
  const s = load();
  assert.equal(s.loans.length, 0, label + ' 應被判定損壞');
};
tryLoad(b => { b.loans[0].prepaidMonths = 99; }, '預收99');
tryLoad(b => { b.loans[0].referralFee = -1; }, '介紹費-1');
tryLoad(b => { b.loans[0].finalReceived = -5; }, '結案實收-5');
tryLoad(b => { b.loans[0].status = 'overdue'; b.loans[0].overdueSince = '2025-12-01'; }, '停繳日早於借款日');
tryLoad(b => { b.payments.push({ id: 'p', loanId: 'a', date: '2026-02-05', dueDate: '2026-99-99', amount: 100 }); }, '歸屬期假日期');

// 好資料要能過
storage.set('loanapp.v1', JSON.stringify(base));
assert.equal(load().loans.length, 1, '正常資料不誤殺');

console.log('v28 歸屬期+本機驗證全過');
