// xlsx 匯出／匯入（SheetJS 全域 XLSX，vendor 載入）
import { monthlyInterest, overduePeriods, overdueInterest, parseDate, fmtDate, today } from './calc.js';
import { newId } from './store.js';

const STATUS_TXT = { normal: '正常', overdue: '欠繳', legal: '法院處理中', closed: '已結清' };
const TXT_STATUS = Object.fromEntries(Object.entries(STATUS_TXT).map(([k, v]) => [v, k]));

export function exportXlsx(state) {
  const now = today();
  const wb = XLSX.utils.book_new();

  const loanRows = state.loans.map(l => ({
    '編號': l.id,
    '姓名': l.name,
    '本金': l.principal,
    '月利率%': l.rate,
    '借款日期': l.startDate,
    '收息日': l.dueDay === 'EOM' ? '月底' : l.dueDay,
    '預收月數': l.prepaidMonths || 0,
    '每月利息': monthlyInterest(l),
    '狀態': STATUS_TXT[l.status] || l.status,
    '停繳日': l.overdueSince || '',
    '介紹費': l.referralFee || 0,
    '代書費': l.appraisalFee || 0,
    '結案實收': l.finalReceived ?? '',
    '壞帳沖銷': l.writeoff ?? '',
    '備註': l.note || '',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(loanRows), '借款主表');

  const probRows = state.loans
    .filter(l => l.status === 'overdue' || l.status === 'legal')
    .map(l => ({
      '姓名': l.name,
      '未還本金': l.principal,
      '停繳日': l.overdueSince || '',
      '欠繳期數': overduePeriods(l, now),
      '累計欠息': overdueInterest(l, now),
      '狀態': STATUS_TXT[l.status],
      '備註': l.note || '',
    }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(probRows), '問題帳目');

  const nameOf = id => (state.loans.find(l => l.id === id) || {}).name || '';
  const payRows = state.payments.map(p => ({
    '編號': p.id,
    '借款編號': p.loanId,
    '姓名': nameOf(p.loanId),
    '日期': p.date,
    '金額': p.amount,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payRows), '收款記錄');

  const stamp = fmtDate(now).replace(/-/g, '');
  XLSX.writeFile(wb, `借貸帳本-${stamp}.xlsx`);
}

// 匯入：驗證全部通過才整批取代，回傳 {ok, errors, state?}
export function parseXlsx(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const errors = [];

  const loanSheet = wb.Sheets['借款主表'];
  if (!loanSheet) return { ok: false, errors: ['找不到「借款主表」工作表'] };

  const loanRows = XLSX.utils.sheet_to_json(loanSheet);
  const loans = [];
  loanRows.forEach((r, i) => {
    const rowNo = `借款主表第 ${i + 2} 列`;
    const name = String(r['姓名'] || '').trim();
    const principal = Number(r['本金']);
    const rate = Number(r['月利率%']);
    const startDate = normDate(r['借款日期']);
    let dueDay = r['收息日'];

    if (!name) errors.push(`${rowNo}：缺姓名`);
    if (!(principal > 0)) errors.push(`${rowNo}：本金不是正數`);
    if (!(rate > 0 && rate <= 20)) errors.push(`${rowNo}：月利率不合理（${r['月利率%']}）`);
    if (!startDate) errors.push(`${rowNo}：借款日期格式錯（要 YYYY-MM-DD）`);

    if (dueDay === '月底' || dueDay === 'EOM') dueDay = 'EOM';
    else {
      dueDay = Number(dueDay);
      if (!(dueDay >= 1 && dueDay <= 28)) errors.push(`${rowNo}：收息日要 1–28 或「月底」`);
    }

    const statusTxt = String(r['狀態'] || '正常').trim();
    const status = TXT_STATUS[statusTxt];
    if (!status) errors.push(`${rowNo}：狀態「${statusTxt}」看不懂`);

    const overdueSince = r['停繳日'] ? normDate(r['停繳日']) : null;
    if ((status === 'overdue' || status === 'legal') && !overdueSince)
      errors.push(`${rowNo}：欠繳／法院狀態要填停繳日`);

    const prepaidMonths = Number(r['預收月數'] || 0);
    if (!(prepaidMonths >= 0 && prepaidMonths <= 12)) errors.push(`${rowNo}：預收月數不合理`);

    loans.push({
      id: String(r['編號'] || '').trim() || newId(),
      name, principal, rate, startDate, dueDay, prepaidMonths,
      status: status || 'normal',
      overdueSince,
      finalReceived: r['結案實收'] === '' || r['結案實收'] == null ? null : Number(r['結案實收']),
      writeoff: r['壞帳沖銷'] === '' || r['壞帳沖銷'] == null ? null : Number(r['壞帳沖銷']),
      referralFee: Number(r['介紹費'] || 0),
      appraisalFee: Number(r['代書費'] || 0),
      note: String(r['備註'] || ''),
    });
  });

  const ids = new Set(loans.map(l => l.id));
  const payments = [];
  const paySheet = wb.Sheets['收款記錄'];
  if (paySheet) {
    XLSX.utils.sheet_to_json(paySheet).forEach((r, i) => {
      const rowNo = `收款記錄第 ${i + 2} 列`;
      const loanId = String(r['借款編號'] || '').trim();
      const date = normDate(r['日期']);
      const amount = Number(r['金額']);
      if (!ids.has(loanId)) errors.push(`${rowNo}：借款編號「${loanId}」對不上主表`);
      if (!date) errors.push(`${rowNo}：日期格式錯`);
      if (!(amount > 0)) errors.push(`${rowNo}：金額不是正數`);
      payments.push({ id: String(r['編號'] || '').trim() || newId(), loanId, date, amount });
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], state: { version: 1, loans, payments, lastExport: null } };
}

// 支援 "YYYY-MM-DD" 字串或 Excel 日期序號
function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim().replace(/[./]/g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, dd] = s.split('-').map(Number);
    const d = new Date(y, m - 1, dd);
    if (d.getMonth() === m - 1) return fmtDate(d);
  }
  return null;
}
