// 資料層：localStorage 讀寫
const KEY = 'loanapp.v1';

export function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return emptyState();
  try {
    const s = JSON.parse(raw);
    if (!s || s.version !== 1 || !Array.isArray(s.loans)) throw new Error('bad shape');
    s.payments = Array.isArray(s.payments) ? s.payments : [];
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
