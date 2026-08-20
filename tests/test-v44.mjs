// v44：晚繳跨月選期（nextUnsettledPeriod）＋跨日/捲動結構
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDate, fmtDate, monthlyInterest, monthPaidAmount,
  nextUnsettledPeriod, monthReport,
} from '../docs/js/calc.js';

// 模擬 receive() 的寫入規則：date=今天、dueDate=最早未收齊期、amount=該期剩餘
function simulateReceive(state, loan, now) {
  const due = nextUnsettledPeriod(state, loan, now);
  const amt = monthlyInterest(loan) - monthPaidAmount(state.payments, loan.id, due.getFullYear(), due.getMonth());
  if (amt <= 0) return null;
  const p = { id: 'sim' + state.payments.length, loanId: loan.id, date: fmtDate(now), dueDate: fmtDate(due), amount: amt };
  state.payments.push(p);
  return p;
}

// ── 案例 1：8/18 應收、8/20 收款 → date=8/20、dueDate=8/18；收完下期 9/18 ──
{
  const L = { id: 'a', name: '甲', principal: 300000, rate: 2, startDate: '2026-07-18', dueDay: 18, status: 'normal', prepaidMonths: 0 };
  const st = { loans: [L], payments: [{ id: 'p0', loanId: 'a', date: '2026-07-18', dueDate: '2026-07-18', amount: 6000 }] };
  const p = simulateReceive(st, L, parseDate('2026-08-20'));
  assert.equal(p.date, '2026-08-20', '實收日=今天');
  assert.equal(p.dueDate, '2026-08-18', '歸屬期=晚繳的那期，不是 9 月');
  assert.equal(fmtDate(nextUnsettledPeriod(st, L, parseDate('2026-08-20'))), '2026-09-18', '收完顯示下次 9/18');
}

// ── 案例 3/4/5：8/31 應收、9/2 收款 → dueDate=8/31；8月收清、9月現金、9月期別未收 ──
{
  const L = { id: 'b', name: '乙', principal: 500000, rate: 2, startDate: '2026-06-30', dueDay: 31, status: 'normal', prepaidMonths: 0 };
  const st = { loans: [L], payments: [
    { id: 'p1', loanId: 'b', date: '2026-06-30', dueDate: '2026-06-30', amount: 10000 },
    { id: 'p2', loanId: 'b', date: '2026-07-31', dueDate: '2026-07-31', amount: 10000 },
  ] };
  const now = parseDate('2026-09-02');
  const p = simulateReceive(st, L, now);
  assert.equal(p.date, '2026-09-02');
  assert.equal(p.dueDate, '2026-08-31', '不得寫成 9/30');
  const aug = monthReport(st, 2026, 7, now);
  assert.equal(aug.dueUnpaid, 0, '8月收清');
  const sep = monthReport(st, 2026, 8, now);
  assert.equal(sep.received, 10000, '現金收入計入 9 月');
  assert.equal(fmtDate(nextUnsettledPeriod(st, L, now)), '2026-09-30', '9月期別仍未收，提醒不會被錯誤取消');
  // 舊畫面再按一次：重新判斷 → 記到 9/30，不會亂寫
  const p2 = simulateReceive(st, L, now);
  assert.equal(p2.dueDate, '2026-09-30', '舊按鈕執行時重算期別');
}

// ── 案例 6：8 月已收部分款，跨月只補該期剩餘 ──
{
  const L = { id: 'c', name: '丙', principal: 300000, rate: 2, startDate: '2026-06-30', dueDay: 31, status: 'normal', prepaidMonths: 0 };
  const st = { loans: [L], payments: [
    { id: 'q1', loanId: 'c', date: '2026-06-30', dueDate: '2026-06-30', amount: 6000 },
    { id: 'q2', loanId: 'c', date: '2026-07-31', dueDate: '2026-07-31', amount: 6000 },
    { id: 'q3', loanId: 'c', date: '2026-08-25', dueDate: '2026-08-31', amount: 1000 },
  ] };
  const p = simulateReceive(st, L, parseDate('2026-09-02'));
  assert.equal(p.dueDate, '2026-08-31');
  assert.equal(p.amount, 5000, '只補該期剩餘，不重複滿額');
}

// ── 案例 7：借款日在收息日之後，歸屬期不得早於借款日 ──
{
  const L = { id: 'd', name: '丁', principal: 200000, rate: 2, startDate: '2026-08-16', dueDay: 14, status: 'normal', prepaidMonths: 0 };
  const st = { loans: [L], payments: [] };
  const p = simulateReceive(st, L, parseDate('2026-08-20'));
  assert.equal(p.dueDate, '2026-09-14', '第一期是 9/14，不是借款日前的 8/14');
}

// ── 預收涵蓋期不可被選為歸屬期 ──
{
  const L = { id: 'e', name: '戊', principal: 600000, rate: 2, startDate: '2026-08-14', dueDay: 14, status: 'normal', prepaidMonths: 3 };
  const st = { loans: [L], payments: [{ id: 'r1', loanId: 'e', date: '2026-08-14', amount: 36000, kind: 'prepaid' }] };
  assert.equal(fmtDate(nextUnsettledPeriod(st, L, parseDate('2026-08-20'))), '2026-11-14', '跳過預收涵蓋期');
}

// ── 結構：跨日刷新、內部捲動殼、確認後重算 ──
{
  const js = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
  assert.ok(js.includes('visibilitychange') && js.includes('pageshow') && js.includes('lastRenderDay'), '背景跨日回前景刷新');
  assert.ok(js.includes('$view.scrollTop = 0'), '切頁回頂（內部捲動）');
  assert.ok(!js.includes('window.scrollTo(0, 0)'), '不再用整頁捲動');
  assert.ok(js.includes('確認後重算'), '寫入前重新計算期別，不信畫面');
  assert.ok(js.includes('實收日：') && js.includes('歸屬期：'), '確認面板同列實收日與歸屬期');
  assert.ok(js.includes('待收，晚') && js.includes('本期已收，下次'), '晚繳語意');
  assert.ok(js.includes('missedList.length >= 2'), '兩期以上才叫補繳');
  assert.ok(/html, body \{ height: 100%; overflow: hidden; \}/.test(css), '外殼固定');
  assert.ok(/#view \{[\s\S]{0,160}overflow-y: auto/.test(css), '捲動只在 #view');
  assert.ok(/#view \{[\s\S]{0,200}overscroll-behavior-y: contain/.test(css), '回彈不外溢');
  assert.ok(/#tabbar \{\n  position: static; flex: none;/.test(css), '導覽列脫離 position:fixed');
}

console.log('v44 晚繳選期+結構全過');
