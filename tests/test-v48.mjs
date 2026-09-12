// v48：借款頁捲動修正（.plist 不被 flex 壓縮）＋一般清帳退役（只剩刪除）
// （v49 起刪除改為「結案刪除借款」並封存到 deletedRecords；本檔的刪除斷言已同步）
// 前半：來源層與純函式；後半：真實 Chrome/Edge headless 跑 App（tests/helpers/cdp.mjs，零依賴）
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  today, fmtDate, dueDateFor, monthlyInterest, monthReport, stats, migrateLegacyClosed,
} from '../docs/js/calc.js';
import { validateState } from '../worker/src/index.js';
import { launch, serveStatic } from './helpers/cdp.mjs';

const read = f => readFileSync(new URL('../docs/' + f, import.meta.url), 'utf8');
const js = read('js/app.js');
const css = read('css/app.css');
const storeSrc = read('js/store.js');
const workerSrc = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');

// ───────────────── 測試資料（相對今天產生，跨日不失效） ─────────────────
const now = today();
const Y = now.getFullYear(), M = now.getMonth();
const due = (k, day) => fmtDate(dueDateFor(Y, M + k, day));
const DEL_ID = 'del1', DEL_NAME = '彭琮翔';

function fixture() {
  const loans = [], payments = [];
  // 20 筆一般正常帳：名單必定超出一個螢幕
  for (let i = 1; i <= 20; i++) {
    const day = Math.min(1 + i, 28);
    loans.push({ id: 'n' + i, name: `借款人${String(i).padStart(2, '0')}`, principal: 100000 + i * 10000, rate: 2,
      startDate: due(-5, day), dueDay: day, status: 'normal', overdueSince: null, finalReceived: null, writeoff: null,
      prepaidMonths: 0, referralFee: 1000, note: '' });
    for (let k = -4; k <= -1; k++) {
      payments.push({ id: `n${i}p${k}`, loanId: 'n' + i, date: due(k, day), dueDate: due(k, day), amount: monthlyInterest(loans.at(-1)) });
    }
  }
  // 刪除目標：本金 65 萬、月息 13,000、三筆收款共 39,000
  loans.push({ id: DEL_ID, name: DEL_NAME, principal: 650000, rate: 2, startDate: due(-4, 10), dueDay: 10, status: 'normal',
    overdueSince: null, finalReceived: null, writeoff: null, prepaidMonths: 0, referralFee: 6500, note: '' });
  for (let k = -3; k <= -1; k++) payments.push({ id: `dp${k}`, loanId: DEL_ID, date: due(k, 10), dueDate: due(k, 10), amount: 13000 });
  // 漏收兩期以上（正常帳但沒記）
  loans.push({ id: 'miss1', name: '漏收甲', principal: 300000, rate: 2, startDate: due(-4, 10), dueDay: 10, status: 'normal',
    overdueSince: null, finalReceived: null, writeoff: null, prepaidMonths: 0, referralFee: 3000, note: '' });
  // 欠繳帳、法院帳
  loans.push({ id: 'ovd1', name: '欠繳乙', principal: 400000, rate: 2, startDate: due(-6, 10), dueDay: 10, status: 'overdue',
    overdueSince: due(-2, 10), finalReceived: null, writeoff: null, prepaidMonths: 0, referralFee: 4000, note: '' });
  loans.push({ id: 'leg1', name: '法院丙', principal: 500000, rate: 2, startDate: due(-8, 10), dueDay: 10, status: 'legal',
    overdueSince: due(-3, 10), finalReceived: null, writeoff: null, prepaidMonths: 0, referralFee: 5000, note: '' });
  // 舊結清資料：法院結案（有沖銷）＋舊版一般結清（無結清日）
  loans.push({ id: 'cls1', name: '結案丁', principal: 200000, rate: 2, startDate: due(-9, 10), dueDay: 10, status: 'closed',
    overdueSince: due(-5, 10), closedDate: due(-1, 10), finalReceived: 190000, writeoff: 22000, prepaidMonths: 0, referralFee: 2000, note: '' });
  loans.push({ id: 'cls0', name: '舊結清戊', principal: 150000, rate: 2, startDate: due(-12, 10), dueDay: 10, status: 'closed',
    overdueSince: null, finalReceived: null, writeoff: null, prepaidMonths: 0, referralFee: 1500, note: '' });
  payments.push({ id: 'cp1', loanId: 'cls0', date: due(-11, 10), dueDate: due(-11, 10), amount: 3000 });
  return { version: 1, loans, payments, lastExport: fmtDate(now), tombstones: [{ id: 'old-gone', name: '早已刪', dueDay: 5, startDate: '2024-01-05' }] };
}

