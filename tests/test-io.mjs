// ics.js buildICS + xlsx-io.js 來回測試（node 環境）
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
globalThis.XLSX = require('../docs/vendor/xlsx.full.min.js');

const { buildICS } = await import('../docs/js/ics.js');
const { exportXlsx, parseXlsx } = await import('../docs/js/xlsx-io.js');

// ── ICS ──
const loan = {
  id: 'abc123', name: '陳大文', principal: 500000, rate: 2,
  startDate: '2025-03-05', dueDay: 5, status: 'normal',
  overdueSince: null, referralFee: 5000, appraisalFee: 3000, note: '',
};
const ics = buildICS([loan]);
assert.ok(ics.includes('RRULE:FREQ=MONTHLY;BYMONTHDAY=5'));
assert.ok(ics.includes('SUMMARY:收陳大文利息 $10\\,000'));
assert.ok(ics.includes('TRIGGER:-PT14H30M'));
assert.ok(ics.includes('TRIGGER:PT9H30M'));
assert.ok(ics.includes('UID:loan-abc123@loanapp'));
assert.ok(/DTSTART;VALUE=DATE:\d{8}/.test(ics));

const eom = buildICS([{ ...loan, dueDay: 'EOM' }]);
assert.ok(eom.includes('BYMONTHDAY=-1'));

// ── xlsx 來回 ──
process.chdir(require('node:os').tmpdir());
// node 沒有瀏覽器下載機制，墊一層 writeFile
XLSX.writeFile = (wb, name) =>
  fs.writeFileSync(name, Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
const state = {
  version: 1,
  loans: [
    loan,
    { id: 'bad1', name: '張建國', principal: 400000, rate: 2, startDate: '2025-11-10',
      dueDay: 10, status: 'overdue', overdueSince: '2026-05-10',
      referralFee: 4000, appraisalFee: 3000, note: '已提告', finalReceived: null, writeoff: null },
  ],
  payments: [
    { id: 'p1', loanId: 'abc123', date: '2026-07-05', amount: 10000 },
  ],
  tombstones: [
    { id: 'dead1', name: '已刪甲', dueDay: 7, startDate: '2025-06-07' },
    { id: 'dead2', name: '已刪乙', dueDay: 'EOM', startDate: '2025-09-30' },
  ],
  lastExport: null,
};
exportXlsx(state);
const file = fs.readdirSync('.').find(f => f.startsWith('借貸帳本-'));
assert.ok(file, '匯出檔存在');
const buf = fs.readFileSync(file);
const r = parseXlsx(new Uint8Array(buf).buffer);
assert.equal(r.ok, true, JSON.stringify(r.errors));
assert.equal(r.state.loans.length, 2);
assert.equal(r.state.payments.length, 1);
const l0 = r.state.loans.find(l => l.id === 'abc123');
assert.equal(l0.name, '陳大文');
assert.equal(l0.principal, 500000);
assert.equal(l0.rate, 2);
assert.equal(l0.dueDay, 5);
assert.equal(l0.status, 'normal');
const l1 = r.state.loans.find(l => l.id === 'bad1');
assert.equal(l1.status, 'overdue');
assert.equal(l1.overdueSince, '2026-05-10');
assert.equal(l1.note, '已提告');
assert.equal(r.state.payments[0].amount, 10000);

// 墓碑 Excel 往返：系統資料表保存、匯入還原
assert.equal((r.state.tombstones || []).length, 2, '墓碑往返不遺失');
const t1 = r.state.tombstones.find(t => t.id === 'dead1');
assert.equal(t1.name, '已刪甲');
assert.equal(t1.dueDay, 7);
assert.equal(t1.startDate, '2025-06-07');
assert.equal(r.state.tombstones.find(t => t.id === 'dead2').dueDay, 'EOM');

// 錯誤資料要被擋下
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
  { '編號': 'x', '姓名': '', '本金': -5, '月利率%': 99, '借款日期': 'aaa', '收息日': 31, '狀態': '亂寫' },
]), '借款主表');
const badBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
const rb = parseXlsx(badBuf);
assert.equal(rb.ok, false);
assert.ok(rb.errors.length >= 5, rb.errors.join('|'));

// 舊版 Excel 帶「代書費」欄：照常匯入、不建立 appraisalFee、不報錯
{
  const wbOld = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbOld, XLSX.utils.json_to_sheet([{
    '編號': 'old1', '姓名': '舊格式', '本金': 100000, '月利率%': 2,
    '借款日期': '2026-01-05', '收息日': 5, '狀態': '正常', '代書費': 3000,
  }]), '借款主表');
  const oldBuf = XLSX.write(wbOld, { type: 'array', bookType: 'xlsx' });
  const ro = parseXlsx(oldBuf);
  assert.equal(ro.ok, true, JSON.stringify(ro.errors));
  const ol = ro.state.loans[0];
  assert.equal(ol.name, '舊格式');
  assert.ok(!('appraisalFee' in ol), '舊代書費欄被忽略，不建立欄位');
}

fs.unlinkSync(file);
console.log('ics + xlsx 全部通過');
