// .ics 行事曆檔產生：每筆借款一個每月重複事件，前一天 09:00 + 當天 09:00 提醒
import { monthlyInterest, nextCollectDue, today, money } from './calc.js';

function pad(n) { return String(n).padStart(2, '0'); }

function icsDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

// 每月重複規則：29/30 → 當月沒該號自動退到月底（BYSETPOS 取候選日中最後一個存在的）
function rruleFor(dueDay, until) {
  let core;
  if (dueDay === 'EOM' || dueDay === 31) core = 'FREQ=MONTHLY;BYMONTHDAY=-1';
  else if (dueDay >= 29) {
    const days = [];
    for (let d = 28; d <= dueDay; d++) days.push(d);
    core = `FREQ=MONTHLY;BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
  } else core = `FREQ=MONTHLY;BYMONTHDAY=${dueDay}`;
  return 'RRULE:' + core + (until ? `;UNTIL=${until}` : '');
}

function vevent(loan) {
  const start = nextCollectDue(loan, today());
  const title = `收${loan.name}利息 ${money(monthlyInterest(loan))}`;
  return [
    'BEGIN:VEVENT',
    `UID:loan-${loan.id}@loanapp`,
    `DTSTAMP:${icsDate(today())}T000000Z`,
    `SEQUENCE:${Math.floor(Date.now() / 1000)}`,
    `DTSTART;VALUE=DATE:${icsDate(start)}`,
    rruleFor(loan.dueDay),
    `SUMMARY:${esc(title)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc('明天要' + title)}`,
    'TRIGGER:-PT14H30M',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc('今天要' + title)}`,
    'TRIGGER:PT9H30M',
    'END:VALARM',
    'END:VEVENT',
  ];
}

// 停止提醒：同一個 UID、重複規則結束日設在昨天 → 行事曆把整串更新成「已結束」，之後不再跳
export function buildStopICS(loan) {
  const now = today();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const start = loan.startDate ? loan.startDate.replace(/-/g, '') : icsDate(yesterday);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//loanapp//億起記//TW',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:loan-${loan.id}@loanapp`,
    `DTSTAMP:${icsDate(now)}T120000Z`,
    `SEQUENCE:${Math.floor(Date.now() / 1000) + 100}`,
    `DTSTART;VALUE=DATE:${start}`,
    rruleFor(loan.dueDay, icsDate(yesterday)),
    `SUMMARY:${esc(`（已停止）收${loan.name}利息`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}

export function downloadStopICS(loan) {
  const blob = new Blob([buildStopICS(loan)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `停止提醒-${loan.name}.ics`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}

export function buildICS(loans) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//loanapp//借貸管家//TW',
    'CALSCALE:GREGORIAN',
  ];
  for (const l of loans) lines.push(...vevent(l));
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export function downloadICS(loans, filename) {
  const blob = new Blob([buildICS(loans)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
