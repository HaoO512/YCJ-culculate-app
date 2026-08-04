// .ics 行事曆檔產生：每筆借款一個每月重複事件，前一天 09:00 + 當天 09:00 提醒
import { monthlyInterest, nextDue, today, money } from './calc.js';

function pad(n) { return String(n).padStart(2, '0'); }

function icsDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function vevent(loan) {
  const start = nextDue(loan, today());
  const byday = loan.dueDay === 'EOM' ? '-1' : String(loan.dueDay);
  const title = `收${loan.name}利息 ${money(monthlyInterest(loan))}`;
  return [
    'BEGIN:VEVENT',
    `UID:loan-${loan.id}@loanapp`,
    `DTSTAMP:${icsDate(today())}T000000Z`,
    `DTSTART;VALUE=DATE:${icsDate(start)}`,
    `RRULE:FREQ=MONTHLY;BYMONTHDAY=${byday}`,
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
