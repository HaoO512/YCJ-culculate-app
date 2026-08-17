// v43：月報損益（現金收付制）＋代書費退役必驗案例
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDate, monthReport, stats, money } from '../docs/js/calc.js';

const now = parseDate('2026-08-20');

const state = {
  loans: [
    // 8 月簽約：介紹費 6,500 歸 8 月
    { id: 'a', name: '甲', principal: 1000000, rate: 2, startDate: '2026-08-10', dueDay: 10, status: 'normal', prepaidMonths: 0, referralFee: 6500 },
    // 7 月簽約：介紹費只出現在 7 月
    { id: 'b', name: '乙', principal: 500000, rate: 2, startDate: '2026-07-15', dueDay: 15, status: 'normal', prepaidMonths: 0, referralFee: 5000 },
    // 已結清但 8 月簽約：介紹費仍依借款日計入 8 月
    { id: 'c', name: '丙', principal: 200000, rate: 2, startDate: '2026-08-05', dueDay: 5, status: 'closed', closedDate: '2026-08-18', prepaidMonths: 0, referralFee: 2000 },
    // 舊資料帶 appraisalFee：必須完全不影響任何數字
    { id: 'd', name: '丁', principal: 300000, rate: 2, startDate: '2026-06-06', dueDay: 6, status: 'normal', prepaidMonths: 0, referralFee: 3000, appraisalFee: 3000 },
  ],
  payments: [
    // 8 月實收（含補 6 月的：date 在 8 月 → 收入算 8 月）
    { id: 'p1', loanId: 'd', date: '2026-08-20', dueDate: '2026-06-06', amount: 6000 },
    { id: 'p2', loanId: 'b', date: '2026-08-16', dueDate: '2026-08-15', amount: 10000 },
    // 7 月實收
    { id: 'p3', loanId: 'b', date: '2026-07-15', amount: 84000 },
  ],
};

// ── 8 月損益 ──
const aug = monthReport(state, 2026, 7, now);
assert.equal(aug.received, 16000, '8月實收=兩筆 date 在 8 月的收款（含補 6 月的）');
assert.equal(aug.expense, 6500 + 2000, '8月費用=8月簽約的介紹費（含已結清的丙）');
assert.equal(aug.net, 16000 - 8500, '8月淨收入');

// ── 7 月：介紹費只出現在 7 月，不能出現在 8 月 ──
const jul = monthReport(state, 2026, 6, now);
assert.equal(jul.expense, 5000, '乙的介紹費歸 7 月');
assert.equal(jul.received, 84000);
assert.equal(jul.net, 79000);

// ── 沒收款但有介紹費 → 負數 ──
const st2 = {
  loans: [{ id: 'x', name: 'x', principal: 100000, rate: 2, startDate: '2026-08-01', dueDay: 1, status: 'normal', prepaidMonths: 0, referralFee: 1000 }],
  payments: [],
};
const neg = monthReport(st2, 2026, 7, now);
assert.equal(neg.received, 0, '無收款也要有 $0');
assert.equal(neg.net, -1000, '淨收入可為負');
assert.equal(money(neg.net), '-$1,000', '負數顯示 -$');

// ── 預收款：簽約日收取 → 全算簽約月收入 ──
const st3 = {
  loans: [{ id: 'y', name: 'y', principal: 600000, rate: 2, startDate: '2026-08-14', dueDay: 14, status: 'normal', prepaidMonths: 3, referralFee: 6000 }],
  payments: [{ id: 'py', loanId: 'y', date: '2026-08-14', amount: 36000, kind: 'prepaid' }],
};
const pre = monthReport(st3, 2026, 7, now);
assert.equal(pre.received, 36000, '預收全算簽約月');
assert.equal(pre.net, 30000);

// ── 舊 appraisalFee 完全無影響 ──
const withOld = stats(state, now);
const cleanState = JSON.parse(JSON.stringify(state));
delete cleanState.loans[3].appraisalFee;
const withoutOld = stats(cleanState, now);
assert.deepEqual(withOld, withoutOld, '帶舊代書費欄位與不帶完全同結果');
assert.equal(withOld.net, withOld.received - withOld.referralTotal, '總覽淨收入只扣介紹費');

// ── 來源碼：介面與匯出不再有代書費 ──
{
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const xio = readFileSync(new URL('../docs/js/xlsx-io.js', import.meta.url), 'utf8');
  assert.ok(!app.includes('appraisal'), 'app 無代書費程式');
  assert.ok(!app.includes('DEFAULT_APPRAISAL'), '預設常數已刪');
  assert.ok(app.includes('本月損益') && app.includes('以借款日歸月'), '月報含損益公式');
  assert.ok(app.includes('已結清的帳只能改姓名、介紹費、備註'), '鎖定文案更新');
  assert.ok(!xio.includes('代書費'), 'Excel 匯出入無代書費欄');
  assert.ok(xio.includes('系統資料'), '墓碑表維持不變');
}

console.log('v43 損益+代書費退役全過');
