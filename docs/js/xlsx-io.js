// xlsx 匯出／匯入（SheetJS 全域 XLSX，vendor 載入）
import { monthlyInterest, overduePeriods, overdueInterest, fmtDate, today, ARCHIVE_REASONS } from './calc.js';
import { newId } from './store.js';

const STATUS_TXT = { normal: '正常', overdue: '欠繳', legal: '法院處理中', closed: '已結清' };
const TXT_STATUS = Object.fromEntries(Object.entries(STATUS_TXT).map(([k, v]) => [v, k]));

// 一般工作表：只有正式資料。救援封存另外兩張技術表（系統救援_借款／系統救援_收款），一般表不顯示已刪資料
const LOAN_HEADER = ['編號', '姓名', '本金', '月利率%', '借款日期', '收息日', '預收月數', '每月利息',
  '狀態', '停繳日', '結清日', '介紹費', '結案實收', '壞帳沖銷', '備註'];
const PAY_HEADER = ['編號', '借款編號', '姓名', '日期', '歸屬期', '金額'];
const RESCUE_EXTRA = ['刪除時間', '封存原因'];

function loanRow(l) {
  return {
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
  };
}

function payRow(p, name) {
  return {
    '編號': p.id,
    '借款編號': p.loanId,
    '姓名': name,
    '日期': p.date,
    '歸屬期': p.dueDate || '',
    '金額': p.amount,
  };
}

export function exportXlsx(state) {
  const now = today();
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.loans.map(loanRow), { header: LOAN_HEADER }), '借款主表');

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
  XLSX.utils.book_append_sheet(wb,
    XLSX.utils.json_to_sheet(state.payments.map(p => payRow(p, nameOf(p.loanId))), { header: PAY_HEADER }), '收款記錄');

  // 技術資料表：保存墓碑（已刪帳的停止提醒資訊），匯入時合併不遺失
  if (state.tombstones && state.tombstones.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.tombstones.map(t => ({
      '編號': t.id,
      '姓名': t.name,
      '收息日': t.dueDay === 'EOM' ? '月底' : t.dueDay,
      '借款日期': t.startDate,
    }))), '系統資料');
  }

  // 技術救援表：結案刪除的完整借款與全部收款，含刪除時間與封存原因（一律附上，空表也保留表頭）
  const records = state.deletedRecords || [];
  const extra = r => ({ '刪除時間': r.deletedAt, '封存原因': r.reason });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    records.map(r => ({ ...loanRow(r.loan), ...extra(r) })), { header: [...LOAN_HEADER, ...RESCUE_EXTRA] }), '系統救援_借款');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
    records.flatMap(r => r.payments.map(p => ({ ...payRow(p, r.loan.name), ...extra(r) }))),
    { header: [...PAY_HEADER, ...RESCUE_EXTRA] }), '系統救援_收款');

  const stamp = fmtDate(now).replace(/-/g, '');
  XLSX.writeFile(wb, `借貸帳本-${stamp}.xlsx`);
}

// 一列借款（借款主表與系統救援_借款共用同一套規則）
function parseLoanRow(r, rowNo, errors) {
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

  return {
    id: String(r['編號'] || '').trim() || newId(),
    name, principal, rate, startDate, dueDay, prepaidMonths,
    status: status || 'normal',
    overdueSince,
    closedDate,
    finalReceived,
    writeoff,
    referralFee,
    note: String(r['備註'] || ''),
  };
}

