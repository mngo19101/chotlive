import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as price from '../public/js/price.js';
import { summarizeGroup } from '../public/js/vtp-export.js';

const { isOnlyCodes, parsePrice } = price;
const parseMoneyInput = (text) => price.parseMoneyInput(text);

test('chỉ ghi mã mới tính là chốt đơn, có số thôi thì không', () => {
  for (const text of ['280', 'mã 150, 180', '150k', 'Mã 120 và 180']) assert.equal(isOnlyCodes(text), true, text);
  for (const text of ['Mã 130 giá sao', '35 tuổi', 'Cho em xem mã 25 với', '0905123456', 'sz 38 mã 250', '', 'hello'])
    assert.equal(isOnlyCodes(text), false, text);
});

// BL-12: bộ vector dùng chung. Android (LogicTest.kt) và iOS (PriceParserTests.swift) giữ đúng danh sách này.
const PRICE_VECTORS = [
  ['chốt mã 150 sđt 0912 345 678', 150000],
  ['lấy 150 0912.345.678', 150000],
  ['150 sđt 0912-345-678', 150000],
  ['sđt 098.812.3456 lấy 250', 250000],
  ['0988 123 456 mã 99', 99000],
  ['024 3826 1234 mã 120', 120000],
  ['+84 912 345 678 mã 150', 150000],
  ['0912345678 150', 150000],
  ['0912 345 678', null],
  ['2.500k', 2500000],
  ['1,200k', 1200000],
  ['1.5k', 1500],
  ['150k', 150000],
  ['150 k', 150000],
  ['1.5tr', 1500000],
  ['150,000', 150000],
  ['150.000đ', 150000],
  ['1.200.000', 1200000],
  ['1,5tr', 1500000],
  ['Chốt 120 với 180', 180000],
  ['lấy 2 cái 150', 150000],
  ['mã 090 150 180', 180000],
  ['cho em xin giá', null],
  ['', null],
];

test('BL-12: số điện thoại không thành giá, nhóm nghìn kèm k nhân đủ', () => {
  for (const [text, price] of PRICE_VECTORS) assert.equal(parsePrice(text), price, text);
});

// Size và số lượng không phải giá. Android (LogicTest.kt) và iOS (PriceParserTests.swift) giữ đúng danh sách này.
const SIZE_QTY_VECTORS = [
  ['size 38 0912 345 678', null],
  ['size 38', null],
  ['sz 38 mã 250', 250000],
  ['size: 40 lấy 150', 150000],
  ['lấy 2 cái', null],
  ['chốt 2 cái 150', 150000],
  ['lấy 2 cái 150', 150000],
  ['sl 2', null],
  ['số lượng: 3 mã 120', 120000],
  ['50 kg', null],
  ['nặng 50 kg mã 199', 199000],
  ['mã 99 bộ đồ', 99000],
  ['150 cái', 150000],
  ['38', 38000],
];

test('size và số lượng không thành giá', () => {
  for (const [text, price] of SIZE_QTY_VECTORS) assert.equal(parsePrice(text), price, text);
});

test('BL-14a: ô sửa giá món đọc giá như ô Tạo đơn (nhân hệ số, nhận k, nhóm nghìn)', () => {
  for (const [text, v] of [['150', 150000], ['150k', 150000], ['150.000đ', 150000], ['1.5tr', 1500000]])
    assert.equal(price.parsePriceInput(text, 1000), v, text);
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const handler = app.slice(app.indexOf("e.target.classList.contains('item-edit-price')"));
  assert.match(handler.slice(0, 300), /parsePriceInput\(e\.target\.value, priceOpts\(\)\.multiplier\)/);
});

test('BL-12: số điện thoại viết tách không làm bình luận thành "chỉ ghi mã"', () => {
  for (const text of ['0912 345 678', '0912.345.678', '150 0912 345 678']) assert.equal(isOnlyCodes(text), false, text);
  assert.equal(isOnlyCodes('mã 150'), true);
});

test('BL-13: ô tiền đọc dấu chấm/phẩy là nhóm nghìn, số thuần là đồng', () => {
  const cases = [
    ['150.000', 150000],
    ['150,000', 150000],
    ['150.000đ', 150000],
    ['150 000', 150000],
    ['150000', 150000],
    ['150k', 150000],
    ['150 k', 150000],
    ['2.500k', 2500000],
    ['1.5tr', 1500000],
    ['150', 150],
    ['0', 0],
    ['', null],
    ['   ', null],
    ['-150000', null],
    ['150.5', null],
    ['abc', null],
    ['1e5', null],
  ];
  for (const [text, v] of cases) assert.equal(parseMoneyInput(text), v, JSON.stringify(text));
});

test('BL-13: gõ "150.000" vào ô COD cho thu hộ 150.000đ, không phải 17.150đ', () => {
  const order = {
    id: 'o1',
    uniqueId: 'lan.anh',
    status: 'new',
    items: [{ name: 'Mã 24', price: 150000, qty: 1 }],
    ship: { state: 'ready', pay: 'cod', payer: 'receiver', codOverride: parseMoneyInput('150.000') },
  };
  assert.equal(summarizeGroup({ orders: [order], customer: {} }).cod, 150000);
});

test('BL-13: ô COD và tiền cọc trên web là ô chữ, để trình duyệt không tự đọc "150.000" thành 150', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['ship-cod', 'ship-deposit']) {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] || '';
    assert.match(tag, /type="text"/, id);
  }
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const moneyInput = \(el\) => parseMoneyInput\(el\.value\);/);
});