// ───────────────── 一、來源層：一般清帳退役、捲動結構 ─────────────────
{
  // 6、7：close-normal 全面消失
  assert.ok(!js.includes('data-action="close-normal"'), 'app.js 不得再含 close-normal 按鈕');
  assert.ok(!js.includes("'close-normal'"), 'close-normal handler 與 WRITE_ACTIONS 皆已移除');
  const wa = js.match(/WRITE_ACTIONS = new Set\(\[[\s\S]*?\]\)/)[0];
  assert.ok(!wa.includes('close-normal') && wa.includes("'delete-loan'"), 'WRITE_ACTIONS：無 close-normal、有 delete-loan');
  for (const t of ['本金已還清', '確認結清？', '還有欠息沒處理', '欠息已收', '刪除錯帳', '只用於誤建']) {
    assert.ok(!js.includes(t), `一般清帳文案已退役：${t}`);
  }
  // 8：正常（漏收／一般）、欠繳、法院四種詳情各只有一顆「結案刪除借款」，且放在更多操作（v49：已結清不再是畫面狀態）
  const detail = js.slice(js.indexOf('function viewDetail'), js.indexOf('function viewForm'));
  const delBtns = detail.match(/data-action="delete-loan"[^>]*>結案刪除借款<\/button>/g) || [];
  assert.equal(delBtns.length, 4, '四種狀態各一顆結案刪除借款');
  assert.equal((detail.match(/data-action="delete-loan"/g) || []).length, 4, '沒有其他刪除入口');
  for (const seg of detail.split('more = `').slice(1)) {
    assert.ok(seg.slice(0, seg.indexOf('`;')).includes('data-action="delete-loan"'), '刪除借款只在「更多操作」內');
  }
  for (const seg of detail.split('primary = ')) {
    const body = seg.slice(0, seg.indexOf('more = `'));
    assert.ok(!body.includes('delete-loan'), '刪除借款不得成為主按鈕');
  }
  // 刪除面板文案
  for (const t of ['結案並刪除這筆借款？', '將移除 ${pays.length} 筆收款，共 ${money(total)}',
    'App、月報、總覽及一般 Excel 將不再顯示', '完整資料會保留供救援', "ok: '結案刪除借款', danger: true"]) {
    assert.ok(js.includes(t), `刪除面板：${t}`);
  }
  assert.ok(js.includes('toast(`「${l.name}」已結案刪除`)'), '刪除後短訊息');
  assert.ok(!js.includes('x.sub || x'), 'confirmPanel 不得用 x.sub 判斷字串（String.prototype.sub 會把姓名印成 function）');
  assert.ok(js.includes('if (!next) return;'), '確認後 archiveAndDeleteLoan 回 null 即不重複執行');
  // 法院結案流程維持（v49：結案後整筆封存移除）
  assert.ok(js.includes("'settle-legal'") && js.includes("'legal-settled'") && js.includes('壞帳沖銷 ${money(wo)}'), '法院結案仍在，改為封存');
  // closed 保留為相容層：本機、Worker、Excel 三處驗證都仍接受
  assert.ok(storeSrc.includes("['normal', 'overdue', 'legal', 'closed']"), 'store.js 仍接受 closed');
  assert.ok(workerSrc.includes("['normal', 'overdue', 'legal', 'closed']"), 'Worker 仍接受 closed');
  assert.ok(read('js/xlsx-io.js').includes("closed: '已結清'"), 'Excel 仍能往返 closed');
  assert.ok(!/loans = state\.loans\.filter\(l => l\.status !== 'closed'\)/.test(js), '不得自動清除舊 closed 資料');

  // 捲動結構（P0）
  const plist = css.match(/\.plist \{[^}]*\}/)[0];
  assert.ok(/flex:\s*none|flex-shrink:\s*0/.test(plist), '.plist 不得被 flex 壓縮');
  assert.ok(plist.includes('overflow: hidden'), '.plist 保留圓角裁切');
  const prow = css.match(/\.prow \{[^}]*\}/)[0];
  assert.ok(prow.includes('touch-action: pan-y'), '.prow 觸控可上下滑');
  const view = css.match(/#view \{[^}]*\}/)[0];
  assert.ok(view.includes('overflow-y: auto') && view.includes('min-height: 0') && view.includes('flex: 1'), '#view 仍是捲動殼');
  assert.ok(/#tabbar \{[^}]*position: static/.test(css), '底部導覽維持 static');
  assert.ok(css.includes('html, body { height: 100%; overflow: hidden; }'), 'body 不捲動');
}

// ───────────────── 二、純函式：舊 closed 資料仍通過本機、Worker、Excel 驗證 ─────────────────
const fx = fixture();
{
  // 14a：Worker
  assert.equal(validateState(structuredClone(fx)), null, 'Worker 驗證接受含舊 closed 的資料');
  // 14b：本機 store.load（墊 localStorage）
  const mem = new Map();
  globalThis.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const { load } = await import('../docs/js/store.js');
  mem.set('loanapp.v1', JSON.stringify(fx));
  const loaded = load();
  assert.equal(loaded.loans.length, fx.loans.length - 2, '本機驗證接受舊 closed（含無結清日），並遷移進封存');
  assert.equal((loaded.deletedRecords || []).length, 2, '兩筆舊 closed 進 deletedRecords');
  assert.ok(!mem.has('loanapp.v1.corrupt'), '未被判定為壞資料');
  // 14c：Excel 匯出 → 匯入
  const require = createRequire(import.meta.url);
  globalThis.XLSX = require('../docs/vendor/xlsx.full.min.js');
  const { exportXlsx, parseXlsx } = await import('../docs/js/xlsx-io.js');
  const dir = mkdtempSync(join(tmpdir(), 'v48-xlsx-'));
  let lastFile = null;
  XLSX.writeFile = (wb, name) => { lastFile = join(dir, name); writeFileSync(lastFile, Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))); };
  exportXlsx(structuredClone(fx));
  const r = parseXlsx(readFileSync(lastFile));
  assert.ok(r.ok, 'Excel 匯入驗證通過：' + (r.errors || []).join('；'));
  const back = r.state.loans.filter(l => l.status === 'closed');
  assert.equal(back.length, 2, '兩筆舊 closed 往返保留');
  assert.equal(back.find(l => l.id === 'cls1').writeoff, 22000, '壞帳沖銷往返保留');
  rmSync(dir, { recursive: true, force: true });
  // 15：法院結案／壞帳沖銷統計維持
  const st = stats(fx, now);
  assert.equal(st.writeoffTotal, 22000, '壞帳沖銷統計仍存在');
  assert.equal(st.problemCount, 2, '欠繳＋法院各一');
}

