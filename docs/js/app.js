// 借貸管家 — 主程式（畫面渲染 + 操作）
import { load, save, newId } from './store.js';
import {
  parseDate, fmtDate, today, monthlyInterest, defaultReferral, DEFAULT_APPRAISAL,
  dueDateFor, nextDue, overduePeriods, overdueInterest, paidInMonth, monthPaidAmount,
  prepaidUntil, settledInMonth, nextCollectDue,
  isActive, isProblem, stats, monthlySeries, monthReport, money,
  upcomingDues, missedDues, missedPeriods,
} from './calc.js';
import { downloadICS, downloadStopICS } from './ics.js';
import { exportXlsx, parseXlsx } from './xlsx-io.js';
import * as cloud from './cloud.js';

let state = load();
let route = { view: 'home' };          // home | people | detail | form | problems | stats | settings
let statsTab = 'month';                // month | overview
let calCursor = null;                  // {y, m} 月曆目前顯示的月份
let calSelected = null;                // 點選的日子（數字）
let statsCursor = null;                // {y, m} 月報目前顯示的月份

const $view = document.getElementById('view');
const $tabbar = document.getElementById('tabbar');
const $importFile = document.getElementById('import-file');

const STATUS_TXT = { normal: '正常', overdue: '欠繳', legal: '法院處理中', closed: '已結清' };
const STATUS_CHIP = { normal: 'ok', overdue: 'bad', legal: 'bad', closed: 'done' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const TAB_VIEWS = ['home', 'people', 'problems', 'stats'];
let lastTab = 'home';                       // 詳情/表單/設定時，底部仍亮來源分頁
const navFrom = { settings: 'home', detail: 'home', form: 'people' };

function go(view, params = {}) {
  if (view === 'settings' && route.view !== 'settings') navFrom.settings = route.view;
  if (view === 'detail' && TAB_VIEWS.includes(route.view)) navFrom.detail = route.view;
  if (view === 'form' && !params.id) navFrom.form = TAB_VIEWS.includes(route.view) ? route.view : 'people';
  if (TAB_VIEWS.includes(view)) lastTab = view;
  route = { view, ...params };
  render();
  window.scrollTo(0, 0);
}

function commit() {
  save(state);
  render();
}

function loanById(id) { return state.loans.find(l => l.id === id); }

function dueDayTxt(d) { return d === 'EOM' ? '月底' : `${d} 號`; }

function mdTxt(d) { return `${d.getMonth() + 1}月${d.getDate()}日`; }

// 大字確認面板（取代系統 confirm）：預設焦點在「取消」，危險動作紅色
function confirmPanel({ title, lines = [], ok = '確定', danger = false }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'ov';
    ov.innerHTML = `
      <div class="panel" role="alertdialog" aria-label="${esc(title)}">
        <p class="p-title">${esc(title)}</p>
        ${lines.map(x => `<p class="p-line${x.sub ? ' sub' : ''}">${esc(x.sub || x)}</p>`).join('')}
        <div class="p-btns">
          <button class="btn outline-grey" data-p="no">取消</button>
          <button class="btn ${danger ? 'pdanger' : 'green'}" data-p="ok">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('[data-p="no"]').focus();
    ov.addEventListener('click', e => {
      const b = e.target.closest('[data-p]');
      if (!b && e.target !== ov) return;
      ov.remove();
      resolve(b ? b.dataset.p === 'ok' : false);
    });
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// 收款若歸屬到別的月份（補繳），列出「補X/X期」標記
function periodTag(p) {
  if (!p.dueDate) return '';
  const a = parseDate(p.dueDate), b = parseDate(p.date);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return '';
  return `<span style="font-size:14px;color:var(--sub);font-weight:700">補${a.getMonth() + 1}/${a.getDate()}期</span>`;
}

// ───────────────────────── 首頁 ─────────────────────────

function viewHome() {
  const now = today();
  if (!calCursor) calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = calCursor;
  const active = state.loans.filter(isActive);

  const head = `<div class="title-row"><h1 class="title">今天 ${mdTxt(now)}</h1>${gearBtn()}</div>`;
  if (!active.length && !state.loans.length) {
    return head + '<div class="empty">還沒有借款記錄。<br><br>到「借款」分頁按「＋ 新增」加第一筆。</div>';
  }

  // 本月每筆的收息資訊；借款日之前、預收涵蓋的月份整個跳過（沒事要做，不畫點不列行）
  const dues = active.flatMap(l => {
    const d = dueDateFor(y, m, l.dueDay);
    if (d < parseDate(l.startDate)) return [];
    // 欠繳只從停繳日起算紅點；之前的月份當一般月份處理
    const problem = isProblem(l) && (!l.overdueSince || d >= parseDate(l.overdueSince));
    if (!problem) {
      const pu = prepaidUntil(l);
      if (pu && d <= pu) return [];
    }
    return [{
      loan: l, day: d.getDate(),
      paid: settledInMonth(state.payments, l, y, m),
      problem,
    }];
  }).sort((a, b) => a.day - b.day);

  // 月曆格
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const isThisMonth = y === now.getFullYear() && m === now.getMonth();
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<span class="day"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dotsHere = dues.filter(x => x.day === d);
    const dots = dotsHere.length
      ? `<span class="dots">${dotsHere.slice(0, 3).map(x => `<i class="dot ${x.problem ? 'r' : 'g'}"></i>`).join('')}${dotsHere.length > 3 ? `<i class="dotmore">+${dotsHere.length - 3}</i>` : ''}</span>`
      : '';
    const cls = ['day'];
    if (isThisMonth && d === now.getDate()) cls.push('today');
    if (calSelected === d) cls.push('sel');
    cells += `<button class="${cls.join(' ')}" data-action="pick-day" data-day="${d}">${d}${dots}</button>`;
  }

  // 下方清單：只列「要行動的」——點了日子看當天；否則只看漏收的＋接下來 3 筆
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const rowOf = x => {
    const l = x.loan;
    const isToday = isThisMonth && !x.paid && x.day === now.getDate();
    const isTomorrow = isThisMonth && !x.paid && !x.problem &&
      x.day === tomorrow.getDate() && m === tomorrow.getMonth();
    const cls = x.problem ? 'slim alert' : (isToday || isTomorrow ? 'slim notice' : 'slim');
    const paidMark = x.paid ? '<span class="paid">✓</span>' : '';
    const label = x.problem ? '欠繳' : (isToday ? '今天' : (isTomorrow ? '明天' : ''));
    return `
      <button class="${cls}" data-action="open-loan" data-id="${l.id}">
        <span class="l"><small>${x.day}日${label ? '·' + label : ''}</small>${esc(l.name)}${paidMark}</span>
        <span class="r">${money(x.problem ? overdueInterest(l, now, state.payments) : monthlyInterest(l))}</span>
      </button>`;
  };

  // 待辦：欠繳摘要 → 跨月漏收（直到記收款或標欠繳才消失）→ 跨月最近 3 筆
  const probs = state.loans.filter(isProblem);
  let todoHtml = '';
  if (probs.length) {
    const maxDays = Math.max(...probs.map(l => Math.floor((now - parseDate(l.overdueSince || l.startDate)) / 86400000)));
    todoHtml += `
      <button class="slim alert" data-action="go" data-view="problems">
        <span class="l">欠繳 ${probs.length} 筆，最久 ${maxDays} 天</span>
        <span class="r" style="font-size:18px">去處理 ›</span>
      </button>`;
  }
  const missed = missedDues(state, now);
  const coming = upcomingDues(state, now, 3, new Set(missed.map(x => x.loan.id)));
  const relTxt = d => {
    const diff = Math.round((d - now) / 86400000);
    return diff === 0 ? '今天' : diff === 1 ? '明天' : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  if (missed.length) {
    todoHtml += `<p class="section-h" style="color:var(--red)">漏收的</p>
      <div class="rowlist">${missed.map(x => `
        <button class="slim alert" data-action="open-loan" data-id="${x.loan.id}">
          <span class="l"><small>${x.first.getMonth() + 1}/${x.first.getDate()} 起${x.count > 1 ? '·' + x.count + '期' : ''}</small>${esc(x.loan.name)}</span>
          <span class="r">${money(x.amount)}</span>
        </button>`).join('')}</div>`;
  }
  if (coming.length) {
    todoHtml += `<p class="section-h">接下來</p>
      <div class="rowlist">${coming.map(x => {
        const rel = relTxt(x.date);
        const hot = rel === '今天' || rel === '明天';
        return `
        <button class="slim${hot ? ' notice' : ''}" data-action="open-loan" data-id="${x.loan.id}">
          <span class="l"><small>${rel}</small>${esc(x.loan.name)}</span>
          <span class="r">${money(monthlyInterest(x.loan))}</span>
        </button>`;
      }).join('')}</div>`;
  }
  if (!probs.length && !missed.length && !coming.length) {
    todoHtml = '<div class="empty" style="padding:20px 10px">今天沒有新的收息 ✓</div>';
  }

  // 點了日子 → 當天名單（放月曆下面）
  let dayHtml = '';
  if (calSelected) {
    const dayList = dues.filter(x => x.day === calSelected);
    dayHtml = `<p class="section-h">${m + 1}月${calSelected}日</p>
      <div class="rowlist">${dayList.map(rowOf).join('') || '<div class="empty" style="padding:14px">這天沒有要收的錢</div>'}</div>`;
  }

  return `
    ${head}
    ${todoHtml}
    <div class="card cal">
      <div class="cal-month-row">
        <span class="cal-month" data-action="cal-today">${y} · ${m + 1}月</span>
        <div class="cal-nav">
          <button data-action="cal-prev" aria-label="上個月">‹</button>
          <button data-action="cal-next" aria-label="下個月">›</button>
        </div>
      </div>
      <div class="cal-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
      <div class="cal-grid">${cells}</div>
    </div>
    ${dayHtml}
  `;
}

// ───────────────────────── 借款人列表 ─────────────────────────

function viewPeople() {
  const order = { overdue: 0, legal: 0, normal: 1 };
  const running = state.loans.filter(isActive).sort((a, b) =>
    (order[a.status] - order[b.status]) || a.name.localeCompare(b.name, 'zh-Hant'));
  const closed = state.loans.filter(l => l.status === 'closed')
    .sort((a, b) => (b.closedDate || '').localeCompare(a.closedDate || ''));

  const rowOf = l => {
    const right = l.status === 'closed'
      ? (l.closedDate
          ? `結清 ${(d => d.getMonth() + 1 + '/' + d.getDate())(parseDate(l.closedDate))}`
          : '結清日未填')
      : money(monthlyInterest(l));
    return `
    <button class="person-row" data-action="open-loan" data-id="${l.id}">
      <span class="name">${esc(l.name)}</span>
      <span class="chip ${STATUS_CHIP[l.status]}">${STATUS_TXT[l.status]}</span>
      <span class="money" ${l.status === 'closed' ? 'style="font-size:17px;color:var(--sub)"' : ''}>${right}</span>
    </button>`;
  };

  return `
    <div class="title-row"><h1 class="title">借款（進行中 ${running.length}）</h1>
      <span style="display:flex;gap:8px;align-items:center">
        <button class="addbtn" data-action="go" data-view="form">＋ 新增</button>${gearBtn()}
      </span></div>
    <div class="rowlist">${running.map(rowOf).join('') || '<div class="empty">還沒有借款記錄，按上面「＋ 新增」</div>'}</div>
    ${closed.length ? `
      <details class="acc"><summary>已結清（${closed.length}）</summary><div class="acc-body">
        <div class="rowlist">${closed.map(rowOf).join('')}</div>
      </div></details>` : ''}`;
}

// ───────────────────────── 借款人詳情 ─────────────────────────

function viewDetail() {
  const l = loanById(route.id);
  if (!l) return '<div class="empty">找不到這筆借款</div>';
  const now = today();
  const mi = monthlyInterest(l);
  const next = nextCollectDue(l, now);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const nextTxt = next.getTime() === now.getTime() ? '就是今天'
    : next.getTime() === tomorrow.getTime() ? `明天 ${mdTxt(next)}` : mdTxt(next);
  const paidReal = paidInMonth(state.payments, l.id, now.getFullYear(), now.getMonth());
  const paid = settledInMonth(state.payments, l, now.getFullYear(), now.getMonth());
  const byPrepaid = paid && !paidReal;
  const pu = prepaidUntil(l);

  const pays = state.payments.filter(p => p.loanId === l.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const payRows = pays.map(p => `
    <div class="h-row">
      <span>${mdTxt(parseDate(p.date))}</span>
      ${periodTag(p)}
      <span class="amount">${money(p.amount)}</span>
      <span class="ok-mark">✓</span>
      <button class="del" data-action="edit-payment" data-id="${p.id}" style="color:var(--accent)">更正</button>
      <button class="del" data-action="del-payment" data-id="${p.id}" style="color:var(--red)">刪除</button>
    </div>`).join('');

  // 主要動作與「更多」分開：日常只看一顆按鈕
  let primary = '';
  let more = '';
  if (l.status === 'normal') {
    // 有漏收的期：主要動作變成「記補繳」，符合追款流程
    const missedItem = missedDues(state, now).find(x => x.loan.id === l.id);
    if (missedItem) {
      primary = `
        <div class="card debt-sum">
          <p class="card-label" style="color:var(--red)">漏了 ${missedItem.count} 期沒記</p>
          <p class="num">${money(missedItem.amount)}</p>
          <p class="sub">${mdTxt(missedItem.first)} 起，每期 ${money(mi)}</p>
        </div>
        <button class="btn green" data-action="receive-missed" data-id="${l.id}">記補繳（${missedItem.count}期）</button>
        <button class="btn outline-red" data-action="mark-overdue" data-id="${l.id}">標記欠繳</button>`;
      more = `
        <button class="btn outline-grey" data-action="edit" data-id="${l.id}">更正借款資料</button>
        <button class="btn outline-grey" data-action="close-normal" data-id="${l.id}">本金已還清</button>
        <button class="btn outline-red" data-action="delete-loan" data-id="${l.id}">刪除錯帳</button>`;
    } else {
      primary = `
        <button class="btn green" data-action="receive" data-id="${l.id}" ${paid ? 'disabled' : ''}>
          ${byPrepaid ? '✓ 本月在預收範圍內' : paid ? '✓ 本月收款已記' : '記本月收款'}
        </button>
        <button class="btn outline-grey" data-action="edit" data-id="${l.id}">更正借款資料</button>`;
      more = `
        <button class="btn outline-red" data-action="mark-overdue" data-id="${l.id}">標記欠繳</button>
        <button class="btn outline-grey" data-action="close-normal" data-id="${l.id}">本金已還清</button>
        <button class="btn outline-red" data-action="delete-loan" data-id="${l.id}">刪除錯帳</button>`;
    }
  } else if (l.status === 'overdue' || l.status === 'legal') {
    const periods = overduePeriods(l, now);
    const accrued = overdueInterest(l, now, state.payments);
    const debtCard = `
      <div class="card debt-sum">
        <p class="card-label" style="color:var(--red)">欠繳中${l.status === 'legal' ? '（法院處理）' : ''}</p>
        <p class="num">${money(l.principal + accrued)}</p>
        <p class="sub">本金 ${money(l.principal)} ＋ 欠 ${periods} 期利息 ${money(accrued)}（${mdTxt(parseDate(l.overdueSince))} 起算）</p>
      </div>`;
    if (l.status === 'overdue') {
      primary = debtCard + `
        <button class="btn green" data-action="repay-overdue" data-id="${l.id}">記欠息補繳</button>
        <button class="btn outline-grey" data-action="back-normal" data-id="${l.id}">恢復正常</button>`;
      more = `
        <button class="btn outline-red" data-action="to-legal" data-id="${l.id}">進入法院</button>
        <button class="btn outline-grey" data-action="edit" data-id="${l.id}">更正借款資料</button>
        <button class="btn outline-grey" data-action="close-normal" data-id="${l.id}">本金已還清</button>
        <button class="btn outline-red" data-action="delete-loan" data-id="${l.id}">刪除錯帳</button>`;
    } else {
      primary = debtCard + `
        <button class="btn accent" data-action="settle-legal" data-id="${l.id}">法院結案</button>
        <button class="btn outline-grey" data-action="delegal" data-id="${l.id}">退回欠繳</button>`;
      more = `
        <button class="btn outline-grey" data-action="edit" data-id="${l.id}">更正基本資料</button>
        <button class="btn outline-red" data-action="delete-loan" data-id="${l.id}">刪除錯帳</button>`;
    }
  } else {
    primary = `
      <div class="card">
        <div class="kv">
          <div><span class="k">狀態</span><span class="v">已結清</span></div>
          <div><span class="k">結清日</span><span class="v ${l.closedDate ? '' : 'red'}">${l.closedDate || '未填（過去月報會少算這筆）'}</span></div>
          ${l.finalReceived != null ? `<div><span class="k">結案實收</span><span class="v">${money(l.finalReceived)}</span></div>` : ''}
          ${l.writeoff ? `<div><span class="k">壞帳沖銷</span><span class="v red">${money(l.writeoff)}</span></div>` : ''}
        </div>
      </div>
      <button class="btn accent" data-action="reopen" data-id="${l.id}">撤銷結清</button>
      <button class="btn outline-grey" data-action="edit" data-id="${l.id}">改基本資料</button>`;
    more = `
        ${l.closedDate ? '' : `<button class="btn accent" data-action="fill-closed" data-id="${l.id}">補填結清日</button>`}
        <button class="btn outline-red" data-action="delete-loan" data-id="${l.id}">刪除錯帳</button>`;
  }

  // 最近 3 筆收款：每天最常確認的是「上次何時收到」
  const recent3 = pays.slice(0, 3).map(p => `
    <div class="h-row">
      <span>${mdTxt(parseDate(p.date))}</span>
      ${periodTag(p)}
      <span class="amount">${money(p.amount)}</span>
      <span class="ok-mark">✓</span>
    </div>`).join('');

  return `
    <div class="backrow">
      <button class="back" data-action="back">‹</button>
      <h1>${esc(l.name)}</h1>
      <span class="chip ${STATUS_CHIP[l.status]}">${STATUS_TXT[l.status]}</span>
    </div>

    <div class="card hero-amt">
      <p class="label">每月利息</p>
      <p class="num">${money(mi)}</p>
      ${l.status === 'normal' ? `<p class="when">每月${dueDayTxt(l.dueDay)}收，下次：${nextTxt}</p>` : ''}
    </div>

    ${primary}

    ${recent3 ? `<p class="section-h">最近收款</p><div class="card history">${recent3}</div>` : ''}

    <details class="acc"><summary>借款資料</summary><div class="acc-body">
      <div class="kv">
        <div><span class="k">本金</span><span class="v">${money(l.principal)}</span></div>
        <div><span class="k">月利率</span><span class="v">${l.rate}%</span></div>
        <div><span class="k">借款日期</span><span class="v">${l.startDate}</span></div>
        ${l.prepaidMonths ? `<div><span class="k">簽約預收</span><span class="v">${l.prepaidMonths} 個月（至 ${pu ? mdTxt(pu) : ''}）</span></div>` : ''}
        <div><span class="k">介紹費</span><span class="v">${money(l.referralFee || 0)}</span></div>
        <div><span class="k">代書費</span><span class="v">${money(l.appraisalFee || 0)}</span></div>
        ${l.note ? `<div><span class="k">備註</span><span class="v" style="font-weight:600">${esc(l.note)}</span></div>` : ''}
      </div>
    </div></details>

    <details class="acc"><summary>完整收款記錄（${state.payments.filter(p => p.loanId === l.id).length} 筆）</summary><div class="acc-body">
      <div class="history">${payRows || '<div class="empty" style="padding:14px">還沒收過款</div>'}</div>
    </div></details>

    <details class="acc"><summary>更多操作</summary><div class="acc-body">${more}</div></details>
  `;
}

// ───────────────────────── 新增／編輯 ─────────────────────────

function viewForm() {
  const editing = route.id ? loanById(route.id) : null;
  const locked = !!(editing && editing.status === 'closed');
  const dis = locked ? 'disabled' : '';
  const l = editing || {
    name: '', principal: '', rate: 2,
    startDate: fmtDate(today()), dueDay: today().getDate(),
    prepaidMonths: 3, referralFee: '', appraisalFee: DEFAULT_APPRAISAL, note: '',
  };
  const pm = l.prepaidMonths ?? 0;
  const pmOptions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n =>
    `<option value="${n}"${pm === n ? ' selected' : ''}>${n === 0 ? '不預收' : n + ' 個月'}</option>`).join('');

  const dayOptions = ['<option value="EOM"' + (l.dueDay === 'EOM' ? ' selected' : '') + '>月底</option>'];
  for (let d = 1; d <= 31; d++) {
    dayOptions.push(`<option value="${d}"${l.dueDay === d ? ' selected' : ''}>${d} 號</option>`);
  }

  return `
    <div class="backrow">
      <button class="back" data-action="back">‹</button>
      <h1>${editing ? '編輯借款' : '新增借款'}</h1>
    </div>
    ${locked ? `
      <p class="hint" style="color:var(--red);font-size:16px;font-weight:700;margin:0 2px">已結清：金額與日期已鎖定。要更正請先撤銷結清。</p>
      <button class="btn accent" data-action="reopen" data-id="${editing.id}">撤銷結清</button>`
    : editing ? '<p class="hint" style="color:var(--sub);font-size:15px;margin:0 2px">改本金、利率、日期會連過去的欠息與統計一起重算 —— 只用來修打錯的資料。</p>' : ''}

    <div class="field"><label>借款人姓名</label>
      <input id="f-name" value="${esc(l.name)}" placeholder="王小明"></div>
    <div class="field"><label>本金</label>
      <input id="f-principal" inputmode="numeric" value="${l.principal}" placeholder="600000" ${dis}></div>
    <div class="field"><label>月利率 %（1.5–2）</label>
      <input id="f-rate" inputmode="decimal" value="${l.rate}" ${dis}></div>
    <div class="field"><label>借款日期</label>
      <input id="f-start" type="date" value="${l.startDate}" ${dis}></div>
    <div class="field"><label>收息日（每月幾號）</label>
      <select id="f-dueday" ${dis}>${dayOptions.join('')}</select>
      <span class="hint">29–31 號：當月沒有該號時自動改當月最後一天</span></div>
    <div class="field"><label>簽約預收利息</label>
      <select id="f-prepaid" ${dis}>${pmOptions}</select>
      <span class="hint">簽約當天一次收走前幾個月利息，提醒自動從之後開始</span></div>

    <div class="calc-panel">
      <p class="card-label">App 幫你算好</p>
      <div class="kv" id="f-calc"></div>
    </div>

    <div class="field"><label>介紹費（可改）</label>
      <input id="f-referral" inputmode="numeric" value="${l.referralFee}"></div>
    <div class="field"><label>代書費（可改）</label>
      <input id="f-appraisal" inputmode="numeric" value="${l.appraisalFee}"></div>
    <div class="field"><label>備註（選填）</label>
      <textarea id="f-note">${esc(l.note)}</textarea></div>

    <button class="btn accent" data-action="save-form" data-id="${editing ? editing.id : ''}">
      ${editing ? '儲存修改' : '存好，之後記得加到行事曆'}</button>
  `;
}

function refreshFormCalc() {
  const box = document.getElementById('f-calc');
  if (!box) return;
  const principal = Number(document.getElementById('f-principal').value) || 0;
  const rate = Number(document.getElementById('f-rate').value) || 0;
  const mi = Math.round(principal * rate / 100);
  const pmSel = Number(document.getElementById('f-prepaid')?.value) || 0;

  // 即時預覽第一期與下次收息：簽約日跟收息日對不上會當場看到（例：8/15 簽、14 號收 → 首期跳到 9/14）
  let scheduleRows = '';
  const sd = document.getElementById('f-start').value;
  const dvv = document.getElementById('f-dueday').value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(sd)) {
    const tmp = {
      startDate: sd, dueDay: dvv === 'EOM' ? 'EOM' : Number(dvv),
      prepaidMonths: pmSel, status: 'normal', principal, rate,
    };
    const first = nextCollectDue({ ...tmp, prepaidMonths: 0 }, parseDate(sd));
    const next = nextCollectDue(tmp, parseDate(sd));
    const warn = fmtDate(first) !== sd;
    scheduleRows = `
      <div><span class="k">第一期收息日</span><span class="v${warn ? ' red' : ''}">${mdTxt(first)}${warn ? '（非簽約日）' : ''}</span></div>
      ${pmSel ? `<div><span class="k">預收涵蓋後，下次收息</span><span class="v">${mdTxt(next)}</span></div>` : ''}`;
  }

  box.innerHTML = `
    <div><span class="k">每月利息</span><span class="v">${money(mi)}</span></div>
    ${pmSel ? `<div><span class="k">簽約當天收（${pmSel} 個月息）</span><span class="v">${money(mi * pmSel)}</span></div>` : ''}
    ${scheduleRows}
    <div><span class="k">介紹費（半個月息）</span><span class="v">${money(Math.round(mi / 2))}</span></div>
    <div><span class="k">代書費</span><span class="v">${money(Number(document.getElementById('f-appraisal').value) || 0)}</span></div>`;
  const ref = document.getElementById('f-referral');
  if (ref && !ref.dataset.touched) ref.value = Math.round(mi / 2) || '';
}

async function saveForm(id) {
  const name = document.getElementById('f-name').value.trim();
  const principal = Number(document.getElementById('f-principal').value);
  const rate = Number(document.getElementById('f-rate').value);
  const startDate = document.getElementById('f-start').value;
  const dv = document.getElementById('f-dueday').value;
  const dueDay = dv === 'EOM' ? 'EOM' : Number(dv);
  const prepaidMonths = Number(document.getElementById('f-prepaid').value) || 0;
  const referralFee = Number(document.getElementById('f-referral').value) || 0;
  const appraisalFee = Number(document.getElementById('f-appraisal').value) || 0;
  const note = document.getElementById('f-note').value.trim();

  const errs = [];
  if (!name) errs.push('姓名要填');
  if (!(Number.isFinite(principal) && principal > 0)) errs.push('本金要是正數');
  if (!(Number.isFinite(rate) && rate > 0 && rate <= 20)) errs.push('月利率不合理');
  if (!startDate) errs.push('借款日期要填');
  if (!(Number.isFinite(referralFee) && referralFee >= 0)) errs.push('介紹費不能是負數');
  if (!(Number.isFinite(appraisalFee) && appraisalFee >= 0)) errs.push('代書費不能是負數');
  if (errs.length) { alert(errs.join('\n')); return; }

  if (id) {
    const l = loanById(id);
    const coreChanged = l.principal !== principal || l.rate !== rate ||
      l.startDate !== startDate || l.dueDay !== dueDay || (l.prepaidMonths || 0) !== prepaidMonths;
    // 已結清／結案：金額與日期鎖定，避免與歷史結案金額矛盾
    if (l.status === 'closed' && coreChanged) {
      alert('已結清的帳只能改姓名、介紹費、代書費、備註。\n金額或日期真的錯了，先在「更多操作」按「撤銷結清」再改。');
      return;
    }
    // 日期關係：存進去才發現壞掉會整份進救援流程，這裡先擋
    if (l.overdueSince && l.overdueSince < startDate) {
      alert(`停繳日（${l.overdueSince}）會早於新的借款日，日期矛盾。\n先「恢復正常」清掉欠繳狀態再改借款日。`);
      return;
    }
    if (l.closedDate && l.closedDate < startDate) {
      alert(`結清日（${l.closedDate}）會早於新的借款日，日期矛盾。`);
      return;
    }
    const oldMi = monthlyInterest(l);
    const oldPm = l.prepaidMonths || 0;
    const oldStart = l.startDate;
    const remindChanged = l.status === 'normal' &&
      (l.dueDay !== dueDay || l.principal !== principal || l.rate !== rate ||
       l.name !== name || l.startDate !== startDate || (l.prepaidMonths || 0) !== prepaidMonths);
    Object.assign(l, { name, principal, rate, startDate, dueDay, prepaidMonths, referralFee, appraisalFee, note });

    // 簽約預收款跟著改，不留舊金額舊日期的錯帳
    const newMi = Math.round(principal * rate / 100);
    const pp = oldPm > 0 ? state.payments.find(p => p.loanId === l.id &&
      (p.kind === 'prepaid' || (!p.dueDate && p.date === oldStart && p.amount === oldMi * oldPm))) : null;
    if (pp) {
      if (prepaidMonths > 0) {
        if (pp.amount !== newMi * prepaidMonths || pp.date !== startDate) {
          pp.amount = newMi * prepaidMonths;
          pp.date = startDate;
          pp.kind = 'prepaid';
          setTimeout(() => alert(`簽約預收款已同步改為 ${money(newMi * prepaidMonths)}（${startDate}）。`), 600);
        }
      } else {
        state.payments = state.payments.filter(p => p !== pp);
        setTimeout(() => alert('預收改為 0，原本的簽約預收款已一併刪除。'), 600);
      }
    } else if (oldPm === 0 && prepaidMonths > 0) {
      if (await confirmPanel({
        title: '補記簽約預收款？',
        lines: [name, money(newMi * prepaidMonths), { sub: `預收 ${prepaidMonths} 個月，日期＝借款日` }],
        ok: '補記預收款',
      })) {
        state.payments.push({ id: newId(), loanId: l.id, date: startDate, amount: newMi * prepaidMonths, kind: 'prepaid' });
      } else {
        // 沒有收款就不能算已收：取消補記 = 預收維持 0
        l.prepaidMonths = 0;
        setTimeout(() => alert('未補記預收款，預收月數維持 0（提醒照常從下個收息日開始）。'), 600);
      }
    }

    save(state); go('detail', { id });
    if (remindChanged) {
      setTimeout(() => {
        downloadICS([l], `收息提醒-${l.name}.ics`);
        alert('提醒內容有變，行事曆更新檔已下載：點開按「加入」即覆蓋舊提醒。');
      }, 300);
    }
  } else {
    const loan = {
      id: newId(), name, principal, rate, startDate, dueDay, prepaidMonths,
      status: 'normal', overdueSince: null, finalReceived: null, writeoff: null,
      referralFee, appraisalFee, note,
    };
    state.loans.push(loan);
    // 預收利息：簽約當天記一筆收款
    const mi = Math.round(principal * rate / 100);
    if (prepaidMonths > 0) {
      state.payments.push({ id: newId(), loanId: loan.id, date: startDate, amount: mi * prepaidMonths, kind: 'prepaid' });
    }
    navFrom.detail = navFrom.form;   // 新增表單進詳情：返回要回到開表單前的分頁
    save(state); go('detail', { id: loan.id });
    // 行事曆檔自動下載，少按一顆按鈕
    setTimeout(() => {
      downloadICS([loan], `收息提醒-${loan.name}.ics`);
      alert(`存好了！${prepaidMonths ? `已記一筆預收 ${money(mi * prepaidMonths)}。` : ''}\n行事曆檔已自動下載：點開它按「加入」，提醒就設好了${prepaidMonths ? '（會自動從預收期之後才開始跳）' : ''}。`);
    }, 300);
  }
}

// ───────────────────────── 問題帳 ─────────────────────────

function viewProblems() {
  const now = today();
  const probs = state.loans.filter(isProblem);
  const head = `<div class="title-row"><h1 class="title">欠繳${probs.length ? `（${probs.length}）` : ''}</h1>${gearBtn()}</div>`;
  if (!probs.length) return head + '<div class="empty">目前沒有欠繳，很好 👍</div>';

  const st = stats(state, now);
  const rowOf = l => {
    const periods = overduePeriods(l, now);
    const net = overdueInterest(l, now, state.payments);
    const since = parseDate(l.overdueSince);
    return `
      <button class="person-row" data-action="open-loan" data-id="${l.id}">
        <span class="pcol">
          <span class="name">${esc(l.name)}</span>
          <span class="psub">欠 ${periods} 期 · 自 ${since.getMonth() + 1}/${since.getDate()} 起</span>
        </span>
        <span class="money" style="color:var(--red)">欠 ${money(net)}</span>
        <span class="chev">›</span>
      </button>`;
  };
  // 追款優先順序：最早停繳的排最上面
  const bySince = (a, b) => a.overdueSince.localeCompare(b.overdueSince);
  const chasing = probs.filter(l => l.status === 'overdue').sort(bySince);
  const legal = probs.filter(l => l.status === 'legal').sort(bySince);

  return head + `
    <p class="section-h">合計欠息 ${money(st.overdueInt)}｜卡住本金 ${money(st.overduePrincipal)}</p>
    ${chasing.length ? `<p class="section-h">待追繳</p><div class="rowlist">${chasing.map(rowOf).join('')}</div>` : ''}
    ${legal.length ? `<p class="section-h">法院處理中</p><div class="rowlist">${legal.map(rowOf).join('')}</div>` : ''}`;
}

// ───────────────────────── 統計 ─────────────────────────

function fmtWan(n) {
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '萬';
  return n.toLocaleString('en-US');
}

function viewStats() {
  const now = today();
  if (!statsCursor) statsCursor = { y: now.getFullYear(), m: now.getMonth() };
  return `
    <div class="title-row"><h1 class="title">帳務</h1>${gearBtn()}</div>
    <div class="seg">
      <button class="${statsTab === 'month' ? 'active' : ''}" data-action="stats-tab" data-tab="month">月報</button>
      <button class="${statsTab === 'overview' ? 'active' : ''}" data-action="stats-tab" data-tab="overview">總覽</button>
    </div>
    ${statsTab === 'month' ? statsMonthView(now) : statsOverview(now)}`;
}

function statsMonthView(now) {
  const { y, m } = statsCursor;
  const isThisMonth = y === now.getFullYear() && m === now.getMonth();
  const isFuture = y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth());
  const rp = monthReport(state, y, m, now);

  const rowFor = (r, alert) => `
    <button class="slim${alert ? ' alert' : ''}" data-action="open-loan" data-id="${r.loan.id}">
      <span class="l"><small>${r.day}日</small>${esc(r.loan.name)}</span>
      <span class="r">${money(r.amount)}</span>
    </button>`;
  const expiredRows = rp.unpaidRows.map(r => rowFor(r, true)).join('');
  const notYetRows = rp.notYetRows.map(r => rowFor(r, false)).join('');

  const nameOf = id => { const l = loanById(id); return l ? l.name : '（已刪除）'; };
  const payRows = rp.payList.map(p => `
    <div class="h-row">
      <span>${mdTxt(parseDate(p.date))}</span>
      <span style="flex:1;font-weight:700">${esc(nameOf(p.loanId))} ${periodTag(p)}</span>
      <span class="amount">${money(p.amount)}</span>
      <span class="ok-mark">✓</span>
    </div>`).join('');

  return `
    <div class="card">
      <div class="cal-month-row">
        <span class="cal-month" data-action="stats-today">${y}年${m + 1}月${isThisMonth ? '（本月）' : ''}</span>
        <div class="cal-nav">
          <button data-action="stats-prev" aria-label="上個月">‹</button>
          <button data-action="stats-next" aria-label="下個月">›</button>
        </div>
      </div>
      <div class="triple">
        <div><p class="k">本月到期</p><p class="n">${money(rp.due)}</p></div>
        <div><p class="k">本月入帳</p><p class="n green">${money(rp.received)}</p></div>
        <div><p class="k">到期未收</p>
          <p class="n ${rp.dueUnpaid ? 'red' : ''}">${money(rp.dueUnpaid)}</p></div>
      </div>
    </div>
    ${expiredRows ? `<p class="section-h" style="color:var(--red)">到期還沒收的</p><div class="rowlist">${expiredRows}</div>` : ''}
    ${notYetRows ? `<p class="section-h">尚未到期</p><div class="rowlist">${notYetRows}</div>` : ''}
    ${payRows ? `<p class="section-h">${m + 1}月收款記錄</p><div class="card history">${payRows}</div>` : ''}
    ${!expiredRows && !notYetRows && !payRows ? '<div class="empty">這個月沒有收息安排</div>' : ''}`;
}

function statsOverview(now) {
  const st = stats(state, now);
  const activeCount = state.loans.filter(isActive).length;

  // 本金：有欠繳才畫環圈；全正常就一個數字，不畫沒資訊量的全綠圓
  const normalP = state.loans.filter(l => l.status === 'normal').reduce((s, l) => s + l.principal, 0);
  const problemP = st.overduePrincipal;
  const totalP = normalP + problemP;
  let principalHtml;
  if (problemP > 0 && totalP > 0) {
    const C = 2 * Math.PI * 50;
    const gap = normalP && problemP ? 4 : 0;
    const segG = Math.max(0, normalP / totalP * C - gap);
    const segR = Math.max(0, problemP / totalP * C - gap);
    principalHtml = `
    <div class="card">
      <p class="card-label">錢在哪裡（${activeCount} 筆）</p>
      <div class="donut-row">
        <svg viewBox="0 0 140 140" role="img" aria-label="本金組成">
          <g transform="rotate(-90 70 70)">
            ${normalP ? `<circle cx="70" cy="70" r="50" fill="none" stroke="var(--green)" stroke-width="28" stroke-dasharray="${segG} ${C - segG}"/>` : ''}
            <circle cx="70" cy="70" r="50" fill="none" stroke="var(--red)" stroke-width="28" stroke-dasharray="${segR} ${C - segR}" stroke-dashoffset="${-(segG + gap)}"/>
          </g>
          <text x="70" y="64" text-anchor="middle" font-size="11" fill="var(--sub)" font-weight="700">總本金</text>
          <text x="70" y="84" text-anchor="middle" font-size="15" fill="var(--ink)" font-weight="800">${money(totalP)}</text>
        </svg>
        <div class="dlegend">
          <div class="li"><i style="background:var(--green)"></i>正常收息<span class="v">${money(normalP)}</span></div>
          <div class="li"><i style="background:var(--red)"></i>欠繳中<span class="v">${money(problemP)}</span></div>
          ${st.overdueInt ? `<div class="li" style="color:var(--red)"><i style="background:none"></i>另有欠息<span class="v">${money(st.overdueInt)}</span></div>` : ''}
        </div>
      </div>
    </div>`;
  } else {
    principalHtml = `
    <div class="card">
      <p class="card-label">放出本金（${activeCount} 筆）</p>
      <p class="hero-num">${money(totalP)}</p>
    </div>`;
  }

  const series = monthlySeries(state.payments, now, 7);
  const max = Math.max(...series.map(s => s.total), 1);
  const bars = series.map((s, i) => {
    const isNow = i === series.length - 1;
    const h = Math.round(s.total / max * 100);
    const label = s.total ? `<span class="amt">${fmtWan(s.total)}</span>` : '';
    return `<div class="bar${isNow ? ' now' : ''}">${label}<i style="height:${h}%"></i><b>${s.month + 1}月</b></div>`;
  }).join('');

  const fees = st.referralTotal + st.appraisalTotal;
  return `
    ${principalHtml}
    <div class="card">
      <p class="card-label">近 7 個月實收利息（至本月）</p>
      <div class="bars">${bars}</div>
    </div>
    <div class="card">
      <p class="card-label">歷史收支</p>
      <div class="formula">
        <div class="fr"><span>已收利息</span><span class="v green">${money(st.received)}</span></div>
        <div class="fr"><span>－ 付出費用</span><span class="v">${money(fees)}</span></div>
        <p class="fnote">介紹費 ${money(st.referralTotal)} ＋ 代書費 ${money(st.appraisalTotal)}</p>
        <div class="fr eq"><span>＝ 淨收入</span><span class="v green">${money(st.net)}</span></div>
        ${st.writeoffTotal ? `<div class="fr"><span>壞帳沖銷</span><span class="v red">${money(st.writeoffTotal)}</span></div>` : ''}
        <p class="fnote">今年已收利息 ${money(st.yearReceived)}</p>
      </div>
    </div>`;
}

// ───────────────────────── 更正收款 ─────────────────────────

function viewPayEdit() {
  const p = state.payments.find(x => x.id === route.pid);
  if (!p) return '<div class="empty">找不到這筆收款</div>';
  const pl = loanById(p.loanId);
  return `
    <div class="backrow">
      <button class="back" data-action="back">‹</button>
      <h1>更正收款</h1>
    </div>
    <div class="card"><div class="kv">
      <div><span class="k">借款人</span><span class="v">${esc(pl ? pl.name : '（已刪除）')}</span></div>
      <div><span class="k">原記錄</span><span class="v">${p.date}｜${money(p.amount)}</span></div>
    </div></div>
    <div class="field"><label>實際收款日</label>
      <input id="pe-date" type="date" value="${p.date}"></div>
    <div class="field"><label>歸屬期（這筆錢是繳哪個月的利息）</label>
      <input id="pe-due" type="date" value="${p.dueDate || ''}">
      <span class="hint">留空＝跟收款日同一個月</span></div>
    <div class="field"><label>金額</label>
      <input id="pe-amount" inputmode="numeric" value="${p.amount}"></div>
    <button class="btn accent" data-action="payedit-save">儲存更正</button>
    <button class="btn outline-grey" data-action="back">取消</button>
  `;
}

// ───────────────────────── 設定 ─────────────────────────

function viewSettings() {
  const backupTxt = state.lastExport
    ? `上次匯出：${state.lastExport}`
    : '還沒匯出過，建議定期匯出備份';
  return `
    <div class="backrow">
      <button class="back" data-action="back">‹</button>
      <h1>設定</h1>
    </div>

    <p class="section-h">同步與通知</p>
    <div class="card">
      <div class="kv">
        <div><span class="k">同步狀態</span><span class="v">${syncStatusTxt()}</span></div>
        <div><span class="k">自動提醒</span><span class="v">${cloud.meta().pushOn ? '已開啟' : '未開啟'}</span></div>
      </div>
    </div>
    <button class="btn accent" data-action="cloud-sync-now">立刻同步</button>
    ${cloud.meta().pushOn
      ? '<button class="btn outline-grey" data-action="cloud-push-test">測試提醒（馬上跳一則通知）</button>'
      : '<button class="btn accent" data-action="cloud-push-enable">開啟自動提醒（免行事曆）</button>'}

    <p class="section-h">行事曆</p>
    <button class="btn outline-grey" data-action="ics-all">全部加到行事曆</button>
    <p class="hint" style="color:var(--sub);font-size:15px;margin:0 2px">${cloud.meta().pushOn
      ? '已開自動提醒 —— 行事曆可以不用再加，兩邊都加會重複通知。'
      : '行事曆會在收息日前一天與當天 09:30 各提醒一次；開了上面的自動提醒就不需要。'}</p>

    <p class="section-h">備份</p>
    <button class="btn outline-grey" data-action="export-xlsx">匯出 Excel 檔（備份／傳電腦）</button>
    <button class="btn outline-grey" data-action="import-xlsx">匯入 Excel 檔</button>
    <p class="hint" style="text-align:center;color:var(--sub);font-size:15px;margin:0">${backupTxt}</p>

    <details class="acc"><summary>進階（同步金鑰）</summary><div class="acc-body">
      <p class="hint" style="color:var(--sub);font-size:15px;margin:0">金鑰＝資料的鑰匙。抄下收好；換手機或第二台裝置輸入它連回同一份帳。</p>
      <div class="btn-pair">
        <button class="btn outline-grey" data-action="cloud-show-key">顯示同步金鑰</button>
        <button class="btn outline-grey" data-action="cloud-set-key">輸入金鑰連線</button>
      </div>
    </div></details>
  `;
}

function syncStatusTxt() {
  const m = cloud.meta();
  if (m.lastError) return `同步被拒：${m.lastError}（資料仍在手機，修正後按立刻同步）`;
  if (m.pending) return '待同步（離線中，連上網會自動補傳）';
  if (!m.lastSync) return '尚未同步';
  const min = Math.floor((Date.now() - m.lastSync) / 60000);
  return min < 1 ? '剛剛已同步 ✓' : min < 60 ? `${min} 分鐘前已同步 ✓` : new Date(m.lastSync).toLocaleString('zh-TW') + ' ✓';
}

// ───────────────────────── 分頁列 ─────────────────────────

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5M5.5 10v9h13v-9"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><path d="M16 5.6a3.5 3.5 0 0 1 0 5.8M18.5 15.2c1.6.8 2.7 2.3 3 4.8"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.5v.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>',
};

// 設定圖示要不要亮紅點（同步出狀況或太久沒備份）
function needsAttention() {
  const meta = cloud.meta();
  if (meta.lastError || meta.pending) return true;
  if (!state.loans.length) return false;
  if (!state.lastExport) return true;
  return Math.floor((today() - parseDate(state.lastExport)) / 86400000) > 30;
}

function gearBtn() {
  return `<button class="gearbtn" data-action="go" data-view="settings" aria-label="設定">
    ${ICONS.gear}${needsAttention() ? '<span class="dot"></span>' : ''}</button>`;
}

function renderTabbar() {
  const probCount = state.loans.filter(isProblem).length;
  const current = TAB_VIEWS.includes(route.view) ? route.view : lastTab;
  const active = v => current === v ? ' active' : '';
  $tabbar.innerHTML = `
    <button class="tab${active('home')}" data-action="go" data-view="home">${ICONS.home}今天</button>
    <button class="tab${active('people')}" data-action="go" data-view="people">${ICONS.people}借款</button>
    <button class="tab${active('problems')}" data-action="go" data-view="problems">
      <span class="badge-dot">${ICONS.warn}${probCount ? `<span class="n">${probCount}</span>` : ''}</span>欠繳</button>
    <button class="tab${active('stats')}" data-action="go" data-view="stats">${ICONS.chart}月報</button>`;
}

// ───────────────────────── 渲染 ─────────────────────────

function render() {
  const views = {
    home: viewHome, people: viewPeople, detail: viewDetail,
    form: viewForm, problems: viewProblems, stats: viewStats, settings: viewSettings,
    payedit: viewPayEdit,
  };
  $view.innerHTML = (views[route.view] || viewHome)();
  renderTabbar();
  if (route.view === 'form') {
    refreshFormCalc();
    for (const id of ['f-principal', 'f-rate', 'f-appraisal']) {
      document.getElementById(id).addEventListener('input', refreshFormCalc);
    }
    document.getElementById('f-prepaid').addEventListener('change', refreshFormCalc);
    document.getElementById('f-dueday').addEventListener('change', refreshFormCalc);
    document.getElementById('f-referral').addEventListener('input', e => { e.target.dataset.touched = '1'; });
    const startEl = document.getElementById('f-start');
    startEl.addEventListener('change', () => {
      const d = startEl.value ? Number(startEl.value.split('-')[2]) : null;
      if (d) document.getElementById('f-dueday').value = String(d);
      refreshFormCalc();
    });
  }
}

// ───────────────────────── 操作 ─────────────────────────

const actions = {
  go(el) {
    if (el.dataset.view === 'home') { calSelected = null; calCursor = null; }
    go(el.dataset.view);
  },
  back() {
    if (route.view === 'settings') { go(navFrom.settings); return; }
    if (route.view === 'form') { route.id ? go('detail', { id: route.id }) : go(navFrom.form); return; }
    if (route.view === 'payedit') { go('detail', { id: route.id }); return; }
    if (route.view === 'detail') { go(navFrom.detail); return; }
    go('home');
  },
  'open-loan'(el) { go('detail', { id: el.dataset.id }); },
  edit(el) { go('form', { id: el.dataset.id }); },
  'save-form'(el) { return saveForm(el.dataset.id || null); },

  'pick-day'(el) {
    const d = Number(el.dataset.day);
    calSelected = calSelected === d ? null : d;
    render();
  },
  'cal-prev'() { shiftMonth(-1); },
  'cal-next'() { shiftMonth(1); },
  'cal-today'() { calCursor = null; calSelected = null; render(); },
  'stats-prev'() { shiftStatsMonth(-1); },
  'stats-next'() { shiftStatsMonth(1); },
  'stats-today'() { statsCursor = null; render(); },
  'stats-tab'(el) { statsTab = el.dataset.tab; render(); },

  async receive(el) {
    const l = loanById(el.dataset.id);
    const mi = monthlyInterest(l);
    const now0 = today();
    // 本月已有部分款：只補剩餘，不重複累計
    const paidSoFar = monthPaidAmount(state.payments, l.id, now0.getFullYear(), now0.getMonth());
    const remaining = Math.max(0, mi - paidSoFar);
    if (remaining <= 0) { render(); return; }
    const ok = await confirmPanel({
      title: '記下本月收款？',
      lines: [l.name, money(remaining),
        { sub: paidSoFar > 0 ? `本月已記 ${money(paidSoFar)}，此筆為剩餘` : '收款日：今天' }],
      ok: '記下收款',
    });
    if (!ok) return;
    state.payments.push({
      id: newId(), loanId: l.id, date: fmtDate(now0),
      dueDate: fmtDate(dueDateFor(now0.getFullYear(), now0.getMonth(), l.dueDay)),
      amount: remaining,
    });
    commit();
  },
  async 'receive-missed'(el) {
    const l = loanById(el.dataset.id);
    // 各期只補「剩餘金額」：已有部分款不會被重複加成超額
    const list = missedPeriods(state, l, today());
    if (!list.length) { render(); return; }
    const total = list.reduce((s, x) => s + x.remaining, 0);
    const ok = await confirmPanel({
      title: `記補繳（${list.length}期）？`,
      lines: [l.name, money(total),
        { sub: list.map(x => `${x.date.getMonth() + 1}/${x.date.getDate()} 補 ${money(x.remaining)}`).join('、') },
        { sub: '收款日記今天，各期歸屬原收息日' }],
      ok: '記補繳',
    });
    if (!ok) return;
    const todayStr = fmtDate(today());
    for (const x of list) {
      state.payments.push({ id: newId(), loanId: l.id, date: todayStr, dueDate: fmtDate(x.date), amount: x.remaining });
    }
    commit();
  },
  'edit-payment'(el) {
    const p = state.payments.find(x => x.id === el.dataset.id);
    if (!p) return;
    go('payedit', { pid: p.id, id: p.loanId });
  },
  async 'payedit-save'() {
    const p = state.payments.find(x => x.id === route.pid);
    if (!p) { go('home'); return; }
    const pl = loanById(p.loanId);
    const vd = t => /^\d{4}-\d{2}-\d{2}$/.test(t) && fmtDate(parseDate(t)) === t;
    const d1 = document.getElementById('pe-date').value;
    const due = document.getElementById('pe-due').value;
    const amount = Number(document.getElementById('pe-amount').value);
    if (!vd(d1)) { alert('收款日不對，格式要像 2026-08-16'); return; }
    if (due && !vd(due)) { alert('歸屬期不對，格式要像 2026-07-14'); return; }
    if (!(Number.isFinite(amount) && amount > 0)) { alert('金額要是正常的正數'); return; }
    const ok = await confirmPanel({
      title: '確認更正這筆收款？',
      lines: [pl ? pl.name : '', money(amount), { sub: `收款日 ${d1}${due ? '｜歸屬 ' + due : ''}` }],
      ok: '儲存更正',
    });
    if (!ok) return;
    // 先認清這筆是不是簽約預收款（改完特徵就對不上了，要先判）
    const wasPrepaid = pl && (p.kind === 'prepaid' ||
      (!p.dueDate && (pl.prepaidMonths || 0) > 0 && p.date === pl.startDate &&
       p.amount === monthlyInterest(pl) * pl.prepaidMonths));
    p.date = d1;
    if (due) p.dueDate = due; else delete p.dueDate;
    p.amount = amount;
    if (wasPrepaid && pl) {
      // 預收款金額變了 → 預收月數跟著重算，錢和涵蓋期不准脫鉤
      if (due) {
        pl.prepaidMonths = 0;
        delete p.kind;
        setTimeout(() => alert('這筆原是簽約預收款；填了歸屬期後改當一般收款，預收月數歸零。'), 300);
      } else {
        const mi = monthlyInterest(pl);
        const k = Math.max(0, Math.min(12, Math.floor(amount / mi)));
        pl.prepaidMonths = k;
        if (k > 0) p.kind = 'prepaid'; else delete p.kind;
        const rem = amount - k * mi;
        setTimeout(() => alert(`簽約預收款已更正，預收月數同步改為 ${k} 個月${rem > 0 ? `（多出的 ${money(rem)} 併入該月收款）` : ''}。`), 300);
      }
    } else {
      delete p.kind;   // 手動更正過就不再被「編輯借款」自動同步覆蓋
    }
    save(state);
    go('detail', { id: p.loanId });
  },
  async 'del-payment'(el) {
    const p = state.payments.find(x => x.id === el.dataset.id);
    if (!p) return;
    const l = loanById(p.loanId);
    const isPrepaid = l && (p.kind === 'prepaid' ||
      (!p.dueDate && (l.prepaidMonths || 0) > 0 && p.date === l.startDate &&
       p.amount === monthlyInterest(l) * l.prepaidMonths));
    const ok = await confirmPanel({
      title: isPrepaid ? '刪除簽約預收款？' : '刪除收款？',
      lines: [l ? l.name : '', money(p.amount),
        { sub: isPrepaid ? '預收月數會歸零，提醒從下個收息日開始' : `收款日 ${p.date}` }],
      ok: '刪除收款', danger: true,
    });
    if (!ok) return;
    if (isPrepaid) l.prepaidMonths = 0;
    state.payments = state.payments.filter(x => x.id !== p.id);
    commit();
  },

  'mark-overdue'(el) {
    const l = loanById(el.dataset.id);
    const now0 = today();
    // 預設 = 最近一次該收而沒收的收息日
    let def = dueDateFor(now0.getFullYear(), now0.getMonth(), l.dueDay);
    if (def > now0) def = dueDateFor(now0.getFullYear(), now0.getMonth() - 1, l.dueDay);
    if (def < parseDate(l.startDate)) def = now0;
    const d = prompt('第一個「沒繳」的收息日是哪天？\n（預設＝最近一次該收的日子，欠息從這天起算）', fmtDate(def));
    if (!d) return;
    const t = d.trim();
    const dd = /^\d{4}-\d{2}-\d{2}$/.test(t) ? parseDate(t) : null;
    if (!dd || fmtDate(dd) !== t) { alert('這不是真實日期，格式要像 2026-08-04'); return; }
    if (dd < parseDate(l.startDate)) { alert('停繳日不能早於借款日（' + l.startDate + '）'); return; }
    if (dd > now0) { alert('停繳日不能是未來'); return; }
    // 自動對齊到收息日：欠息只能從「沒繳的那個收息日」起算，隨便填 8/7 會少算一期
    let snap = dueDateFor(dd.getFullYear(), dd.getMonth(), l.dueDay);
    if (snap > dd) snap = dueDateFor(dd.getFullYear(), dd.getMonth() - 1, l.dueDay);
    if (snap < parseDate(l.startDate)) { alert('這個日期之前還沒有收息日，確認一下借款日。'); return; }
    const final = fmtDate(snap);
    l.status = 'overdue'; l.overdueSince = final;
    commit();
    downloadStopICS(l);
    setTimeout(() => alert(`已列入問題帳，欠息從收息日 ${final} 起算${final !== t ? `（你填 ${t}，已自動對齊）` : ''}。\n「停止提醒」檔已自動下載：點開它按「加入」，行事曆的每月提醒就停了。`), 300);
  },
  async 'back-normal'(el) {
    const l = loanById(el.dataset.id);
    const ok = await confirmPanel({
      title: '恢復正常收息？',
      lines: [l.name, { sub: '欠繳記錄會清除，之後照常每月提醒' }],
      ok: '恢復正常',
    });
    if (!ok) return;
    l.status = 'normal'; l.overdueSince = null;
    commit();
    downloadICS([l], `收息提醒-${l.name}.ics`);
    setTimeout(() => alert('已恢復正常。\n行事曆檔已下載：點開按「加入」，每月提醒就接回來了。'), 300);
  },
  async 'to-legal'(el) {
    const l = loanById(el.dataset.id);
    const ok = await confirmPanel({
      title: '進入法院？',
      lines: [l.name, { sub: '狀態改為法院處理中，欠息照算' }],
      ok: '進入法院', danger: true,
    });
    if (!ok) return;
    l.status = 'legal';
    commit();
  },
  async 'repay-overdue'(el) {
    const l = loanById(el.dataset.id);
    const accrued = overdueInterest(l, today(), state.payments);
    if (accrued <= 0) { alert('目前沒有累計欠息。'); return; }
    const v = prompt(`收到多少？（目前累計欠息 ${money(accrued)}）`, String(accrued));
    if (v == null) return;
    const amount = Number(v);
    if (!(Number.isFinite(amount) && amount > 0)) { alert('金額要是正常的正數'); return; }
    if (amount > accrued) {
      alert(`超過目前欠息 ${money(accrued)}。\n這裡只記補欠息；若是還本金或預付，請用結清或備註記錄。`);
      return;
    }
    const ok = await confirmPanel({
      title: '記欠息補繳？',
      lines: [l.name, money(amount), { sub: '收款日：今天' }],
      ok: '記下補繳',
    });
    if (!ok) return;
    state.payments.push({ id: newId(), loanId: l.id, date: fmtDate(today()), amount });
    commit();
    // 補齊了就別留在「欠繳但欠 $0」的矛盾狀態
    if (overdueInterest(l, today(), state.payments) <= 0 &&
        await confirmPanel({ title: '欠息已補齊', lines: [l.name, { sub: '恢復正常收息？' }], ok: '恢復正常' })) {
      l.status = 'normal'; l.overdueSince = null;
      commit();
      downloadICS([l], `收息提醒-${l.name}.ics`);
      setTimeout(() => alert('已恢復正常。\n行事曆檔已下載：點開按「加入」，每月提醒就接回來了。'), 300);
    }
  },
  'settle-legal'(el) {
    const l = loanById(el.dataset.id);
    const now = today();
    const owed = l.principal + overdueInterest(l, now, state.payments);
    const v = prompt(`結案最後實拿多少？\n（應收 = 本金＋欠息 = ${money(owed)}）`, String(owed));
    if (v == null) return;
    const got = Number(v);
    if (!(Number.isFinite(got) && got >= 0)) { alert('金額不對'); return; }
    l.finalReceived = got;
    l.writeoff = Math.max(0, owed - got);
    l.status = 'closed';
    l.closedDate = fmtDate(now);
    commit();
    downloadStopICS(l);
    setTimeout(() => alert(`結案。${l.writeoff ? `壞帳沖銷 ${money(l.writeoff)} 已記入統計。` : '全額收回，沒有壞帳。'}\n「停止提醒」檔已自動下載：點開按「加入」。`), 300);
  },
  async 'close-normal'(el) {
    const l = loanById(el.dataset.id);
    const ok = await confirmPanel({
      title: '確認結清？',
      lines: [l.name, { sub: `本金 ${money(l.principal)} 已還清，這筆帳結束` }],
      ok: '確認結清', danger: true,
    });
    if (!ok) return;
    l.status = 'closed';
    l.closedDate = fmtDate(today());
    commit();
    downloadStopICS(l);
    setTimeout(() => alert('已結清。\n「停止提醒」檔已自動下載：點開它按「加入」，行事曆的每月提醒就停了。'), 300);
  },
  async 'delete-loan'(el) {
    const l = loanById(el.dataset.id);
    const pays = state.payments.filter(p => p.loanId === l.id);
    const total = pays.reduce((s, p) => s + p.amount, 0);
    const ok = await confirmPanel({
      title: '刪除錯帳？',
      lines: [l.name,
        ...(pays.length ? [{ sub: `會一起刪除 ${pays.length} 筆收款，共 ${money(total)}，過去月報也會更新` }] : []),
        { sub: '此功能只用於誤建或輸入錯誤' }],
      ok: '刪除錯帳', danger: true,
    });
    if (!ok) return;
    downloadStopICS(l);
    state.loans = state.loans.filter(x => x.id !== l.id);
    state.payments = state.payments.filter(p => p.loanId !== l.id);
    save(state); go('people');
    setTimeout(() => alert('已刪除。\n「停止提醒」檔已下載：點開按「加入」，行事曆的提醒才會跟著停。'), 300);
  },

  async 'reopen'(el) {
    const l = loanById(el.dataset.id);
    const ok = await confirmPanel({
      title: '撤銷結清？',
      lines: [l.name, { sub: '回到正常收息' + (l.finalReceived != null || l.writeoff ? '；結案實收與壞帳記錄會清除' : '') }],
      ok: '撤銷結清',
    });
    if (!ok) return;
    l.status = 'normal';
    l.closedDate = null;
    l.finalReceived = null;
    l.writeoff = null;
    l.overdueSince = null;   // 法院案撤銷不留舊停繳日，避免殘留隱藏日期
    save(state);
    go('detail', { id: l.id });
    downloadICS([l], `收息提醒-${l.name}.ics`);
    setTimeout(() => alert('已撤銷結清，回到正常收息。\n行事曆檔已下載：點開按「加入」，提醒接回來。'), 300);
  },
  async 'delegal'(el) {
    const l = loanById(el.dataset.id);
    const ok = await confirmPanel({
      title: '退回欠繳？',
      lines: [l.name, { sub: `停繳日 ${l.overdueSince} 保留，欠息照算` }],
      ok: '退回欠繳',
    });
    if (!ok) return;
    l.status = 'overdue';
    commit();
  },
  'fill-closed'(el) {
    const l = loanById(el.dataset.id);
    // 預設帶最近一次收款日僅供參考，避免順手按掉「今天」把舊月報多算好幾個月
    const lastPay = state.payments.filter(p => p.loanId === l.id)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const d = prompt(
      `這筆是哪天結清的？（格式 2026-08-10）\n填了之後，結清前的月份才會正確出現在月報裡。${lastPay ? `\n（最近一次收款是 ${lastPay.date}，僅供參考）` : ''}`,
      lastPay ? lastPay.date : '');
    if (!d) return;
    const t = d.trim();
    const dd = /^\d{4}-\d{2}-\d{2}$/.test(t) ? parseDate(t) : null;
    if (!dd || fmtDate(dd) !== t) { alert('這不是真實日期，格式要像 2026-08-10'); return; }
    if (dd < parseDate(l.startDate)) { alert('結清日不能早於借款日'); return; }
    if (dd > today()) { alert('結清日不能是未來'); return; }
    l.closedDate = t;
    commit();
  },
  'ics-one'(el) {
    const l = loanById(el.dataset.id);
    downloadICS([l], `收息提醒-${l.name}.ics`);
  },
  'ics-stop'(el) {
    downloadStopICS(loanById(el.dataset.id));
    setTimeout(() => alert('打開下載的檔案按「加入」，這筆的每月提醒就會停。\n若行事曆裡看到「（已停止）」的舊事件，點它刪掉即可。'), 300);
  },
  'ics-all'() {
    const normals = state.loans.filter(l => l.status === 'normal');
    if (!normals.length) { alert('沒有正常收息中的借款'); return; }
    downloadICS(normals, '收息提醒-全部.ics');
  },
  'export-xlsx'() {
    exportXlsx(state);
    state.lastExport = fmtDate(today());
    save(state); render();
  },
  'import-xlsx'() { $importFile.click(); },

  async 'cloud-sync-now'() {
    try {
      const r = await cloud.pull();
      const cloudAt = r && r.state ? (r.state.updatedAt || r.updatedAt || 0) : 0;
      if (cloudAt > (state.updatedAt || 0)) {
        state = r.state;
        save(state, false);
      } else {
        await cloud.pushNow(state);
      }
      render();
      alert('同步完成 ✓');
    } catch { alert('連不上雲端，檢查網路。'); }
  },
  async 'cloud-push-enable'() {
    try {
      await cloud.enablePush();
      render();
      alert('自動提醒開好了！\n收息前一天和當天早上 9:30，手機會自動跳通知，什麼都不用按。\n按「測試提醒」馬上試一則。');
    } catch (e) { alert(e.message); }
  },
  async 'cloud-push-test'() {
    try {
      const r = await cloud.testPush();
      if (!r.sent) alert('沒有送出。這支手機還沒開啟自動提醒？');
    } catch { alert('連不上雲端，檢查網路。'); }
  },
  'cloud-show-key'() {
    prompt('這是你的同步金鑰（等於資料的鑰匙，抄下來收好；\n換手機或第二台裝置輸入它就能連回同一份資料）：', cloud.getKey());
  },
  async 'cloud-set-key'() {
    const k = prompt('輸入另一組同步金鑰（會改連到那份資料）：');
    if (!k || k.trim().length < 24) { if (k != null) alert('金鑰長度不對'); return; }
    const oldKey = cloud.getKey();
    cloud.cancelPush();
    cloud.setKey(k);
    try {
      const r = await cloud.pull();
      if (r && r.state) {
        state = r.state;
        save(state, false);
        alert('已連上，資料同步完成。');
        go('home');
      } else {
        await cloud.pushNow(state);
        alert('這組金鑰雲端還沒有資料，已把目前手機的資料傳上去。');
        render();
      }
    } catch {
      cloud.setKey(oldKey);
      alert('連不上雲端，金鑰已還原成原本那把。檢查網路或金鑰再試。');
    }
  },
};

function shiftMonth(delta) {
  const now = today();
  if (!calCursor) calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const d = new Date(calCursor.y, calCursor.m + delta, 1);
  calCursor = { y: d.getFullYear(), m: d.getMonth() };
  calSelected = null;
  render();
}

function shiftStatsMonth(delta) {
  const now = today();
  if (!statsCursor) statsCursor = { y: now.getFullYear(), m: now.getMonth() };
  const d = new Date(statsCursor.y, statsCursor.m + delta, 1);
  statsCursor = { y: d.getFullYear(), m: d.getMonth() };
  render();
}

// 會寫入資料的動作：第一次點擊後鎖定至少 800ms，處理中不得重複執行
const WRITE_ACTIONS = new Set([
  'save-form', 'receive', 'receive-missed', 'repay-overdue',
  'del-payment', 'payedit-save', 'mark-overdue', 'back-normal',
  'to-legal', 'delegal', 'close-normal', 'settle-legal', 'reopen',
  'fill-closed', 'delete-loan', 'import-xlsx', 'export-xlsx',
  'cloud-sync-now', 'cloud-push-enable', 'cloud-set-key',
]);
let actionBusy = false;

document.getElementById('app').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (!WRITE_ACTIONS.has(el.dataset.action)) { fn(el); return; }
  if (actionBusy) return;
  actionBusy = true;
  const oldTxt = el.textContent;
  el.setAttribute('data-busy', '1');
  if (el.classList.contains('btn')) el.textContent = '處理中…';
  Promise.all([Promise.resolve().then(() => fn(el)), delay(800)])
    .catch(() => {})
    .finally(() => {
      actionBusy = false;
      if (el.isConnected) {
        el.removeAttribute('data-busy');
        if (el.classList.contains('btn')) el.textContent = oldTxt;
      }
    });
});

$importFile.addEventListener('change', async () => {
  const f = $importFile.files[0];
  $importFile.value = '';
  if (!f) return;
  const buf = await f.arrayBuffer();
  let result;
  try { result = parseXlsx(buf); }
  catch { alert('這個檔案讀不了，確認是本 App 匯出的 xlsx。'); return; }
  if (!result.ok) {
    alert('匯入失敗，資料沒有動：\n\n' + result.errors.slice(0, 10).join('\n') +
      (result.errors.length > 10 ? `\n…還有 ${result.errors.length - 10} 個錯` : ''));
    return;
  }
  const { loans, payments } = result.state;
  const ok = await confirmPanel({
    title: '匯入並取代全部資料？',
    lines: [`${loans.length} 筆借款、${payments.length} 筆收款`,
      { sub: '現在 App 裡的資料會被整批取代' }],
    ok: '匯入取代', danger: true,
  });
  if (!ok) return;
  result.state.lastExport = state.lastExport;
  state = result.state;
  save(state); go('home');
});

// service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// 只有真的有帳（或雲端帳戶確實存在）才上傳 —— 路人打開網頁不佔雲端名額
// 注意：lastSync 只代表連過線，不代表帳戶存在，不能拿來判斷
function shouldSync() {
  return state.loans.length > 0 || state.payments.length > 0 || !!cloud.meta().cloudExists;
}

// 雲端同步：每次存檔自動上傳（2 秒去抖動）
save.onSave = () => {
  if (!shouldSync()) return;
  cloud.schedulePush(() => state, () => {
    if (route.view === 'stats' || route.view === 'settings') render();
  });
};

// 開機：先畫本地（畫不出來就顯示救援訊息，不讓白屏卡死），再比對雲端，新的贏
// 一次性提示：舊版結清的帳沒有結清日，過去月報會少算
const noClosedDate = state.loans.filter(l => l.status === 'closed' && !l.closedDate);
if (noClosedDate.length && !localStorage.getItem('loanapp.closedNotice')) {
  localStorage.setItem('loanapp.closedNotice', '1');
  setTimeout(() => alert(
    `有 ${noClosedDate.length} 筆已結清的帳沒填結清日（${noClosedDate.map(l => l.name).join('、')}）。\n` +
    '到「借款 → 已結清」點進去 → 更多操作 → 補填結清日，過去月報才算得準。'), 800);
}

try {
  render();
} catch (e) {
  $view.innerHTML = '<div class="empty">本機資料有問題，正在從雲端救援…<br><br>連不上網的話請聯絡管理者。</div>';
  state = { version: 1, loans: [], payments: [], lastExport: null };
}
cloud.pull().then(r => {
  if (!r || !r.state) { if (shouldSync()) cloud.schedulePush(() => state); return; }
  const cloudAt = r.state.updatedAt || r.updatedAt || 0;
  if (cloudAt > (state.updatedAt || 0)) {
    state = r.state;
    save(state, false);
    render();
  } else if ((state.updatedAt || 0) > cloudAt && shouldSync()) {
    cloud.schedulePush(() => state);
  }
  if (cloud.meta().pending && shouldSync()) cloud.schedulePush(() => state);   // 上次沒傳完的補傳
}).catch(() => {});

// 斷線後補傳
window.addEventListener('online', () => {
  if (cloud.meta().pending && shouldSync()) cloud.schedulePush(() => state);
});
