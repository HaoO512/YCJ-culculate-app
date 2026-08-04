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

// 某年某月的收息日（dueDay: 1–28 或 'EOM' 月底）。month 0-based。
export function dueDateFor(year, month, dueDay) {
  if (dueDay === 'EOM') return new Date(year, month + 1, 0);
  return new Date(year, month, dueDay);
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

// 累計欠息（單利）
export function overdueInterest(loan, now) {
  return overduePeriods(loan, now) * monthlyInterest(loan);
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

  const monthDue = normals.reduce((s, l) => s + monthlyInterest(l), 0);
  const monthReceived = state.payments.reduce((s, p) => {
    const d = parseDate(p.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() ? s + p.amount : s;
  }, 0);

  const referralTotal = state.loans.reduce((s, l) => s + (l.referralFee || 0), 0);
  const appraisalTotal = state.loans.reduce((s, l) => s + (l.appraisalFee || 0), 0);

  const overdueInt = problems.reduce((s, l) => s + overdueInterest(l, now), 0);
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