// 一列收款；loanIds＝允許對應的借款編號集合，payIds＝全域收款編號（正式＋救援不得重複）
function parsePayRow(r, rowNo, errors, loanIds, payIds, orphanMsg) {
  const loanId = String(r['借款編號'] || '').trim();
  const date = normDate(r['日期']);
  const amount = Number(r['金額']);
  if (!loanIds.has(loanId)) errors.push(`${rowNo}：借款編號「${loanId}」${orphanMsg}`);
  if (!date) errors.push(`${rowNo}：日期格式錯`);
  if (!(Number.isFinite(amount) && amount > 0)) errors.push(`${rowNo}：金額不是正數`);
  const pid = String(r['編號'] || '').trim() || newId();
  if (payIds.has(pid)) errors.push(`${rowNo}：收款編號「${pid}」重複`);
  payIds.add(pid);
  const dueDate = r['歸屬期'] ? normDate(r['歸屬期']) : null;
  if (r['歸屬期'] && !dueDate) errors.push(`${rowNo}：歸屬期格式錯`);
  return { id: pid, loanId, date, ...(dueDate ? { dueDate } : {}), amount };
}

// 匯入：驗證全部通過才整批取代，回傳 {ok, errors, state?}
// 舊 Excel 沒有救援表 → state 不帶 deletedRecords（呼叫端保留手機既有救援資料）
// 有救援表 → state.deletedRecords（呼叫端依借款 ID 與既有救援資料合併，不清空）
export function parseXlsx(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const errors = [];

  const loanSheet = wb.Sheets['借款主表'];
  if (!loanSheet) return { ok: false, errors: ['找不到「借款主表」工作表'] };

  const loans = XLSX.utils.sheet_to_json(loanSheet).map((r, i) => parseLoanRow(r, `借款主表第 ${i + 2} 列`, errors));

  // 重複編號檢查
  const seen = new Set();
  loans.forEach((l, i) => {
    if (seen.has(l.id)) errors.push(`借款主表第 ${i + 2} 列：編號「${l.id}」重複`);
    seen.add(l.id);
  });

  const ids = new Set(loans.map(l => l.id));
  const payIds = new Set();
  const payments = [];
  const paySheet = wb.Sheets['收款記錄'];
  if (paySheet) {
    XLSX.utils.sheet_to_json(paySheet).forEach((r, i) => {
      payments.push(parsePayRow(r, `收款記錄第 ${i + 2} 列`, errors, ids, payIds, '對不上主表'));
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

  // 系統救援表：封存借款過同一套借款規則；救援收款只能對應救援借款；封存 ID 不得再出現在借款主表（不得復活）
  let deletedRecords;
  const rlSheet = wb.Sheets['系統救援_借款'];
  if (rlSheet) {
    const byId = new Map();
    XLSX.utils.sheet_to_json(rlSheet).forEach((r, i) => {
      const rowNo = `系統救援_借款第 ${i + 2} 列`;
      const loan = parseLoanRow(r, rowNo, errors);
      const deletedAt = Number(r['刪除時間']);
      if (!(Number.isInteger(deletedAt) && deletedAt > 0)) errors.push(`${rowNo}：刪除時間無效`);
      const reason = String(r['封存原因'] || '').trim();
      if (!ARCHIVE_REASONS.includes(reason)) errors.push(`${rowNo}：封存原因「${reason}」看不懂`);
      if (byId.has(loan.id)) errors.push(`${rowNo}：編號「${loan.id}」重複`);
      if (ids.has(loan.id)) errors.push(`「${loan.name}」已結案刪除，不能透過一般匯入復活。`);
      byId.set(loan.id, { deletedAt, reason, loan, payments: [] });
    });
    const rpSheet = wb.Sheets['系統救援_收款'];
    if (rpSheet) {
      const rIds = new Set(byId.keys());
      XLSX.utils.sheet_to_json(rpSheet).forEach((r, i) => {
        const p = parsePayRow(r, `系統救援_收款第 ${i + 2} 列`, errors, rIds, payIds, '對不上系統救援_借款');
        if (byId.has(p.loanId)) byId.get(p.loanId).payments.push(p);
      });
    }
    deletedRecords = [...byId.values()];
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true, errors: [],
    state: {
      version: 1, loans, payments, lastExport: null,
      ...(tombstones.length ? { tombstones } : {}),
      ...(deletedRecords ? { deletedRecords } : {}),
    },
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
