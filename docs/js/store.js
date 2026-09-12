// 資料層：localStorage 讀寫
import { migrateLegacyClosed, ARCHIVE_REASONS } from './calc.js';

const KEY = 'loanapp.v1';

const dateOk = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();
};
const dueDayOk = d => d === 'EOM' || (Number.isInteger(d) && d >= 1 && d <= 31);
const moneyOk = v => v == null || (Number.isFinite(v) && v >= 0);

// 單筆借款規則（正式區與封存區共用；與雲端 Worker 同一套）
// closed 仍是合法狀態：舊資料與封存區都會用到，收到先接受、再由遷移搬走
function checkLoan(l) {
  if (typeof l.name !== 'string' || !l.name.trim()) throw new Error('bad name');
  if (!(Number.isFinite(l.principal) && l.principal > 0)) throw new Error('bad principal');
  if (!(Number.isFinite(l.rate) && l.rate > 0 && l.rate <= 20)) throw new Error('bad rate');
  if (!dateOk(l.startDate)) throw new Error('bad startDate');
  if (!dueDayOk(l.dueDay)) throw new Error('bad dueDay');
  if (!['normal', 'overdue', 'legal', 'closed'].includes(l.status)) throw new Error('bad status');
  if ((l.status === 'overdue' || l.status === 'legal') && !dateOk(l.overdueSince)) throw new Error('bad overdueSince');
  if (l.overdueSince != null && dateOk(l.overdueSince) && l.overdueSince < l.startDate) throw new Error('overdueSince before start');
  if (l.closedDate != null && (!dateOk(l.closedDate) || l.closedDate < l.startDate)) throw new Error('bad closedDate');
  if (l.prepaidMonths != null && !(Number.isInteger(l.prepaidMonths) && l.prepaidMonths >= 0 && l.prepaidMonths <= 12)) throw new Error('bad prepaidMonths');
  // 代書費已退役：舊資料的 appraisalFee 直接忽略，不驗證、不判損壞
  if (!moneyOk(l.referralFee) || !moneyOk(l.finalReceived) || !moneyOk(l.writeoff)) throw new Error('bad fee');
}

function checkPayment(p, loanIds, payIds) {
  if (typeof p.id !== 'string' || !p.id || payIds.has(p.id)) throw new Error('bad payment id');
  payIds.add(p.id);
  if (!loanIds.has(p.loanId)) throw new Error('orphan payment');
  if (!dateOk(p.date) || !(Number.isFinite(p.amount) && p.amount > 0)) throw new Error('bad payment');
  if (p.dueDate != null && !dateOk(p.dueDate)) throw new Error('bad payment dueDate');
}

// 完整驗證（與雲端 Worker 同一套規則）：壞資料整份視為損壞，雲端與快照負責救援
export function validateState(s) {
  const loanIds = new Set();
  for (const l of s.loans) {
    if (typeof l.id !== 'string' || !l.id || loanIds.has(l.id)) throw new Error('bad loan id');
    loanIds.add(l.id);
    checkLoan(l);
  }
  if (s.tombstones != null) {
    if (!Array.isArray(s.tombstones) || s.tombstones.length > 100) throw new Error('bad tombstones');
    const tIds = new Set();
    for (const t of s.tombstones) {
      if (typeof t.id !== 'string' || !t.id || tIds.has(t.id) || typeof t.name !== 'string' ||
          !dueDayOk(t.dueDay) || !dateOk(t.startDate)) throw new Error('bad tombstone');
      tIds.add(t.id);
    }
  }
  const payIds = new Set();
  for (const p of s.payments) checkPayment(p, loanIds, payIds);
  // 救援封存：每筆借款過同一套規則；正式區與封存區借款 ID 不得重複、收款 ID 全域不得重複
  if (s.deletedRecords != null) {
    if (!Array.isArray(s.deletedRecords)) throw new Error('bad deletedRecords');
    const aIds = new Set();
    for (const r of s.deletedRecords) {
      if (!r || typeof r !== 'object' || !r.loan || typeof r.loan !== 'object') throw new Error('bad record');
      if (!(Number.isInteger(r.deletedAt) && r.deletedAt > 0)) throw new Error('bad deletedAt');
      if (!ARCHIVE_REASONS.includes(r.reason)) throw new Error('bad reason');
      const l = r.loan;
      if (typeof l.id !== 'string' || !l.id || aIds.has(l.id) || loanIds.has(l.id)) throw new Error('bad archived loan id');
      aIds.add(l.id);
      checkLoan(l);
      if (!Array.isArray(r.payments)) throw new Error('bad archived payments');
      const own = new Set([l.id]);
      for (const p of r.payments) checkPayment(p, own, payIds);
    }
  }
}

// 遷移前的最低結構要求：deletedRecords 若存在必須是「每筆都有 loan.id」的陣列，否則整份視為損壞
function preShape(s) {
  if (s.deletedRecords == null) return;
  if (!Array.isArray(s.deletedRecords)) throw new Error('bad deletedRecords');
  for (const r of s.deletedRecords) {
    if (!r || typeof r !== 'object' || !r.loan || typeof r.loan !== 'object' || typeof r.loan.id !== 'string') throw new Error('bad record');
  }
}

export function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return emptyState();
  try {
    let s = JSON.parse(raw);
    if (!s || s.version !== 1 || !Array.isArray(s.loans)) throw new Error('bad shape');
    s.payments = Array.isArray(s.payments) ? s.payments : [];
    // v49 遷移先於完整驗證：舊 closed、正式／封存同 ID 都在這裡處理掉，舊資料不能被判成損壞
    preShape(s);
    const m = migrateLegacyClosed(s);
    s = m.state;
    validateState(s);
    if (m.changed) save(s, false);   // 遷移完成只儲存一次；不動 updatedAt，不搶雲端新舊判斷
    return s;
  } catch {
    // 壞資料先留副本再重來，不無聲蒸發（雲端與快照仍是主要救援）
    try { localStorage.setItem(KEY + '.corrupt', raw); } catch {}
    return emptyState();
  }
}

export function save(state, touch = true) {
  if (touch) state.updatedAt = Date.now();
  localStorage.setItem(KEY, JSON.stringify(state));
  if (touch && typeof save.onSave === 'function') save.onSave();
}

export function emptyState() {
  return { version: 1, loans: [], payments: [], lastExport: null };
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
