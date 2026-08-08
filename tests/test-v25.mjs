// v25：跨月漏收/接下來、月報到期語意、結清日保史
import assert from 'node:assert/strict';
import {
  parseDate, fmtDate, monthReport, upcomingDues, missedDues,
} from '../docs/js/calc.js';

const now = parseDate('2026-08-30');

const state = {
  loans: [
    // 9/2 收息：8月底看「接下來」要看得到（跨月）
    { id: 'a', name: '甲', principal: 500000, rate: 2, startDate: '2026-06-02', dueDay: 2, status: 'normal', prepaidMonths: 0 },
    // 收息日 5 號、7 月起沒繳：漏收要跨月持續顯示（7/5、8/5 共 2 期）
    { id: 'b', name: '乙', principal: 300000, rate: 2, startDate: '2026-05-05', dueDay: 5, status: 'normal', prepaidMonths: 0 },
    // 8/10 結清：8 月月報仍要計入，9 月不計
    { id: 'c', name: '丙', principal: 200000, rate: 2, startDate: '2026-01-15', dueDay: 15, status: 'closed', closedDate: '2026-08-10', prepaidMonths: 0 },
  ],
  payments: [
    { id: 'p1', loanId: 'a', date: '2026-08-02', amount: 10000 },  // 甲 8 月已收
    { id: 'p3', loanId: 'a', date: '2026-07-02', amount: 10000 },  // 甲 7 月已收
    { id: 'p2', loanId: 'b', date: '2026-06-05', amount: 6000 },   // 乙 6 月有繳
  ],
};

// 跨月接下來：甲 8 月已收 → 下一筆 9/2；乙漏著（upcoming 只往前找未入帳月 → 7/5? nextCollectDue 從今天起 → 9/5? 乙 8/5 未繳 → nextCollectDue(now)=9/5，但 8 月未入帳...）
const up = upcomingDues(state, now, 3);
assert.equal(fmtDate(up[0].date), '2026-09-02', '甲跨月 9/2 出現在接下來');

// 跨月漏收：乙 7/5、8/5 兩期未記
const miss = missedDues(state, now);
assert.equal(miss.length, 1);
assert.equal(miss[0].loan.name, '乙');
assert.equal(miss[0].count, 2, '乙漏 2 期');
assert.equal(fmtDate(miss[0].first), '2026-07-05');
assert.equal(miss[0].amount, 12000);

// 8 月月報：丙 8/15 到期 > 結清日 8/10 → 不計；甲乙計入
const aug = monthReport(state, 2026, 7, now);
assert.equal(aug.due, 10000 + 6000, '8月到期');
assert.equal(aug.received, 10000, '8月入帳');
assert.equal(aug.dueUnpaid, 6000, '到期未收=乙');

// 7 月月報：丙 7/15 <= 結清日 → 仍計入（歷史不被改寫）
const jul = monthReport(state, 2026, 6, now);
assert.equal(jul.due, 10000 + 6000 + 4000, '7月到期含已結清的丙');

// 到期 vs 未到期：8/30 看 8 月，全部到期；看 9 月（未來月），全部未到期
const sep = monthReport(state, 2026, 8, now);
assert.equal(sep.dueUnpaid, 0, '9月都還沒到期');
assert.equal(sep.notYet, sep.due, '9月全在尚未到期');

console.log('v25 跨月/保史邏輯全過');
