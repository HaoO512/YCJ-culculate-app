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
// 期初先收制：簽約日當期＝第 1 期，之後每個「嚴格晚於簽約日」的收息日各算一期
// 例：8/16 簽、每月 14 收、預收 3 → 涵蓋 8/16 當期、9/14、10/14，下次 11/14
//     8/6 簽、每月 6 收、預收 3  → 涵蓋 8/6、9/6、10/6，下次 11/6
export function prepaidUntil(loan) {
  const n = loan.prepaidMonths || 0;
  if (n <= 0) return null;
  let d = parseDate(loan.startDate);
  for (let i = 1; i < n; i++) {
    const cand = dueDateFor(d.getFullYear(), d.getMonth(), loan.dueDay);
    d = cand > d ? cand : dueDateFor(d.getFullYear(), d.getMonth() + 1, loan.dueDay);
  }
  return d;
}

// 該月已處理？（該月收款合計 ≥ 月息才算收齊；或被預收涵蓋）
// 部分款不會讓「到期未收」憑空消失
export function settledInMonth(payments, loan, year, month) {
  if (monthPaidAmount(payments, loan.id, year, month) >= monthlyInterest(loan)) return true;
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

// 該月「歸屬」收款總額 —— 判斷哪一期收清用歸屬期（dueDate），沒有就用收款日
// 現金流（月報入帳、統計）另外看真收款日 p.date，兩者語意分開
export function monthPaidAmount(payments, loanId, year, month) {
  return payments.reduce((s, p) => {
    if (p.loanId !== loanId) return s;
    const d = parseDate(p.dueDate || p.date);
    return d.getFullYear() === year && d.getMonth() === month ? s + p.amount : s;
  }, 0);
}

// 本月是否有任何收款（部分款也算「有收過錢」，但不代表該期收齊）
export function paidInMonth(payments, loanId, year, month) {
  return monthPaidAmount(payments, loanId, year, month) > 0;
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

  // 費用只剩介紹費；代書費由客戶負擔，已從系統退役
  const referralTotal = state.loans.reduce((s, l) => s + (l.referralFee || 0), 0);

  const overdueInt = problems.reduce((s, l) => s + overdueInterest(l, now, state.payments), 0);
  const overduePrincipal = problems.reduce((s, l) => s + l.principal, 0);

  const writeoffTotal = state.loans.reduce((s, l) => s + (l.writeoff || 0), 0);

  return {
    principalOut, received, yearReceived,
    monthDue, monthReceived,
    referralTotal,
    net: received - referralTotal,
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
      paid: monthPaidAmount(state.payments, l.id, y, m) >= monthlyInterest(l),
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
  // 本月付出費用（現金收付制）：介紹費為簽約一次性費用，以借款日歸月
  // 四種狀態的借款都計入；代書費由客戶負擔，不列入本系統
  const expense = state.loans.reduce((s, l) => {
    const sd = parseDate(l.startDate);
    return sd.getFullYear() === y && sd.getMonth() === m ? s + (l.referralFee || 0) : s;
  }, 0);
  const unpaidAll = rows.filter(r => !r.paid).sort((a, b) => a.day - b.day);
  const unpaidRows = unpaidAll.filter(r => r.expired);   // 已到期未收（要處理的）
  const notYetRows = unpaidAll.filter(r => !r.expired);  // 尚未到期（正常）
  return {
    due: rows.reduce((s, r) => s + r.amount, 0),
    received,
    expense,
    net: received - expense,
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

// 最早「尚未收齊」的期別：收款動作唯一的選期依據
// 規則：從第一個有效收息期開始（簽約日當期起算）→ 跳過預收涵蓋期（nextCollectDue 內建）
// → 跳過已收齊期 → 回傳最早未收齊的期；永不早於借款日；29–31/月底沿用 dueDateFor
export function nextUnsettledPeriod(state, loan, now) {
  let d = nextCollectDue(loan, parseDate(loan.startDate));
  // 循環上限依資料量計算，不用任意常數：
  // 已收齊的月份數 ≤ 該借款收款筆數 + 預收月數，所以走完這個數一定碰到未收齊期
  const maxSteps = state.payments.filter(p => p.loanId === loan.id).length + (loan.prepaidMonths || 0) + 2;
  let guard = 0;
  while (guard++ < maxSteps && settledInMonth(state.payments, loan, d.getFullYear(), d.getMonth())) {
    d = dueDateFor(d.getFullYear(), d.getMonth() + 1, loan.dueDay);
  }
  return d;
}

// 正式的收款草稿：receive() 與測試共用同一份規則，不允許各寫一套
// 回傳 {date, dueDate, amount}；該期已收齊回傳 null
export function nextPaymentDraft(state, loan, now) {
  const due = nextUnsettledPeriod(state, loan, now);
  const amount = monthlyInterest(loan) - monthPaidAmount(state.payments, loan.id, due.getFullYear(), due.getMonth());
  if (amount <= 0) return null;
  return { date: fmtDate(now), dueDate: fmtDate(due), amount };
}

// 單筆借款：過了收息日還沒收齊的期，各期附「剩餘該補的金額」（部分款已扣）
export function missedPeriods(state, loan, now) {
  const out = [];
  const mi = monthlyInterest(loan);
  let d = nextCollectDue(loan, parseDate(loan.startDate));
  let guard = 0;
  while (d < now && guard++ < 36) {
    const remaining = mi - monthPaidAmount(state.payments, loan.id, d.getFullYear(), d.getMonth());
    if (remaining > 0) out.push({ date: new Date(d), remaining });
    d = dueDateFor(d.getFullYear(), d.getMonth() + 1, loan.dueDay);
  }
  return out;
}

// 跨月：所有「過了收息日還沒收齊」的帳（直到收齊或標欠繳才消失）
export function missedDues(state, now) {
  const out = [];
  for (const l of state.loans) {
    if (l.status !== 'normal') continue;
    const periods = missedPeriods(state, l, now);
    if (periods.length) {
      out.push({
        loan: l, first: periods[0].date, count: periods.length,
        amount: periods.reduce((s, p) => s + p.remaining, 0),
      });
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

// 墓碑合併：依 ID 去重（匯入的較新、覆蓋現有）、剔除已復活為借款的 ID、保留最新 100 筆
// 注意：Map.set 更新既有 key 不會改變插入順序，必須先 delete 再 set，
// 匯入的資料才會排到最後、在 slice(-100) 超限裁切時被視為最新保留
export function mergeTombstones(current, imported, liveIds) {
  const map = new Map();
  for (const t of current || []) map.set(t.id, t);
  for (const t of imported || []) {
    map.delete(t.id);
    map.set(t.id, t);
  }
  return [...map.values()].filter(t => !liveIds.has(t.id)).slice(-100);
}

export function money(n) {
  const r = Math.round(n);
  return r < 0 ? '-$' + Math.abs(r).toLocaleString('en-US') : '$' + r.toLocaleString('en-US');
}