// ───────────────── 三、真實瀏覽器：捲動、觸控、刪除流程 ─────────────────
const srv = await serveStatic(fileURLToPath(new URL('../docs/', import.meta.url)));
const browser = await launch({ width: 375, height: 667 });
const page = browser.page;
let stateAfterDelete;
try {
  await page.goto(srv.url);
  // 植入資料後重開（等同手機重開 App）；舊結清提示一次性 flag 先設好，避免 alert 干擾手勢
  await page.eval(`localStorage.setItem('loanapp.v1', ${JSON.stringify(JSON.stringify(fx))}); localStorage.setItem('loanapp.closedNotice', '1');`);
  await page.reload();
  await page.click('.tab[data-view="people"]');
  await page.waitFor('.plist');

  const metrics = () => page.eval(`(() => {
    const v = document.getElementById('view'), p = document.querySelector('.plist'), t = document.getElementById('tabbar');
    const rows = [...p.querySelectorAll('.prow')];
    return {
      rows: rows.length, shrink: getComputedStyle(p).flexShrink,
      plistBox: p.getBoundingClientRect().height, plistContent: p.scrollHeight,
      rowsSum: rows.reduce((s, r) => s + r.getBoundingClientRect().height, 0),
      viewScroll: v.scrollHeight, viewClient: v.clientHeight, scrollTop: v.scrollTop,
      tabTop: t.getBoundingClientRect().top, tabBottom: t.getBoundingClientRect().bottom, inner: innerHeight,
      bodyScroll: document.scrollingElement.scrollTop,
    };
  })()`);

  // 1、2：名單依內容撐開、#view 可捲
  let m = await metrics();
  assert.equal(m.rows, 24, '進行中 24 筆（≥16）');
  assert.equal(m.shrink, '0', '.plist flex-shrink = 0');
  // scrollHeight 不含 1px 上下框線：外框只能比內容多 ≤3px，不得少（少＝被壓縮裁切）
  assert.ok(m.plistBox >= m.plistContent && m.plistBox - m.plistContent <= 3, `.plist 未被裁切（box ${m.plistBox} vs content ${m.plistContent}）`);
  assert.ok(m.plistBox >= m.rowsSum - 2, '名單高度 ≥ 全部列高總和');
  assert.ok(m.plistBox >= 24 * 96, '每列 ≥96px，24 列全數撐開');
  assert.ok(m.viewScroll > m.viewClient, `#view.scrollHeight(${m.viewScroll}) > clientHeight(${m.viewClient})`);
  assert.equal(m.bodyScroll, 0, 'body 不捲動');
  // 3：scrollTop 可設定
  const st1 = await page.eval(`(() => { const v = document.getElementById('view'); v.scrollTop = 600; return v.scrollTop; })()`);
  assert.ok(st1 >= 500, `scrollTop 設定後確實改變（${st1}）`);
  // 滑到底：底部導覽不動
  const tabBefore = m.tabTop;
  await page.eval(`document.getElementById('view').scrollTop = 1e6`);
  m = await metrics();
  assert.ok(m.scrollTop > 0 && Math.abs(m.scrollTop - (m.viewScroll - m.viewClient)) < 2, '可滑到最底');
  assert.equal(m.tabTop, tabBefore, '滑到底時底部導覽位置不變');
  assert.ok(m.tabBottom <= m.inner + 0.5, '底部導覽不超出畫面');

  // 4、5：三種寬度 × 從姓名／金額／狀態／圖示／列空白處起手拖動都能捲，且不誤開詳情
  for (const width of [320, 375, 430]) {
    await page.mobile(width, 667);
    await page.eval(`document.getElementById('view').scrollTop = 0`);
    const spots = await page.eval(`(() => {
      const row = document.querySelectorAll('.prow')[1];
      const c = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const rr = row.getBoundingClientRect();
      return {
        name: c(row.querySelector('.nm')), amt: c(row.querySelector('.right .amt')),
        stt: c(row.querySelector('.stt')), icon: c(row.querySelector('.picon')),
        blank: { x: rr.right - 8, y: rr.top + 6 },
      };
    })()`);
    for (const [k, pt] of Object.entries(spots)) {
      await page.eval(`document.getElementById('view').scrollTop = 0`);
      await page.touchScroll(pt.x, pt.y, 220);
      const r = await page.eval(`({ st: document.getElementById('view').scrollTop, people: !!document.querySelector('.plist'), detail: !!document.querySelector('.backrow') })`);
      assert.ok(r.st > 50, `${width}px 從「${k}」拖動可捲動（scrollTop=${r.st}）`);
      assert.ok(r.people && !r.detail, `${width}px 從「${k}」拖動不誤開詳情`);
    }
    // 快速甩動（3 步到位）＋慢速拖動（30 步、每步停 15ms）＋從名單列中央起手
    await page.eval(`document.getElementById('view').scrollTop = 0`);
    await page.touchScroll(width / 2, 400, 300, { steps: 3 });
    assert.ok(await page.eval(`document.getElementById('view').scrollTop`) > 50, `${width}px 快速甩動可捲`);
    await page.eval(`document.getElementById('view').scrollTop = 0`);
    await page.touchScroll(width / 2, 400, 120, { steps: 30, stepDelay: 15 });
    assert.ok(await page.eval(`document.getElementById('view').scrollTop`) > 30, `${width}px 慢速拖動可捲`);
    assert.ok(await page.eval(`!document.querySelector('.backrow')`), `${width}px 拖動後不誤開詳情`);
  }
  await page.mobile(375, 667);

  // v49：借款頁沒有分頁；切頁回頂
  assert.ok(await page.eval(`!document.querySelector('#view .seg')`), '借款頁無分段切換');
  await page.eval(`document.getElementById('view').scrollTop = 1e6`);
  await page.click('.tab[data-view="home"]');
  await page.click('.tab[data-view="people"]');
  assert.equal(await page.eval(`document.getElementById('view').scrollTop`), 0, '切頁回頂');

  // 8：四種進行中狀態詳情，更多操作只有一顆「結案刪除借款」
  const moreOf = async id => {
    await page.click('.tab[data-view="people"]');
    await page.click(`.prow[data-id="${id}"]`);
    await page.waitFor('.backrow');
    return page.eval(`(() => {
      const acc = [...document.querySelectorAll('details.acc')].find(d => d.querySelector('summary').textContent.includes('更多操作'));
      const body = acc.querySelector('.acc-body');
      return {
        del: [...body.querySelectorAll('[data-action="delete-loan"]')].map(b => b.textContent.trim()),
        closeNormal: document.querySelectorAll('[data-action="close-normal"]').length,
        text: document.getElementById('view').innerText,
        primaryDel: document.querySelectorAll('#view > [data-action="delete-loan"]').length,
      };
    })()`);
  };
  for (const id of [DEL_ID, 'miss1', 'ovd1', 'leg1']) {
    const r = await moreOf(id);
    assert.deepEqual(r.del, ['結案刪除借款'], `${id}：更多操作只有一顆結案刪除借款`);
    assert.equal(r.closeNormal, 0, `${id}：無本金已還清`);
    assert.equal(r.primaryDel, 0, `${id}：刪除不在主按鈕區`);
    assert.ok(!r.text.includes('本金已還清') && !r.text.includes('刪除錯帳'), `${id}：舊文案不出現`);
  }
  const missTxt = (await moreOf('miss1')).text;
  assert.ok(missTxt.includes('漏了') && missTxt.includes('期沒記'), 'miss1 走漏收兩期以上分支');

  // 11：取消刪除，state 完全不變
  await moreOf(DEL_ID);
  const before = await page.eval(`localStorage.getItem('loanapp.v1')`);
  await page.click('[data-action="delete-loan"]');
  await page.waitFor('.ov .panel');
  const panel = await page.eval(`(() => {
    const p = document.querySelector('.ov .panel');
    return { title: p.querySelector('.p-title').textContent, lines: [...p.querySelectorAll('.p-line')].map(x => x.textContent),
      ok: p.querySelector('[data-p="ok"]').textContent, okDanger: p.querySelector('[data-p="ok"]').classList.contains('pdanger'),
      no: p.querySelector('[data-p="no"]').textContent, focusNo: document.activeElement === p.querySelector('[data-p="no"]') };
  })()`);
  assert.equal(panel.title, '結案並刪除這筆借款？');
  assert.deepEqual(panel.lines, [DEL_NAME, '將移除 3 筆收款，共 $39,000', 'App、月報、總覽及一般 Excel 將不再顯示', '完整資料會保留供救援']);
  assert.equal(panel.ok, '結案刪除借款'); assert.ok(panel.okDanger, '結案刪除為紅色');
  assert.equal(panel.no, '取消'); assert.ok(panel.focusNo, '預設焦點在取消');
  // 面板期間再按一次刪除鈕：不得疊出第二個面板
  await page.eval(`document.querySelector('[data-action="delete-loan"]').click()`);
  assert.equal(await page.eval(`document.querySelectorAll('.ov').length`), 1, '面板開著時連點刪除鈕不疊面板');
  await page.click('.ov [data-p="no"]');
  await page.waitGone('.ov');
  assert.equal(await page.eval(`localStorage.getItem('loanapp.v1')`), before, '取消後 state 未寫入');
  assert.ok(await page.eval(`!!document.querySelector('.backrow')`), '取消後仍在詳情');
  assert.equal(page.dialogs.length, 0, '刪除流程不跳 alert');

  // 9、10、12：快速點兩次「確認刪除」只執行一次；借款與三筆收款消失、墓碑保留不重複
  await new Promise(r => setTimeout(r, 900));   // 等 800ms 寫入鎖釋放
  await page.click('[data-action="delete-loan"]');
  await page.waitFor('.ov .panel');
  await page.eval(`(() => { const b = document.querySelector('.ov [data-p="ok"]'); b.click(); b.click(); })()`);
  await page.waitGone('.ov');
  await page.waitFor('.toast');
  assert.equal(await page.eval(`document.querySelector('.toast').textContent`), `「${DEL_NAME}」已結案刪除`, '短訊息');
  assert.ok(await page.eval(`!!document.querySelector('.plist') && !document.querySelector('.backrow')`), '刪除後回借款頁');
  stateAfterDelete = JSON.parse(await page.eval(`localStorage.getItem('loanapp.v1')`));
  assert.equal(stateAfterDelete.loans.length, fx.loans.length - 3, '只刪一筆借款（另兩筆舊 closed 已於載入時封存）');
  assert.equal(stateAfterDelete.deletedRecords.filter(r => r.loan.id === DEL_ID).length, 1, '封存只有一份');
  assert.ok(!stateAfterDelete.loans.some(l => l.id === DEL_ID), '借款消失');
  assert.equal(stateAfterDelete.payments.filter(p => p.loanId === DEL_ID).length, 0, '三筆收款全數消失');
  assert.equal(stateAfterDelete.payments.length, fx.payments.length - 3 - 1, '其他收款不受影響（-1 為舊 closed 戊的收款隨遷移封存）');
  assert.deepEqual(stateAfterDelete.tombstones.filter(t => t.id === DEL_ID),
    [{ id: DEL_ID, name: DEL_NAME, dueDay: 10, startDate: due(-4, 10) }], '墓碑保留且不重複');
  assert.equal(stateAfterDelete.tombstones.length, 4, '原有墓碑保留（＋兩筆舊 closed 遷移的墓碑）');
  assert.ok(!stateAfterDelete.loans.some(l => l.writeoff), '刪除不產生壞帳沖銷');
  assert.equal(await page.eval(`document.querySelectorAll('.prow').length`), 23, '名單少一筆');
  assert.equal(page.dialogs.length, 0, '刪除全程不跳 alert');

  // 重開 App 仍維持刪除結果（雲端連不上，本機為準）
  await page.reload();
  await page.click('.tab[data-view="people"]');
  await page.waitFor('.plist');
  assert.equal(await page.eval(`document.querySelectorAll('.prow').length`), 23, '重開後仍是 23 筆');
  assert.ok(!(await page.eval(`document.getElementById('view').innerText`)).includes(DEL_NAME), '重開後名單無該帳');

  // 13：月報與總覽畫面不再包含該帳
  await page.click('.tab[data-view="stats"]');
  await page.click('[data-action="stats-prev"]');
  assert.ok(!(await page.eval(`document.getElementById('view').innerText`)).includes(DEL_NAME), '上月月報不含該帳');
  await page.click('[data-action="stats-tab"][data-tab="overview"]');
  const ov = await page.eval(`document.getElementById('view').innerText`);
  assert.ok(!ov.includes(DEL_NAME), '總覽不含該帳');
  await page.click('.tab[data-view="people"]');
  await page.waitFor('.plist');
  assert.equal(await page.eval(`document.getElementById('view').scrollTop`), 0, '切頁回頂');
} finally {
  await browser.close();
  await srv.close();
}

