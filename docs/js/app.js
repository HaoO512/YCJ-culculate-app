// 借貸管家 — 主程式（畫面渲染 + 操作）
import { load, save, newId } from './store.js';
import {
  parseDate, fmtDate, today, monthlyInterest, defaultReferral, DEFAULT_APPRAISAL,
  dueDateFor, nextDue, overduePeriods, overdueInterest, paidInMonth,
  prepaidUntil, settledInMonth, nextCollectDue,
  isActive, isProblem, stats, monthlySeries, money,
} from './calc.js';
import { downloadICS, downloadStopICS } from './ics.js';
import { exportXlsx, parseXlsx } from './xlsx-io.js';
import * as cloud from './cloud.js';

let state = load();
let route = { view: 'home' };          // home | people | detail | form | problems | stats
let calCursor = null;                  // {y, m} 月曆目前顯示的月份
let calSelected = null;                // 點選的日子（數字）

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

function go(view, params = {}) {
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

// ───────────────────────── 首頁 ─────────────────────────

function viewHome() {
  const now = today();
  if (!calCursor) calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = calCursor;
  const active = state.loans.filter(isActive);

  if (!active.length && !state.loans.length) {
    return `
      <div class="title-row"><h1 class="title">首頁</h1>
        <span class="date">今天 ${mdTxt(now)}</span></div>
      <div class="empty">還沒有借款記錄。<br><br>按下面的 <b style="color:var(--accent)">＋</b> 新增第一筆。</div>`;
  }

  // 本月每筆的收息資訊
  const dues = active.map(l => {
    const d = dueDateFor(y, m, l.dueDay);
    return {
      loan: l, day: d.getDate(),
      paid: settledInMonth(state.payments, l, y, m),
      problem: isProblem(l),
    };
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
      ? `<span class="dots">${dotsHere.map(x => `<i class="dot ${x.problem ? 'r' : 'g'}"></i>`).join('')}</span>`
      : '';
    const cls = ['day'];
    if (isThisMonth && d === now.getDate()) cls.push('today');
    if (calSelected === d) cls.push('sel');
    cells += `<button class="${cls.join(' ')}" data-action="pick-day" data-day="${d}">${d}${dots}</button>`;
  }

  // 下方清單（點日子則過濾）
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const listDues = calSelected ? dues.filter(x => x.day === calSelected) : dues;
  const rows = listDues.map(x => {
    const l = x.loan;
    const isTomorrow = isThisMonth && !x.paid && !x.problem &&
      x.day === tomorrow.getDate() && m === tomorrow.getMonth();
    const cls = x.problem ? 'slim alert' : (isTomorrow ? 'slim notice' : 'slim');
    const paidMark = x.paid ? '<span class="paid">✓</span>' : '';
    const label = x.problem ? '欠繳' : (isTomorrow ? '明天' : '');
    return `
      <button class="${cls}" data-action="open-loan" data-id="${l.id}">
        <span class="l"><small>${x.day}日${label ? '·' + label : ''}</small>${esc(l.name)}${paidMark}</span>
        <span class="r">${money(x.problem ? overdueInterest(l, now) : monthlyInterest(l))}</span>
      </button>`;
  }).join('');

  // 備份提醒：有資料且超過 30 天沒匯出（或從未匯出）
  let backupBanner = '';
  if (state.loans.length) {
    const days = state.lastExport
      ? Math.floor((now - parseDate(state.lastExport)) / 86400000)
      : null;
    if (days === null || days > 30) {
      backupBanner = `
        <button class="slim notice" data-action="export-xlsx">
          <span class="l">${days === null ? '還沒備份過' : `上次備份 ${days} 天前`}</span>
          <span class="r" style="font-size:18px">點我匯出 ›</span>
        </button>`;
    }
  }

  const st = stats(state, now);
  const alertRow = st.problemCount ? `
    <button class="slim alert" data-action="go" data-view="problems">
      <span class="l">欠繳 ${st.problemCount} 筆</span>
      <span class="r">${money(st.overdueInt)}</span>
    </button>` : '';

  return `
    <div class="title-row"><h1 class="title">首頁</h1>
      <span class="date">今天 ${mdTxt(now)}</span></div>
    ${backupBanner}
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
      <div class="cal-legend">
        <span><i class="dot g"></i>收息日</span>
        <span><i class="dot r"></i>欠繳</span>
        <span><i class="today-chip"></i>今天</span>
      </div>
    </div>

    <div class="rowlist">${rows || '<div class="empty">這天沒有要收的錢</div>'}</div>
    ${alertRow}
    ${st.monthDue ? `<div class="slim total"><span class="l">本月要收</span><span class="r">${money(st.monthDue)}</span></div>` : ''}
  `;
}

// ───────────────────────── 借款人列表 ─────────────────────────

function viewPeople() {
  const order = { overdue: 0, legal: 0, normal: 1, closed: 2 };
  const loans = [...state.loans].sort((a, b) =>
    (order[a.status] - order[b.status]) || a.name.localeCompare(b.name, 'zh-Hant'));

  const rows = loans.map(l => `
    <button class="person-row" data-action="open-loan" data-id="${l.id}">
      <span class="name">${esc(l.name)}</span>
      <span class="chip ${STATUS_CHIP[l.status]}">${STATUS_TXT[l.status]}</span>
      <span class="money">${money(monthlyInterest(l))}</span>
    </button>`).join('');

  return `
    <div class="title-row"><h1 class="title">借款人</h1>
      <span class="date">共 ${loans.length} 筆</span></div>
    <div class="rowlist">${rows || '<div class="empty">還沒有借款記錄</div>'}</div>`;
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
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 24);
  const payRows = pays.map(p => `
    <div class="h-row">
      <span>${mdTxt(parseDate(p.date))}</span>
      <span class="amount">${money(p.amount)}</span>
      <span class="ok-mark">✓</span>
      <button class="del" data-action="del-payment" data-id="${p.id}" aria-label="刪除">✕</button>
    </div>`).join('');

  let statusBlock = '';
  if (l.status === 'normal') {
    statusBlock = `
      <button class="btn green" data-action="receive" data-id="${l.id}" ${paid ? 'disabled' : ''}>
        ${byPrepaid ? '✓ 本月在預收範圍內' : paid ? '✓ 本月利息已收' : `收到 ${now.getMonth() + 1} 月利息了`}
      </button>
      <button class="btn outline-grey" data-action="ics-one" data-id="${l.id}">加到行事曆（每月提醒）</button>
      <div class="btn-pair">
        <button class="btn outline-red" data-action="mark-overdue" data-id="${l.id}">標記欠繳</button>
        <button class="btn outline-grey" data-action="close-normal" data-id="${l.id}">結清還本</button>
      </div>`;
  } else if (l.status === 'overdue' || l.status === 'legal') {
    const periods = overduePeriods(l, now);
    const accrued = overdueInterest(l, now);
    statusBlock = `
      <div class="card debt-sum">
        <p class="card-label" style="color:var(--red)">欠繳中${l.status === 'legal' ? '（法院處理）' : ''}</p>
        <p class="num">${money(l.principal + accrued)}</p>
        <p class="sub">本金 ${money(l.principal)} ＋ 欠 ${periods} 期利息 ${money(accrued)}（${mdTxt(parseDate(l.overdueSince))} 起算）</p>
      </div>
      <button class="btn green" data-action="repay-overdue" data-id="${l.id}">收到補繳，記一筆</button>
      <button class="btn outline-grey" data-action="ics-stop" data-id="${l.id}">停止行事曆提醒</button>
      <div class="btn-pair">
        ${l.status === 'overdue'
          ? `<button class="btn outline-red" data-action="to-legal" data-id="${l.id}">進法院</button>
             <button class="btn outline-grey" data-action="back-normal" data-id="${l.id}">恢復正常</button>`
          : `<button class="btn outline-red" data-action="settle-legal" data-id="${l.id}">結案（填實拿多少）</button>
             <button class="btn outline-grey" data-action="back-normal" data-id="${l.id}">恢復正常</button>`}
      </div>`;
  } else {
    statusBlock = `
      <div class="card">
        <div class="kv">
          <div><span class="k">狀態</span><span class="v">已結清</span></div>
          ${l.finalReceived != null ? `<div><span class="k">結案實收</span><span class="v">${money(l.finalReceived)}</span></div>` : ''}
          ${l.writeoff ? `<div><span class="k">壞帳沖銷</span><span class="v red">${money(l.writeoff)}</span></div>` : ''}
        </div>
      </div>
      <button class="btn outline-grey" data-action="ics-stop" data-id="${l.id}">停止行事曆提醒</button>`;
  }

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

    ${statusBlock}

    <div class="card">
      <div class="kv">
        <div><span class="k">本金</span><span class="v">${money(l.principal)}</span></div>
        <div><span class="k">月利率</span><span class="v">${l.rate}%</span></div>
        <div><span class="k">借款日期</span><span class="v">${l.startDate}</span></div>
        ${l.prepaidMonths ? `<div><span class="k">簽約預收</span><span class="v">${l.prepaidMonths} 個月（至 ${pu ? mdTxt(pu) : ''}）</span></div>` : ''}
        <div><span class="k">介紹費</span><span class="v">${money(l.referralFee || 0)}</span></div>
        <div><span class="k">代書費</span><span class="v">${money(l.appraisalFee || 0)}</span></div>
        ${l.note ? `<div><span class="k">備註</span><span class="v" style="font-weight:600">${esc(l.note)}</span></div>` : ''}
      </div>
    </div>

    <p class="section-h">收款記錄</p>
    <div class="card history">${payRows || '<div class="empty" style="padding:14px">還沒收過款</div>'}</div>

    <button class="btn outline-grey" data-action="edit" data-id="${l.id}">編輯這筆借款</button>
  `;
}

// ───────────────────────── 新增／編輯 ─────────────────────────

function viewForm() {
  const editing = route.id ? loanById(route.id) : null;
  const l = editing || {
    name: '', principal: '', rate: 2,
    startDate: fmtDate(today()), dueDay: today().getDate() > 28 ? 'EOM' : today().getDate(),
    prepaidMonths: 3, referralFee: '', appraisalFee: DEFAULT_APPRAISAL, note: '',
  };
  const pm = l.prepaidMonths ?? 0;
  const pmOptions = [0, 1, 2, 3, 4, 5, 6].map(n =>
    `<option value="${n}"${pm === n ? ' selected' : ''}>${n === 0 ? '不預收' : n + ' 個月'}</option>`).join('');

  const dayOptions = ['<option value="EOM"' + (l.dueDay === 'EOM' ? ' selected' : '') + '>月底</option>'];
  for (let d = 1; d <= 28; d++) {
    dayOptions.push(`<option value="${d}"${l.dueDay === d ? ' selected' : ''}>${d} 號</option>`);
  }

  return `
    <div class="backrow">
      <button class="back" data-action="back">‹</button>
      <h1>${editing ? '編輯借款' : '新增借款'}</h1>
    </div>

    <div class="field"><label>借款人姓名</label>
      <input id="f-name" value="${esc(l.name)}" placeholder="王小明"></div>
    <div class="field"><label>本金</label>
      <input id="f-principal" inputmode="numeric" value="${l.principal}" placeholder="600000"></div>
    <div class="field"><label>月利率 %（1.5–2）</label>
      <input id="f-rate" inputmode="decimal" value="${l.rate}"></div>
    <div class="field"><label>借款日期</label>
      <input id="f-start" type="date" value="${l.startDate}"></div>
    <div class="field"><label>收息日（每月幾號）</label>
      <select id="f-dueday">${dayOptions.join('')}</select>
      <span class="hint">29–31 號請選「月底」，小月才不會漏</span></div>
    <div class="field"><label>簽約預收利息</label>
      <select id="f-prepaid">${pmOptions}</select>
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
    ${editing ? '<button class="btn outline-red" data-action="delete-loan" data-id="' + editing.id + '">刪除這筆借款</button>' : ''}
  `;
}

function refreshFormCalc() {
  const box = document.getElementById('f-calc');
  if (!box) return;
  const principal = Number(document.getElementById('f-principal').value) || 0;
  const rate = Number(document.getElementById('f-rate').value) || 0;
  const mi = Math.round(principal * rate / 100);
  const pmSel = Number(document.getElementById('f-prepaid')?.value) || 0;
  box.innerHTML = `
    <div><span class="k">每月利息</span><span class="v">${money(mi)}</span></div>
    ${pmSel ? `<div><span class="k">簽約當天收（${pmSel} 個月息）</span><span class="v">${money(mi * pmSel)}</span></div>` : ''}
    <div><span class="k">介紹費（半個月息）</span><span class="v">${money(Math.round(mi / 2))}</span></div>
    <div><span class="k">代書費</span><span class="v">${money(Number(document.getElementById('f-appraisal').value) || 0)}</span></div>`;
  const ref = document.getElementById('f-referral');
  if (ref && !ref.dataset.touched) ref.value = Math.round(mi / 2) || '';
}

function saveForm(id) {
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
  if (!(principal > 0)) errs.push('本金要是正數');
  if (!(rate > 0 && rate <= 20)) errs.push('月利率不合理');
  if (!startDate) errs.push('借款日期要填');
  if (errs.length) { alert(errs.join('\n')); return; }

  if (id) {
    Object.assign(loanById(id), { name, principal, rate, startDate, dueDay, prepaidMonths, referralFee, appraisalFee, note });
    save(state); go('detail', { id });
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
      state.payments.push({ id: newId(), loanId: loan.id, date: startDate, amount: mi * prepaidMonths });
    }
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
  const cards = probs.map(l => {
    const periods = overduePeriods(l, now);
    const accrued = overdueInterest(l, now);
    return `
      <div class="card debt-card" data-action="open-loan" data-id="${l.id}">
        <div class="top">
          <span class="who">${esc(l.name)}</span>
          <span class="chip bad">${STATUS_TXT[l.status]}</span>
        </div>
        <div class="kv">
          <div><span class="k">未還本金</span><span class="v">${money(l.principal)}</span></div>
          <div><span class="k">已欠</span><span class="v red">${periods} 期</span></div>
          <div><span class="k">累計欠息</span><span class="v red">${money(accrued)}</span></div>
          <div><span class="k">停繳日</span><span class="v">${l.overdueSince || '—'}</span></div>
        </div>
        ${l.note ? `<p class="debt-note">${esc(l.note)}</p>` : ''}
      </div>`;
  }).join('');

  const st = stats(state, now);
  return `
    <div class="title-row"><h1 class="title">問題帳</h1>
      ${probs.length ? `<span class="chip bad">${probs.length} 筆</span>` : ''}</div>
    ${cards || '<div class="empty">目前沒有欠繳，很好 👍</div>'}
    ${probs.length ? `
      <div class="card debt-sum">
        <p class="card-label" style="color:var(--red)">欠繳總額</p>
        <p class="num">${money(st.overdueTotal)}</p>
        <p class="sub">本金 ${money(st.overduePrincipal)} ＋ 欠息 ${money(st.overdueInt)}</p>
      </div>` : ''}
  `;
}

// ───────────────────────── 統計 ─────────────────────────

function viewStats() {
  const now = today();
  const st = stats(state, now);
  const series = monthlySeries(state.payments, now, 7);
  const max = Math.max(...series.map(s => s.total), 1);
  const bars = series.map((s, i) => {
    const isNow = i === series.length - 1;
    const h = Math.round(s.total / max * 100);
    return `<div class="bar${isNow ? ' now' : ''}"><i style="height:${h}%"></i><b>${s.month + 1}月</b></div>`;
  }).join('');

  const activeCount = state.loans.filter(isActive).length;
  const backupTxt = state.lastExport
    ? `上次匯出：${state.lastExport}`
    : '還沒匯出過，建議定期匯出備份';

  return `
    <div class="title-row"><h1 class="title">統計</h1>
      <span class="date">${now.getFullYear()}年${now.getMonth() + 1}月</span></div>

    <div class="card">
      <p class="card-label">每月收到的利息</p>
      <div class="bars">${bars}</div>
    </div>

    <div class="stat-grid">
      <div class="stat wide"><p class="k">放出本金（${activeCount} 筆）</p><p class="n">${money(st.principalOut)}</p></div>
      <div class="stat"><p class="k">今年已收利息</p><p class="n green">${money(st.yearReceived)}</p></div>
      <div class="stat"><p class="k">本月已收</p><p class="n green">${money(st.monthReceived)}</p></div>
      <div class="stat"><p class="k">介紹費累計</p><p class="n">${money(st.referralTotal)}</p></div>
      <div class="stat"><p class="k">代書費累計</p><p class="n">${money(st.appraisalTotal)}</p></div>
      <div class="stat wide"><p class="k">淨收入（歷史利息 − 費用）</p><p class="n green">${money(st.net)}</p></div>
      <div class="stat"><p class="k">欠繳總額</p><p class="n red">${money(st.overdueTotal)}</p></div>
      <div class="stat"><p class="k">壞帳沖銷</p><p class="n">${money(st.writeoffTotal)}</p></div>
    </div>

    <div class="card">
      <p class="card-label">雲端同步</p>
      <div class="kv">
        <div><span class="k">狀態</span><span class="v">${syncStatusTxt()}</span></div>
        <div><span class="k">自動提醒</span><span class="v">${cloud.meta().pushOn ? '已開啟' : '未開啟'}</span></div>
      </div>
    </div>
    <button class="btn accent" data-action="cloud-sync-now">立刻同步</button>
    ${cloud.meta().pushOn
      ? '<button class="btn outline-grey" data-action="cloud-push-test">測試提醒（馬上跳一則通知）</button>'
      : '<button class="btn accent" data-action="cloud-push-enable">開啟自動提醒（免行事曆）</button>'}
    <div class="btn-pair">
      <button class="btn outline-grey" data-action="cloud-show-key">顯示同步金鑰</button>
      <button class="btn outline-grey" data-action="cloud-set-key">輸入金鑰連線</button>
    </div>
    <button class="btn outline-grey" data-action="ics-all">全部加到行事曆</button>
    <button class="btn outline-grey" data-action="export-xlsx">匯出 Excel 檔（備份／傳電腦）</button>
    <button class="btn outline-grey" data-action="import-xlsx">匯入 Excel 檔</button>
    <p class="hint" style="text-align:center;color:var(--sub);font-size:15px;margin:0">${backupTxt}</p>
  `;
}

function syncStatusTxt() {
  const m = cloud.meta();
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
};

function renderTabbar() {
  const probCount = state.loans.filter(isProblem).length;
  const active = v => (route.view === v || (v === 'home' && route.view === 'detail')) ? ' active' : '';
  $tabbar.innerHTML = `
    <button class="tab${active('home')}" data-action="go" data-view="home">${ICONS.home}首頁</button>
    <button class="tab${active('people')}" data-action="go" data-view="people">${ICONS.people}借款人</button>
    <button class="tab add" data-action="go" data-view="form">
      <span class="fab">${ICONS.plus}</span>新增</button>
    <button class="tab${active('problems')}" data-action="go" data-view="problems">
      <span class="badge-dot">${ICONS.warn}${probCount ? `<span class="n">${probCount}</span>` : ''}</span>問題帳</button>
    <button class="tab${active('stats')}" data-action="go" data-view="stats">${ICONS.chart}統計</button>`;
}

// ───────────────────────── 渲染 ─────────────────────────

function render() {
  const views = {
    home: viewHome, people: viewPeople, detail: viewDetail,
    form: viewForm, problems: viewProblems, stats: viewStats,
  };
  $view.innerHTML = (views[route.view] || viewHome)();
  renderTabbar();
  if (route.view === 'form') {
    refreshFormCalc();
    for (const id of ['f-principal', 'f-rate', 'f-appraisal']) {
      document.getElementById(id).addEventListener('input', refreshFormCalc);
    }
    document.getElementById('f-prepaid').addEventListener('change', refreshFormCalc);
    document.getElementById('f-referral').addEventListener('input', e => { e.target.dataset.touched = '1'; });
    const startEl = document.getElementById('f-start');
    startEl.addEventListener('change', () => {
      const d = startEl.value ? Number(startEl.value.split('-')[2]) : null;
      if (d) document.getElementById('f-dueday').value = d > 28 ? 'EOM' : String(d);
    });
  }
}

// ───────────────────────── 操作 ─────────────────────────

const actions = {
  go(el) {
    if (el.dataset.view === 'home') { calSelected = null; calCursor = null; }
    go(el.dataset.view);
  },
  back() { history.length > 1 ? go(routeBack()) : go('home'); },
  'open-loan'(el) { go('detail', { id: el.dataset.id }); },
  edit(el) { go('form', { id: el.dataset.id }); },
  'save-form'(el) { saveForm(el.dataset.id || null); },

  'pick-day'(el) {
    const d = Number(el.dataset.day);
    calSelected = calSelected === d ? null : d;
    render();
  },
  'cal-prev'() { shiftMonth(-1); },
  'cal-next'() { shiftMonth(1); },
  'cal-today'() { calCursor = null; calSelected = null; render(); },

  receive(el) {
    const l = loanById(el.dataset.id);
    const mi = monthlyInterest(l);
    if (!confirm(`記一筆：今天收到 ${l.name} 利息 ${money(mi)}？`)) return;
    state.payments.push({ id: newId(), loanId: l.id, date: fmtDate(today()), amount: mi });
    commit();
  },
  'del-payment'(el) {
    const p = state.payments.find(x => x.id === el.dataset.id);
    if (!p) return;
    if (!confirm(`刪掉這筆收款記錄（${p.date} ${money(p.amount)}）？`)) return;
    state.payments = state.payments.filter(x => x.id !== p.id);
    commit();
  },

  'mark-overdue'(el) {
    const l = loanById(el.dataset.id);
    const d = prompt('從哪天開始停繳？（格式 2026-08-04）', fmtDate(today()));
    if (!d) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) { alert('日期格式要像 2026-08-04'); return; }
    l.status = 'overdue'; l.overdueSince = d.trim();
    commit();
    alert('已列入問題帳。\n記得按「停止行事曆提醒」，每月提醒才會停。');
  },
  'back-normal'(el) {
    const l = loanById(el.dataset.id);
    if (!confirm(`${l.name} 恢復正常收息？（欠繳記錄清除）`)) return;
    l.status = 'normal'; l.overdueSince = null;
    commit();
  },
  'to-legal'(el) {
    const l = loanById(el.dataset.id);
    if (!confirm(`${l.name} 進入法院程序？`)) return;
    l.status = 'legal';
    commit();
  },
  'repay-overdue'(el) {
    const l = loanById(el.dataset.id);
    const accrued = overdueInterest(l, today());
    const v = prompt(`收到多少？（目前累計欠息 ${money(accrued)}）`, String(accrued));
    if (v == null) return;
    const amount = Number(v);
    if (!(amount > 0)) { alert('金額要是正數'); return; }
    state.payments.push({ id: newId(), loanId: l.id, date: fmtDate(today()), amount });
    commit();
  },
  'settle-legal'(el) {
    const l = loanById(el.dataset.id);
    const now = today();
    const owed = l.principal + overdueInterest(l, now);
    const v = prompt(`結案最後實拿多少？\n（應收 = 本金＋欠息 = ${money(owed)}）`, String(owed));
    if (v == null) return;
    const got = Number(v);
    if (!(got >= 0)) { alert('金額不對'); return; }
    l.finalReceived = got;
    l.writeoff = Math.max(0, owed - got);
    l.status = 'closed';
    commit();
    alert(`結案。${l.writeoff ? `壞帳沖銷 ${money(l.writeoff)} 已記入統計。` : '全額收回，沒有壞帳。'}\n記得按「停止行事曆提醒」。`);
  },
  'close-normal'(el) {
    const l = loanById(el.dataset.id);
    if (!confirm(`${l.name} 還清本金 ${money(l.principal)}，結清這筆借款？`)) return;
    l.status = 'closed';
    commit();
    alert('已結清。記得按「停止行事曆提醒」，每月提醒才會停。');
  },
  'delete-loan'(el) {
    const l = loanById(el.dataset.id);
    if (!confirm(`確定刪除 ${l.name} 這筆借款？收款記錄也會一起刪。`)) return;
    if (!confirm('再確認一次：刪了就救不回來（除非有 Excel 備份）。')) return;
    state.loans = state.loans.filter(x => x.id !== l.id);
    state.payments = state.payments.filter(p => p.loanId !== l.id);
    save(state); go('people');
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
    } catch { alert('連不上雲端，檢查網路或金鑰。'); }
  },
};

function routeBack() {
  return route.view === 'form' && route.id ? 'detail' : 'home';
}

function shiftMonth(delta) {
  const now = today();
  if (!calCursor) calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const d = new Date(calCursor.y, calCursor.m + delta, 1);
  calCursor = { y: d.getFullYear(), m: d.getMonth() };
  calSelected = null;
  render();
}

document.getElementById('app').addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el);
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
  if (!confirm(`讀到 ${loans.length} 筆借款、${payments.length} 筆收款。\n匯入會「整批取代」現在的資料，確定？`)) return;
  result.state.lastExport = state.lastExport;
  state = result.state;
  save(state); go('home');
});

// service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// 雲端同步：每次存檔自動上傳（2 秒去抖動）
save.onSave = () => cloud.schedulePush(() => state, () => {
  if (route.view === 'stats') render();
});

// 開機：先畫本地，再比對雲端，新的贏
render();
cloud.pull().then(r => {
  if (!r || !r.state) { cloud.schedulePush(() => state); return; }
  const cloudAt = r.state.updatedAt || r.updatedAt || 0;
  if (cloudAt > (state.updatedAt || 0)) {
    state = r.state;
    save(state, false);
    render();
  } else if ((state.updatedAt || 0) > cloudAt) {
    cloud.schedulePush(() => state);
  }
}).catch(() => {});

// 斷線後補傳
window.addEventListener('online', () => {
  if (cloud.meta().pending) cloud.schedulePush(() => state);
});
