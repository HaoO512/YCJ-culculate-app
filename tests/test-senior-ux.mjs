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

// ── 七、適老顯示標準（v39 字級分工：按鈕 20/700，觸控高度不變）──
assert.ok(css.includes('min-height: 68px'), '主要按鈕高度 ≥68px');
assert.ok(/\.btn \{[\s\S]{0,200}font-size: 20px; font-weight: 700/.test(css), '按鈕 20px/700');
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
  '.debt-note { font-size: 17px',
  '.chip { display: inline-flex; align-items: center; font-size: 17px']) {
  assert.ok(css.includes(sel), `17px：${sel.slice(0, 20)}…`);
}
assert.ok(/\.tab \{[\s\S]{0,120}font-size: 17px/.test(css), '分頁文字 17px');

// ── 近7個月改橫向列：窄機金額不重疊 ──
assert.ok(!css.includes('.bars {'), '直條圖樣式已移除');
assert.ok(js.includes('（本月）') && /近 7 個月實收利息[\s\S]{0,80}hbars/.test(js), '圖表改橫向 hbar 列');

// ── 行事曆全面手動化（v39）──
assert.equal((js.match(/downloadICS\(/g) || []).length, 1, 'downloadICS 只存在於 ics-all');
assert.ok(!js.includes('downloadStopICS('), '單筆自動停止檔已移除');
assert.equal((js.match(/downloadStopAllICS\(/g) || []).length, 1, '合併停止檔只在 ics-stop-all');
for (const bad of ['行事曆檔已下載', '行事曆檔已自動下載', '停止提醒」檔', '提醒接回',
  '記得加到行事曆', '點開按「加入」', 'remindChanged']) {
  assert.ok(!js.includes(bad), `不得再出現：${bad}`);
}
assert.ok(js.includes("'儲存借款'"), '新增按鈕改「儲存借款」');
assert.ok(js.includes("'ics-stop-all'") && js.includes('行事曆（選用）'), '設定頁手動行事曆區');
assert.ok(js.includes('已標記欠繳，欠息從'), '狀態操作只留帳務訊息');

// ── 借款頁名單化與設定頁列表化（v39）──
assert.ok(js.includes("'people-tab'") && js.includes('進行中 ${running.length}'), '借款頁分段切換');
assert.ok(css.includes('.plist { padding: 0;') && css.includes('.prow + .prow'), '名單容器＋分隔線');
assert.ok(css.includes('.prow .nm { font-size: 21px; font-weight: 700') &&
  css.includes('.prow .right .amt { font-size: 24px; font-weight: 800'), '姓名21/金額24字級分工');
assert.ok(js.includes("route.view === 'settings' ? 'none'"), '設定頁隱藏底部導覽');
assert.ok(js.includes('立即傳送一則測試'), '測試通知改設定列雙行文案');

console.log('適老化與防誤觸規格全過');

// ── v40：墓碑清單、名單小字17、SVG 圖示 ──
{
  assert.ok(js.includes('state.tombstones'), '刪帳留墓碑供停止檔用');
  assert.ok(/downloadStopAllICS\(all\)/.test(js) && js.includes('...(state.tombstones || [])'), '停止檔含已刪帳');
  assert.ok(js.includes('請到行事曆手動刪除'), '更早刪帳的限制有告知');
  assert.ok(css.includes('.prow .stt { font-size: 17px'), '狀態文字 17px');
  assert.ok(css.includes('.prow .right .sub { font-size: 17px'), '每月利息標籤 17px');
  assert.ok(js.includes('const SIC = {') && !/[☀-➿\u{1F300}-\u{1FAFF}]/u.test(js.match(/const SIC[\s\S]*?};/)[0].replace(/[^ -~一-鿿]/gu, s => s)), 'SVG 圖示集存在');
  assert.ok(js.includes('${SIC.cloud}') && js.includes('${SIC.box}'), '設定頁改用 SVG 圖示');
}
