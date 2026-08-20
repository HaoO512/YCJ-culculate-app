// Worker buildReminders 行為測試（直接呼叫正式函式，注入台北日期）
import assert from 'node:assert/strict';
import { buildReminders } from '../worker/src/index.js';

// 乙：月底收息（dueDay 31）。8/31 那期是 9/2 才收（date=9/2、dueDate=8/31）
const state = {
  loans: [
    { id: 'b', name: '乙', principal: 500000, rate: 2, startDate: '2026-06-30', dueDay: 31, status: 'normal', prepaidMonths: 0, referralFee: 0 },
  ],
  payments: [
    { id: 'p1', loanId: 'b', date: '2026-06-30', dueDate: '2026-06-30', amount: 10000 },
    { id: 'p2', loanId: 'b', date: '2026-07-31', dueDate: '2026-07-31', amount: 10000 },
    { id: 'p3', loanId: 'b', date: '2026-09-02', dueDate: '2026-08-31', amount: 10000 },
  ],
};

// 9/29：明天 9/30 到期、9 月期別未收 → 必須發「明天要收」提醒
// （若錯把 9/2 的現金當成 9 月收齊，這裡就不會發 —— 即「提醒被錯誤取消」的回歸防線）
{
  const msgs = buildReminders(state, { y: 2026, m: 8, d: 29 });
  assert.equal(msgs.length, 1, '9/29 要有一則明天提醒');
  assert.ok(msgs[0].title.includes('明天') && msgs[0].body.includes('乙'), '提醒對象正確');
}

// 9/30 當天：發「今天要收」
{
  const msgs = buildReminders(state, { y: 2026, m: 8, d: 30 });
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].title.includes('今天'));
}

// 9 月真的收齊後（歸屬 9/30）→ 9/29 不再提醒
{
  const st2 = JSON.parse(JSON.stringify(state));
  st2.payments.push({ id: 'p4', loanId: 'b', date: '2026-09-28', dueDate: '2026-09-30', amount: 10000 });
  assert.equal(buildReminders(st2, { y: 2026, m: 8, d: 29 }).length, 0, '收齊即不提醒');
}

// 非收息日不提醒（9/2 既非今天也非明天到期；收清判斷由 9/29 案例負責）
{
  const msgs = buildReminders(state, { y: 2026, m: 8, d: 2 });
  assert.equal(msgs.length, 0, '非收息日不提醒');
}

// 借款日之前不提醒（防呆迴歸）
{
  const st3 = {
    loans: [{ id: 'f', name: '未來', principal: 100000, rate: 2, startDate: '2026-10-15', dueDay: 14, status: 'normal', prepaidMonths: 0 }],
    payments: [],
  };
  assert.equal(buildReminders(st3, { y: 2026, m: 8, d: 13 }).length, 0, '未開始的借款不提醒');
}

console.log('Worker 提醒行為全過');
