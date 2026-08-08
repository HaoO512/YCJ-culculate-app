// 計算邏輯：全部純函數
// 日期一律用「本地日」— new Date(y, m, d)，字串存 "YYYY-MM-DD"

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

// 月息
export function monthlyInterest(loan) {
  return Math.round(loan.principal * loan.rate / 100);
}

// 介紹費預設 = 半個月息
export function defaultReferral(principal, rate) {
  return Math.round(principal * rate / 100 / 2);
}

export const DEFAULT_APPRAISAL = 3000;

// 某年某月的收息日（dueDay: 1–31 或 'EOM' 月底）。month 0-based。
// 29–31：當月有該號就用該號，沒有就退到當月最後一天（2 月 → 28/29）
export function dueDateFor(year, month, dueDay) {
  const last = new Date(year, month + 1, 0).getDate();
  if (dueDay === 'EOM') return new Date(year, month, last);
  return new Date(year, month, Math.min(dueDay, last));
}

// 從 from（含當天）起的下一個收息日
export function nextDue(loan, from) {
  let d = dueDateFor(from.getFullYear(), from.getMonth(), loan.dueDay);
  if (d < from) d = dueDateFor(from.getFullYear(), from.getMonth() + 1, loan.dueDay);
  return d;
}

// 欠繳期數：停繳日起（含）到今天（含）之間經過的收息日個數
export function overduePeriods(loan, now) {
  if (!loan.overdueSince) return 0;
  const since = parseDate(loan.overdueSince);
  let d = nextDue(loan, since);
  let n = 0;
  while (d <= now) {
    n++;
    d = dueDateFor(d.getFullYear(), d.getMonth() + 1, loan.dueDay);
  }
  return n;
}

// 欠繳期間已補繳的總額（只算到 now 為止，未來日期的付款不提前沖）
export function arrearsPaid(loan, payments, now) {
  if (!loan.overdueSince) return 0;
  const cap = now ? fmtDate(now) : '9999-12-31';
  return (payments || []).reduce((s, p) =>
    p.loanId === loan.id && p.date >= loan.overdueSince && p.date <= cap ? s + p.amount : s, 0);
}

// 累計欠息（單利，扣掉欠繳期間的補繳，下限 0）
export function overdueInterest(loan, now, payments) {
  const gross = overduePeriods(loan, now) * monthlyInterest(loan);
  return Math.max(0, gross - arrearsPaid(loan, payments, now));
}

// 簽約後第一個收息日（嚴格在借款日之後）
export function firstDueAfterStart(loan) {
  const s = parseDate(loan.startDate);
  return nextDue(loan, new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1));
}

// 預收利息涵蓋到的最後一個收息日；沒預收回傳 null
// 期初先收制：簽約日當期就算第 1 期（8/6 簽收 3 個月 = 涵蓋 8/6、9/6、10/6，下次 11/6 收）
export function prepaidUntil(loan) {
  const n = loan.prepaidMonths || 0;
  if (n <= 0) return null;
  const s = parseDate(loan.startDate);
  let d = dueDateFor(s.getFullYear(), s.getMonth(), loan.dueDay);
  if (d < s) d = dueDateFor(s.getFullYear(), s.getMonth() + 1, loan.dueDay);
  for (let i = 1; i < n; i++) d = dueDateFor(d.getFullYear(), d.getMonth() + 1, loan.dueDay);
  return d;
}

// 該月已處理？（實際收過款，或被預收涵蓋）
export function settledInMonth(payments, loan, year, month) {
  if (paidInMonth(payments, loan.id, year, month)) return true;
  const pu = prepaidUntil(loan);
  if (!pu) return false;
  return dueDateFor(year, month, loan.dueDay) <= pu;
}

// 下一個「真的要收」的收息日（跳過預收涵蓋期；不早於借款日）
export function nextCollectDue(loan, from) {
  const s = parseDate(loan.startDate);
  if (from < s) from = s;
  let d = nextDue(loan, from);
  const pu = prepaidUntil(loan);
  if (pu && d <= pu) d = dueDateFor(pu.getFullYear(), pu.getMonth() + 1, loan.dueDay);
  return d;
}

