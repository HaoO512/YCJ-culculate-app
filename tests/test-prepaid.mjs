// 預收利息邏輯測試
import assert from 'node:assert/strict';
import {
  parseDate, fmtDate, firstDueAfterStart, prepaidUntil,
  settledInMonth, nextCollectDue, stats,
} from '../docs/js/calc.js';

// 期初先收：8/4 簽約、收息日 4 號、預收 3 個月 → 涵蓋 8/4、9/4、10/4，第一次真收 11/4
const L = {
  id: 'a', name: '王小明', principal: 600000, rate: 2,
  startDate: '2026-08-04', dueDay: 4, status: 'normal',
  prepaidMonths: 3, overdueSince: null, referralFee: 6000, appraisalFee: 3000,
};
assert.equal(fmtDate(firstDueAfterStart(L)), '2026-09-04');
assert.equal(fmtDate(prepaidUntil(L)), '2026-10-04');
assert.equal(fmtDate(nextCollectDue(L, parseDate('2026-08-05'))), '2026-11-04');
assert.equal(fmtDate(nextCollectDue(L, parseDate('2026-12-20'))), '2027-01-04');

// 8、9、10 月視為已處理，11 月開始要收
assert.equal(settledInMonth([], L, 2026, 7), true);   // 8月
assert.equal(settledInMonth([], L, 2026, 9), true);   // 10月
assert.equal(settledInMonth([], L, 2026, 10), false); // 11月

// 不預收 → 照舊
const N = { ...L, prepaidMonths: 0 };
assert.equal(prepaidUntil(N), null);
assert.equal(fmtDate(nextCollectDue(N, parseDate('2026-08-05'))), '2026-09-04');
assert.equal(settledInMonth([], N, 2026, 8), false);

// 月底收息 + 預收 2 個月：8/31 簽（當天就是第 1 期）→ 涵蓋 8/31、9/30 → 真收 10/31
const E = { ...L, startDate: '2026-08-31', dueDay: 'EOM', prepaidMonths: 2 };
assert.equal(fmtDate(firstDueAfterStart(E)), '2026-09-30');
assert.equal(fmtDate(prepaidUntil(E)), '2026-09-30');
assert.equal(fmtDate(nextCollectDue(E, parseDate('2026-09-01'))), '2026-10-31');

// stats：預收涵蓋月不計入本月要收
const st = stats({ loans: [L], payments: [] }, parseDate('2026-09-10'));
assert.equal(st.monthDue, 0);
const st2 = stats({ loans: [L], payments: [] }, parseDate('2026-12-10'));
assert.equal(st2.monthDue, 12000);

console.log('預收邏輯全部通過');
