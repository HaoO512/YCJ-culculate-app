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
  'back-normal', 'close-normal', 'settle-legal', 'delete-loan']) {
  assert.ok(js.includes(`'${a}'`), `寫入動作 ${a} 已納入鎖定`);
}
// 匯入鎖競爭：按鈕只開選擇器不佔鎖；選到檔案後鎖住解析與取代
{
  const wa = js.match(/WRITE_ACTIONS = new Set\(\[[\s\S]*?\]\)/)[0];
  assert.ok(!wa.includes('import-xlsx'), '開檔案選擇器不佔全域鎖');
  assert.ok(/await Promise\.all\(\[doImport\(f\), delay\(800\)\]\)/.test(js), '解析+取代全程鎖定至少800ms');
  assert.ok(js.includes('匯入時發生錯誤，原本資料沒有變動'), '匯入失敗有明確回饋');
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
assert.ok(/if \(!f \|\| actionBusy\) return;\s*\n[\s\S]{0,120}actionBusy = true;/.test(js), '選到檔案才上鎖，鎖住解析與取代');
assert.ok(!/font-size:1[3-6]px/.test(js), 'App 內補充文字不得小於 17px');
assert.ok(css.includes('.tab.active { color: var(--accent-deep); }'), '分頁選中用深橘');
assert.ok(css.includes('.seg button.active { background: var(--accent-deep)'), '切換鈕用深橘底');

// ── 結清流程：最終確認前不得動帳 ──
{
  const fn = js.slice(js.indexOf("async 'close-normal'"), js.indexOf("async 'delete-loan'"));
  const firstWrite = Math.min(
    ...['state.payments.push', 'l.writeoff', "l.status = 'closed'"]
      .map(s => { const i = fn.indexOf(s); return i < 0 ? Infinity : i; }));
  const finalOk = fn.indexOf('最終確認後');
  assert.ok(finalOk > 0 && firstWrite > finalOk, '結清：所有寫入都在最終確認之後');
  assert.ok(fn.includes('arrearsChoice'), '欠息選擇先記住、後執行');
}

// ── 補繳面板可捲動、按鈕固定 ──
assert.ok(css.includes('max-height: calc(100dvh'), '面板不超出螢幕');
assert.ok(css.includes('max-height: 50dvh; overflow-y: auto'), '期數區獨立捲動');
assert.ok(css.includes('.panel .p-btns { flex: none; }'), '按鈕列固定');

// ── 有閱讀意義的文字 ≥17px ──
for (const sel of ['.cal-week span { text-align: center; font-size: 17px',
  '.bar b { font-size: 17px', '.bar .amt { font-size: 17px',
  '.debt-note { font-size: 17px']) {
  assert.ok(css.includes(sel), `17px：${sel.slice(0, 20)}…`);
}
assert.ok(/\.tab \{[\s\S]{0,120}font-size: 17px/.test(css), '分頁文字 17px');

console.log('適老化與防誤觸規格全過');
