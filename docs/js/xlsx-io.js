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
    '結清日': l.closedDate || '',
    '介紹費': l.referralFee || 0,
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
      '累計欠息': overdueInterest(l, now, state.payments),
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
    '歸屬期': p.dueDate || '',
    '金額': p.amount,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payRows), '收款記錄');

  // 技術資料表：保存墓碑（已刪帳的停止提醒資訊），匯入時合併不遺失
  if (state.tombstones && state.tombstones.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.tombstones.map(t => ({
      '編號': t.id,
      '姓名': t.name,
      '收息日': t.dueDay === 'EOM' ? '月底' : t.dueDay,
      '借款日期': t.startDate,
    }))), '系統資料');
  }

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
      if (!(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) errors.push(`${rowNo}：收息日要 1–31 的整數或「月底」`);
    }

    const statusTxt = String(r['狀態'] || '正常').trim();
    const status = TXT_STATUS[statusTxt];
    if (!status) errors.push(`${rowNo}：狀態「${statusTxt}」看不懂`);

    const overdueSince = r['停繳日'] ? normDate(r['停繳日']) : null;
    if ((status === 'overdue' || status === 'legal') && !overdueSince)
      errors.push(`${rowNo}：欠繳／法院狀態要填停繳日`);
    const closedDate = r['結清日'] ? normDate(r['結清日']) : null;
    if (r['結清日'] && !closedDate) errors.push(`${rowNo}：結清日格式錯`);
    // 日期關係與本機/雲端同一套，匯入成功但同步被拒的情況不該存在
    if (startDate && overdueSince && overdueSince < startDate) errors.push(`${rowNo}：停繳日早於借款日`);
    if (startDate && closedDate && closedDate < startDate) errors.push(`${rowNo}：結清日早於借款日`);

    const prepaidMonths = Number(r['預收月數'] || 0);
    if (!(Number.isInteger(prepaidMonths) && prepaidMonths >= 0 && prepaidMonths <= 12)) errors.push(`${rowNo}：預收月數要 0–12 的整數`);
    const referralFee = Number(r['介紹費'] || 0);
    if (!(Number.isFinite(referralFee) && referralFee >= 0)) errors.push(`${rowNo}：介紹費無效`);

    const finalReceived = r['結案實收'] === '' || r['結案實收'] == null ? null : Number(r['結案實收']);
    const writeoff = r['壞帳沖銷'] === '' || r['壞帳沖銷'] == null ? null : Number(r['壞帳沖銷']);
    if (finalReceived != null && !(Number.isFinite(finalReceived) && finalReceived >= 0)) errors.push(`${rowNo}：結案實收無效`);
    if (writeoff != null && !(Number.isFinite(writeoff) && writeoff >= 0)) errors.push(`${rowNo}：壞帳沖銷無效`);

    loans.push({
      id: String(r['編號'] || '').trim() || newId(),
      name, principal, rate, startDate, dueDay, prepaidMonths,
      status: status || 'normal',
      overdueSince,
      closedDate,
      finalReceived,
      writeoff,
      referralFee,
      note: String(r['備註'] || ''),
    });
  });

  // 重複編號檢查
  const seen = new Set();
  loans.forEach((l, i) => {
    if (seen.has(l.id)) errors.push(`借款主表第 ${i + 2} 列：編號「${l.id}」重複`);
    seen.add(l.id);
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
      if (!(Number.isFinite(amount) && amount > 0)) errors.push(`${rowNo}：金額不是正數`);
      const pid = String(r['編號'] || '').trim() || newId();
      if (payments.some(p => p.id === pid)) errors.push(`${rowNo}：收款編號「${pid}」重複`);
      const dueDate = r['歸屬期'] ? normDate(r['歸屬期']) : null;
      if (r['歸屬期'] && !dueDate) errors.push(`${rowNo}：歸屬期格式錯`);
      payments.push({ id: pid, loanId, date, ...(dueDate ? { dueDate } : {}), amount });
    });
  }

  // 系統資料表（墓碑）：最多 100、ID 不得重複
  const tombstones = [];
  const tsSheet = wb.Sheets['系統資料'];
  if (tsSheet) {
    const seenT = new Set();
    XLSX.utils.sheet_to_json(tsSheet).forEach((r, i) => {
      const rowNo = `系統資料第 ${i + 2} 列`;
      const id = String(r['編號'] || '').trim();
      let dd = r['收息日'];
      if (dd === '月底' || dd === 'EOM') dd = 'EOM'; else dd = Number(dd);
      const sd = normDate(r['借款日期']);
      if (!id || seenT.has(id)) { errors.push(`${rowNo}：編號缺失或重複`); return; }
      seenT.add(id);
      if (!(dd === 'EOM' || (Number.isInteger(dd) && dd >= 1 && dd <= 31))) errors.push(`${rowNo}：收息日無效`);
      if (!sd) errors.push(`${rowNo}：借款日期無效`);
      tombstones.push({ id, name: String(r['姓名'] || ''), dueDay: dd, startDate: sd });
    });
    if (tombstones.length > 100) errors.push('系統資料（已刪帳清單）超過 100 筆');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true, errors: [],
    state: { version: 1, loans, payments, lastExport: null, ...(tombstones.length ? { tombstones } : {}) },
  };
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
