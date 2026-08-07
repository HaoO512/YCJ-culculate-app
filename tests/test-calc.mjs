// calc.js 純函數測試
import assert from 'node:assert/strict';
import {
  parseDate, fmtDate, monthlyInterest, defaultReferral,
  dueDateFor, nextDue, overduePeriods, overdueInterest,
  paidInMonth, stats, monthlySeries, money,
} from '../docs/js/calc.js';

const L = (over = {}) => ({
  id: 'a', name: '陳大文', principal: 500000, rate: 2,
  startDate: '2025-03-05', dueDay: 5, status: 'normal',
  overdueSince: null, referralFee: 5000, appraisalFee: 3000,
  finalReceived: null, writeoff: null, note: '',
  ...over,
});

// 月息
assert.equal(monthlyInterest(L()), 10000);
assert.equal(monthlyInterest(L({ principal: 300000, rate: 1.8 })), 5400);
assert.equal(defaultReferral(600000, 2), 6000);

// 收息日
assert.equal(fmtDate(dueDateFor(2026, 7, 5)), '2026-08-05');
assert.equal(fmtDate(dueDateFor(2026, 1, 'EOM')), '2026-02-28');   // 平年二月
assert.equal(fmtDate(dueDateFor(2026, 7, 'EOM')), '2026-08-31');

// 下一個收息日（今天 8/4，收息日 5 → 8/5）
assert.equal(fmtDate(nextDue(L(), parseDate('2026-08-04'))), '2026-08-05');
// 今天正好是收息日 → 今天
assert.equal(fmtDate(nextDue(L(), parseDate('2026-08-05'))), '2026-08-05');
// 過了 → 下個月
assert.equal(fmtDate(nextDue(L(), parseDate('2026-08-06'))), '2026-09-05');

// 欠繳期數：5/10 停繳、收息日 10 號 → 5/10, 6/10, 7/10 到 8/4 共 3 期
const bad = L({ status: 'overdue', overdueSince: '2026-05-10', dueDay: 10, principal: 400000, rate: 2 });
assert.equal(overduePeriods(bad, parseDate('2026-08-04')), 3);
assert.equal(overdueInterest(bad, parseDate('2026-08-04')), 24000);
// 8/10 當天 → 第 4 期
assert.equal(overduePeriods(bad, parseDate('2026-08-10')), 4);
// 停繳日在收息日之前（7/12 停、收息日 15）→ 7/15, 8/2 前只有 1 期
const bad2 = L({ status: 'overdue', overdueSince: '2026-07-12', dueDay: 15 });
assert.equal(overduePeriods(bad2, parseDate('2026-08-02')), 1);

// 收款
const pays = [
  { id: 'p1', loanId: 'a', date: '2026-08-01', amount: 10000 },
  { id: 'p2', loanId: 'a', date: '2026-07-05', amount: 10000 },
  { id: 'p3', loanId: 'b', date: '2026-08-02', amount: 5400 },
];
assert.equal(paidInMonth(pays, 'a', 2026, 7), true);   // 8 月
assert.equal(paidInMonth(pays, 'a', 2026, 5), false);  // 6 月

// 統計
const st = stats({
  loans: [
    L(),
    L({ id: 'b', principal: 300000, rate: 1.8, referralFee: 2700 }),
    bad,
    L({ id: 'd', status: 'closed', writeoff: 50000, finalReceived: 380000 }),
  ],
  payments: pays,
}, parseDate('2026-08-04'));
assert.equal(st.principalOut, 500000 + 300000 + 400000);  // closed 不算
assert.equal(st.received, 25400);
assert.equal(st.monthDue, 10000 + 5400);                  // normal 才算
assert.equal(st.monthReceived, 15400);
assert.equal(st.overdueInt, 4000);   // 24000 欠息 - 20000 欠繳期間補繳
assert.equal(st.overdueTotal, 404000);
assert.equal(st.problemCount, 1);
assert.equal(st.writeoffTotal, 50000);
assert.equal(st.referralTotal, 5000 + 2700 + 5000 + 5000);
assert.equal(st.net, 25400 - st.referralTotal - st.appraisalTotal);

// 月序列
const series = monthlySeries(pays, parseDate('2026-08-04'), 3);
assert.equal(series.length, 3);
assert.equal(series[2].total, 15400);  // 8月
assert.equal(series[1].total, 10000);  // 7月
assert.equal(series[0].total, 0);      // 6月

assert.equal(money(1234567), '$1,234,567');

console.log('calc.js 全部通過');
