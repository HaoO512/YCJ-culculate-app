// v44：晚繳跨月選期（正式 nextPaymentDraft，不另寫模擬邏輯）＋跨日/捲動結構
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDate, fmtDate, monthlyInterest, dueDateFor,
  nextUnsettledPeriod, nextPaymentDraft, nextCollectDue, monthReport,
} from '../docs/js/calc.js';

// 直接使用正式函式產生草稿並套用 —— receive() 用的就是同一份 nextPaymentDraft
function apply(state, loan, now) {
  const d = nextPaymentDraft(state, loan, now);
  if (d) state.payments.push({ id: 'sim' + state.payments.length, loanId: loan.id, ...d });
  return d;
}

// ── 案例 1：8/18 應收、8/20 收款 → date=8/20、dueDate=8/18；收完下期 9/18 ──
{
  const L = { id: 'a', name: '甲', principal: 300000, rate: 2, startDate: '2026-07-18', dueDay: 18, status: 'normal', prepaidMonths: 0 };
  const st = { loans: [L], payments: [{ id: 'p0', loanId: 'a', date: '2026-07-18', dueDate: '2026-07-18', amount: 6000 }] };
  const d = apply(st, L, parseDate('2026-08-20'));
  assert.equal(d.date, '2026-08-20', '實收日=今天');
  assert.equal(d.dueDate, '2026-08-18', '歸屬期=晚繳的那期，不是 9 月');
  assert.equal(d.amount, 6000);
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
  const d = apply(st, L, now);
  assert.equal(d.date, '2026-09-02');
  assert.equal(d.dueDate, '2026-08-31', '不得寫成 9/30');
  assert.equal(monthReport(st, 2026, 7, now).dueUnpaid, 0, '8月收清');
  assert.equal(monthReport(st, 2026, 8, now).received, 10000, '現金收入計入 9 月');
  assert.equal(fmtDate(nextUnsettledPeriod(st, L, now)), '2026-09-30', '9月期別仍未收，提醒不會被錯誤取消');
  const d2 = apply(st, L, now);
  assert.equal(d2.dueDate, '2026-09-30', '舊按鈕執行時重算期別');
}

// ── 案例 6：8 月已收部分款，跨月只補該期剩餘 ──
{
  const L = { id: 'c', name: '丙', principal: 300000, rate: 2, startDate: '2026-06-30', dueDay: 31, status: 'normal', prepaidMonths: 0 };
  const st = { loans: [L], payments: [
    { id: 'q1', loanId: 'c', date: '2026-06-30', dueDate: '2026-06-30', amount: 6000 },
    { id: 'q2', loanId: 'c', date: '2026-07-31', dueDate: '2026-07-31', amount: 6000 },
    { id: 'q3', loanId: 'c', date: '2026-08-25', dueDate: '2026-08-31', amount: 1000 },
  ] };
  const d = apply(st, L, parseDate('2026-09-02'));
  assert.equal(d.dueDate, '2026-08-31');
  assert.equal(d.amount, 5000, '只補該期剩餘，不重複滿額');
}

// ── 案例 7：借款日在收息日之後，歸屬期不得早於借款日；首期未到不算已收 ──
{
  const L = { id: 'd', name: '丁', principal: 200000, rate: 2, startDate: '2026-08-16', dueDay: 14, status: 'normal', prepaidMonths: 0 };
  const st = { loans: [L], payments: [] };
  const now = parseDate('2026-08-20');
  const d = nextPaymentDraft(st, L, now);
  assert.equal(d.dueDate, '2026-09-14', '第一期是 9/14，不是借款日前的 8/14');
  assert.ok(nextCollectDue(L, parseDate(L.startDate)) > now, '首期尚未到期（UI 不得顯示已收）');
}

// ── 預收涵蓋期不可被選為歸屬期 ──
{
  const L = { id: 'e', name: '戊', principal: 600000, rate: 2, startDate: '2026-08-14', dueDay: 14, status: 'normal', prepaidMonths: 3 };
  const st = { loans: [L], payments: [{ id: 'r1', loanId: 'e', date: '2026-08-14', amount: 36000, kind: 'prepaid' }] };
  assert.equal(nextPaymentDraft(st, L, parseDate('2026-08-20')).dueDate, '2026-11-14', '跳過預收涵蓋期');
}

