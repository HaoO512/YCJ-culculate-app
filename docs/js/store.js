// 資料層：localStorage 讀寫
const KEY = 'loanapp.v1';

export function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return emptyState();
  try {
    const s = JSON.parse(raw);
    if (!s || s.version !== 1 || !Array.isArray(s.loans)) throw new Error('bad shape');
    s.payments = Array.isArray(s.payments) ? s.payments : [];
    // 完整驗證（與雲端 Worker 同一套規則）：壞資料整份視為損壞，雲端與快照負責救援
    const dateOk = v => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      const [y, m, d] = v.split('-').map(Number);
      return m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();
    };
    const loanIds = new Set();
    for (const l of s.loans) {
      if (typeof l.id !== 'string' || !l.id || loanIds.has(l.id)) throw new Error('bad loan id');
      loanIds.add(l.id);
      if (typeof l.name !== 'string' || !l.name.trim()) throw new Error('bad name');
      if (!(Number.isFinite(l.principal) && l.principal > 0)) throw new Error('bad principal');
      if (!(Number.isFinite(l.rate) && l.rate > 0 && l.rate <= 20)) throw new Error('bad rate');
      if (!dateOk(l.startDate)) throw new Error('bad startDate');
      if (!(l.dueDay === 'EOM' || (Number.isInteger(l.dueDay) && l.dueDay >= 1 && l.dueDay <= 31))) throw new Error('bad dueDay');
      if (!['normal', 'overdue', 'legal', 'closed'].includes(l.status)) throw new Error('bad status');
      if ((l.status === 'overdue' || l.status === 'legal') && !dateOk(l.overdueSince)) throw new Error('bad overdueSince');
      if (l.overdueSince != null && dateOk(l.overdueSince) && l.overdueSince < l.startDate) throw new Error('overdueSince before start');
      if (l.closedDate != null && (!dateOk(l.closedDate) || l.closedDate < l.startDate)) throw new Error('bad closedDate');
      if (l.prepaidMonths != null && !(Number.isInteger(l.prepaidMonths) && l.prepaidMonths >= 0 && l.prepaidMonths <= 12)) throw new Error('bad prepaidMonths');
      const moneyOk = v => v == null || (Number.isFinite(v) && v >= 0);
      if (!moneyOk(l.referralFee) || !moneyOk(l.appraisalFee) || !moneyOk(l.finalReceived) || !moneyOk(l.writeoff)) throw new Error('bad fee');
    }
    if (s.tombstones != null) {
      if (!Array.isArray(s.tombstones) || s.tombstones.length > 100) throw new Error('bad tombstones');
      const tIds = new Set();
      for (const t of s.tombstones) {
        if (typeof t.id !== 'string' || !t.id || tIds.has(t.id) || typeof t.name !== 'string' ||
            !(t.dueDay === 'EOM' || (Number.isInteger(t.dueDay) && t.dueDay >= 1 && t.dueDay <= 31)) ||
            !dateOk(t.startDate)) throw new Error('bad tombstone');
        tIds.add(t.id);
      }
    }
    const payIds = new Set();
    for (const p of s.payments) {
      if (typeof p.id !== 'string' || !p.id || payIds.has(p.id)) throw new Error('bad payment id');
      payIds.add(p.id);
      if (!loanIds.has(p.loanId)) throw new Error('orphan payment');
      if (!dateOk(p.date) || !(Number.isFinite(p.amount) && p.amount > 0)) throw new Error('bad payment');
      if (p.dueDate != null && !dateOk(p.dueDate)) throw new Error('bad payment dueDate');
    }
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