// 本月是否已收息（看收款記錄有沒有落在該月）
export function paidInMonth(payments, loanId, year, month) {
  return payments.some(p => {
    if (p.loanId !== loanId) return false;
    const d = parseDate(p.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });
}

export function isActive(loan) {
  return loan.status !== 'closed';
}

export function isProblem(loan) {
  return loan.status === 'overdue' || loan.status === 'legal';
}

// 全域統計
export function stats(state, now) {
  const active = state.loans.filter(isActive);
  const problems = active.filter(isProblem);
  const normals = active.filter(l => l.status === 'normal');

  const principalOut = active.reduce((s, l) => s + l.principal, 0);
  const received = state.payments.reduce((s, p) => s + p.amount, 0);

  const yearReceived = state.payments.reduce((s, p) => {
    return parseDate(p.date).getFullYear() === now.getFullYear() ? s + p.amount : s;
  }, 0);

  // 本月要收：排除借款日之前、被預收涵蓋的月份
  const monthDue = normals.reduce((s, l) => {
    const due = dueDateFor(now.getFullYear(), now.getMonth(), l.dueDay);
    if (due < parseDate(l.startDate)) return s;
    const pu = prepaidUntil(l);
    if (pu && due <= pu) return s;
    return s + monthlyInterest(l);
  }, 0);
  const monthReceived = state.payments.reduce((s, p) => {
    const d = parseDate(p.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() ? s + p.amount : s;
  }, 0);

  const referralTotal = state.loans.reduce((s, l) => s + (l.referralFee || 0), 0);
  const appraisalTotal = state.loans.reduce((s, l) => s + (l.appraisalFee || 0), 0);

  const overdueInt = problems.reduce((s, l) => s + overdueInterest(l, now, state.payments), 0);
  const overduePrincipal = problems.reduce((s, l) => s + l.principal, 0);

  const writeoffTotal = state.loans.reduce((s, l) => s + (l.writeoff || 0), 0);

  return {
    principalOut, received, yearReceived,
    monthDue, monthReceived,
    referralTotal, appraisalTotal,
    net: received - referralTotal - appraisalTotal,
    overdueInt, overduePrincipal,
    overdueTotal: overduePrincipal + overdueInt,
    problemCount: problems.length,
    writeoffTotal,
  };
}

// 單月月報。語意：到期（該月該收的）／入帳（該月實際收到的錢，含預收補繳）
// 已結清的帳在結清日之前的月份仍計入，歷史不被改寫
export function monthReport(state, y, m, now) {
  const nowD = now || today();
  const rows = [];
  for (const l of state.loans) {
    const d = dueDateFor(y, m, l.dueDay);
    if (l.status === 'closed') {
      if (!l.closedDate || d > parseDate(l.closedDate)) continue;
    }
    if (d < parseDate(l.startDate)) continue;
    const pu = prepaidUntil(l);
    if (pu && d <= pu) continue;                       // 預收涵蓋：該月無事
    rows.push({
      loan: l, day: d.getDate(), amount: monthlyInterest(l),
      paid: paidInMonth(state.payments, l.id, y, m),
      expired: d <= nowD,                              // 已到期
      problem: isProblem(l),
    });
  }
  const inMonth = p => {
    const pd = parseDate(p.date);
    return pd.getFullYear() === y && pd.getMonth() === m;
  };
  const payList = state.payments.filter(inMonth)
    .sort((a, b) => a.date.localeCompare(b.date));
  const received = payList.reduce((s, p) => s + p.amount, 0);
  const unpaidAll = rows.filter(r => !r.paid).sort((a, b) => a.day - b.day);
  const unpaidRows = unpaidAll.filter(r => r.expired);   // 已到期未收（要處理的）
  const notYetRows = unpaidAll.filter(r => !r.expired);  // 尚未到期（正常）
  return {
    due: rows.reduce((s, r) => s + r.amount, 0),
    received,
    unpaid: unpaidAll.reduce((s, r) => s + r.amount, 0),
    dueUnpaid: unpaidRows.reduce((s, r) => s + r.amount, 0),
    notYet: notYetRows.reduce((s, r) => s + r.amount, 0),
    unpaidRows, notYetRows, payList,
  };
}

// 跨月：從今天起真正最近的 count 筆收息（跳過已入帳月份；漏收中的人不重複列）
export function upcomingDues(state, now, count = 3, excludeIds = null) {
  const out = [];
  for (const l of state.loans) {
    if (l.status !== 'normal') continue;
    if (excludeIds && excludeIds.has(l.id)) continue;
    let d = nextCollectDue(l, now);
    let guard = 0;
    while (guard++ < 24 && settledInMonth(state.payments, l, d.getFullYear(), d.getMonth())) {
      d = dueDateFor(d.getFullYear(), d.getMonth() + 1, l.dueDay);
    }
    out.push({ loan: l, date: d });
  }
  return out.sort((a, b) => a.date - b.date).slice(0, count);
}

// 跨月：所有「過了收息日還沒記收款」的帳（直到記收款或標欠繳才消失）
export function missedDues(state, now) {
  const out = [];
  for (const l of state.loans) {
    if (l.status !== 'normal') continue;
    // 首期在借款日之後（簽約日本身不是一期；預收涵蓋期自動跳過）
    const s = parseDate(l.startDate);
    let d = nextCollectDue(l, new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1));
    let guard = 0;
    const misses = [];
    while (d < now && guard++ < 36) {
      if (!settledInMonth(state.payments, l, d.getFullYear(), d.getMonth())) misses.push(new Date(d));
      d = dueDateFor(d.getFullYear(), d.getMonth() + 1, l.dueDay);
    }
    if (misses.length) {
      out.push({ loan: l, first: misses[0], count: misses.length, amount: misses.length * monthlyInterest(l) });
    }
  }
  return out.sort((a, b) => a.first - b.first);
}

// 近 n 個月每月實收利息（含當月），回傳 [{year, month, total}]
export function monthlySeries(payments, now, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const y = now.getFullYear();
    const m = now.getMonth() - i;
    const d = new Date(y, m, 1);
    const total = payments.reduce((s, p) => {
      const pd = parseDate(p.date);
      return pd.getFullYear() === d.getFullYear() && pd.getMonth() === d.getMonth() ? s + p.amount : s;
    }, 0);
    out.push({ year: d.getFullYear(), month: d.getMonth(), total });
  }
  return out;
}

export function money(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}