// 13（數值層）：刪除後月報、總覽、Excel 都不再包含該帳
{
  const s = stateAfterDelete;
  const d = dueDateFor(Y, M - 1, 10);
  const rp = monthReport(s, d.getFullYear(), d.getMonth(), now);
  assert.ok(!rp.payList.some(p => p.loanId === DEL_ID), '上月收款記錄無該帳');
  assert.ok(![...rp.unpaidRows, ...rp.notYetRows].some(r => r.loan.id === DEL_ID), '上月到期列無該帳');
  // 對照組：同一份資料先經 v49 遷移（舊 closed 已封存），只比較這次結案刪除的差額
  const st0 = stats(migrateLegacyClosed(fx).state, now), st1 = stats(s, now);
  assert.equal(st1.received, st0.received - 39000, '總覽已收利息扣掉 39,000');
  assert.equal(st1.principalOut, st0.principalOut - 650000, '總覽本金扣掉 650,000');
  assert.equal(st1.referralTotal, st0.referralTotal - 6500, '介紹費隨帳消失');
  const dir = mkdtempSync(join(tmpdir(), 'v48-xlsx2-'));
  let lastFile = null;
  XLSX.writeFile = (wb, name) => { lastFile = join(dir, name); writeFileSync(lastFile, Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))); };
  const { exportXlsx, parseXlsx } = await import('../docs/js/xlsx-io.js');
  exportXlsx(structuredClone(s));
  const buf = readFileSync(lastFile);
  const wb = XLSX.read(buf, { type: 'buffer' });
  for (const sheet of ['借款主表', '問題帳目', '收款記錄']) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheet]);
    assert.ok(!csv.includes(DEL_NAME) && !csv.includes(DEL_ID), `Excel「${sheet}」不含該帳`);
  }
  const r = parseXlsx(buf);
  assert.ok(r.ok, 'Excel 匯入驗證通過');
  assert.ok(r.state.tombstones.some(t => t.id === DEL_ID), '墓碑隨 Excel 往返');
  assert.equal(validateState(structuredClone(s)), null, '刪除後資料通過 Worker 驗證（可正常同步）');
  rmSync(dir, { recursive: true, force: true });
}

console.log('v48 捲動修正＋一般清帳退役全過');
