// v34 適老化與防誤觸交辦規格 —— 來源層驗收
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL('../docs/' + f, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('css/app.css');
const js = read('js/app.js');

// ── 五、關閉縮放與手勢 ──
assert.ok(html.includes('user-scalable=no'), '禁止手勢縮放');
assert.ok(html.includes('maximum-scale=1'), '禁止放大');
assert.ok(css.includes('touch-action: manipulation'), '互動區關雙擊縮放、保留捲動');

// ── 五、防連點 ──
assert.ok(js.includes('WRITE_ACTIONS'), '寫入動作清單存在');
assert.ok(js.includes('actionBusy'), '全域鎖存在');
assert.ok(js.includes('處理中…'), '處理期間顯示處理中');
assert.ok(js.includes('delay(800)'), '至少鎖 800ms');
for (const a of ['save-form', 'receive', 'receive-missed', 'del-payment', 'mark-overdue',
  'back-normal', 'close-normal', 'settle-legal', 'delete-loan', 'import-xlsx']) {
  assert.ok(js.includes(`'${a}'`), `寫入動作 ${a} 已納入鎖定`);
}

// ── 六、確認面板 ──
assert.ok(js.includes('function confirmPanel'), '自製確認面板');
assert.ok(js.includes(`querySelector('[data-p="no"]').focus()`), '預設焦點在取消');
assert.ok(js.includes('pdanger'), '危險動作紅色樣式');
assert.ok(!/[^.\w]confirm\(/.test(js.replace(/confirmPanel/g, 'CP')), '系統 confirm 已全數移除');
for (const t of ['記下本月收款？', '刪除錯帳？', '確認結清？', '進入法院？', '刪除收款']) {
  assert.ok(js.includes(t), `確認面板文案：${t}`);
}

// ── 二、按鈕短文案：新有、舊無 ──
for (const t of ['記本月收款', '記補繳（', '標記欠繳', '更正借款資料', '本金已還清',
  '刪除錯帳', '退回欠繳', '撤銷結清', '改基本資料']) {
  assert.ok(js.includes(t), `新文案：${t}`);
}
for (const t of ['收到補繳，記', '沒收到錢，標記欠繳', '結清還本</button>', '刪除誤建資料',
  '撤銷法院狀態', '修改姓名／費用／備註', '>改</button>', '>✕</button>']) {
  assert.ok(!js.includes(t), `舊文案已移除：${t}`);
}
assert.ok(js.includes('>更正</button>') && js.includes('>刪除</button>'), '收款列改「更正／刪除」文字鈕');

// ── 四、收款更正單一頁面 ──
assert.ok(js.includes('function viewPayEdit'), '更正收款獨立頁');
assert.ok(js.includes('pe-date') && js.includes('pe-due') && js.includes('pe-amount'), '三欄位一次呈現');
assert.ok(js.includes("'payedit-save'"), '儲存更正動作');
assert.ok(js.includes('確認更正這筆收款？'), '儲存前摘要確認');

// ── 七、適老顯示標準 ──
assert.ok(css.includes('min-height: 68px'), '主要按鈕高度 ≥68px');
assert.ok(css.includes('font-size: 22px; font-weight: 800'), '主要按鈕 22px 粗體');
assert.ok(css.includes('min-width: 48px; min-height: 48px'), '小按鈕 ≥48×48');
assert.ok(css.includes('--sub: #66594A'), '說明文字加深');
assert.ok(/\.field label \{ font-size: 19px/.test(css), '表單標籤 ≥19px');

// ── 回交批次：欠息處理、勾選補繳、結案摘要、匯入鎖、對比 ──
assert.ok(js.includes('還有欠息沒處理'), '欠繳結清先處理欠息');
assert.ok(js.includes('欠息已收') && js.includes('壞帳沖銷'), '欠息二選一');
assert.ok(js.includes('function pickPanel'), '補繳期數可勾選');
assert.ok(js.includes('確認結案？') && js.includes('壞帳沖銷 '), '結案前應收/實收/沖銷摘要');
assert.ok(js.includes('async function doImport'), '匯入拆出可鎖定函數');
assert.ok(/if \(actionBusy\) return;\s*\n\s*actionBusy = true;\s*\n\s*try \{\s*\n\s*await doImport/.test(js), '匯入解析與取代納入全域鎖');
assert.ok(!/font-size:1[3-6]px/.test(js), 'App 內補充文字不得小於 17px');
assert.ok(css.includes('.tab.active { color: var(--accent-deep); }'), '分頁選中用深橘');
assert.ok(css.includes('.seg button.active { background: var(--accent-deep)'), '切換鈕用深橘底');

console.log('適老化與防誤觸規格全過');