// ── 循環上限依資料量：61 期、120 期全收也要找到下一期 ──
{
  const mkSettled = (n) => {
    const L = { id: 'g', name: '長', principal: 100000, rate: 2, startDate: '2020-01-05', dueDay: 5, status: 'normal', prepaidMonths: 0 };
    const st = { loans: [L], payments: [] };
    let d = nextCollectDue(L, parseDate(L.startDate));
    for (let i = 0; i < n; i++) {
      st.payments.push({ id: 'k' + i, loanId: 'g', date: fmtDate(d), dueDate: fmtDate(d), amount: 2000 });
      d = dueDateFor(d.getFullYear(), d.getMonth() + 1, L.dueDay);
    }
    return { L, st, next: fmtDate(d) };
  };
  const a = mkSettled(61);
  assert.equal(nextPaymentDraft(a.st, a.L, parseDate('2026-08-20')).dueDate, a.next, '61 期全收 → 回傳第 62 期');
  const b = mkSettled(120);
  assert.equal(nextPaymentDraft(b.st, b.L, parseDate('2026-08-20')).dueDate, b.next, '120 期全收 → 回傳第 121 期');
  // 同一期多筆部分款不影響上限計算
  const c = mkSettled(10);
  const last = c.st.payments.pop();
  c.st.payments.push({ ...last, id: 'h1', amount: 500 }, { ...last, id: 'h2', amount: 700 }, { ...last, id: 'h3', amount: 800 });
  assert.equal(nextPaymentDraft(c.st, c.L, parseDate('2026-08-20')).dueDate, c.next, '多筆部分款收齊同一期，仍正確前進');
}

// ── 結構：共用草稿函式、跨日刷新、內部捲動殼、首期未到文案 ──
{
  const js = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
  assert.ok(js.includes('nextPaymentDraft(state, l, today())'), 'receive 使用正式草稿函式');
  assert.ok(js.includes('...draft1'), '寫入即草稿內容，不另算一套');
  assert.ok(!/const amt = monthlyInterest\(l\) - monthPaidAmount/.test(js), 'receive 內不得殘留自寫金額邏輯');
  assert.ok(js.includes('visibilitychange') && js.includes('pageshow') && js.includes('lastRenderDay'), '背景跨日回前景刷新');
  assert.ok(js.includes('$view.scrollTop = 0') && !js.includes('window.scrollTo(0, 0)'), '內部捲動、切頁回頂');
  assert.ok(js.includes('實收日：') && js.includes('歸屬期：'), '確認面板同列實收日與歸屬期');
  assert.ok(js.includes('待收，晚') && js.includes('本期已收，下次'), '晚繳語意');
  assert.ok(js.includes('neverDue') && js.includes('尚未到期') && js.includes('首次收款'), '首期未到不得顯示已收');
  // 預收語意鏈：涵蓋中/已結束/首次收款三態分開，且判斷順序與按鈕一致
  assert.ok(js.includes('預收涵蓋中，下次收款'), '預收帳 Hero 不得稱首次收款');
  assert.ok(js.includes('預收已結束，下次收款'), '預收結束與一般尚未到期分開');
  assert.ok(js.includes('!hasPrepaid && firstCollectFuture'), '首次收款僅限無預收');
  {
    const start = js.indexOf('let nextTxt');
    const chain = js.slice(start, js.indexOf('const pu = prepaidUntil', start));
    const order = ['待收，晚', 'byPrepaid', 'firstCollectFuture', '本期已收'].map(s => chain.indexOf(s));
    assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), 'Hero 判斷順序：待收→預收→未到期→已收');
  }
  assert.ok(js.includes('missedList.length >= 2'), '兩期以上才叫補繳');
  assert.ok(/html, body \{ height: 100%; overflow: hidden; \}/.test(css), '外殼固定');
  assert.ok(/#view \{[\s\S]{0,200}overscroll-behavior-y: contain/.test(css), '捲動只在 #view');
  assert.ok(/#tabbar \{\n  position: static; flex: none;/.test(css), '導覽列脫離 position:fixed');
}

console.log('v44 晚繳選期+結構全過');
