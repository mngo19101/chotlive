import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as price from '../public/js/price.js';
import { summarizeGroup } from '../public/js/vtp-export.js';

const { isOnlyCodes, parsePrice } = price;
const parseMoneyInput = (text) => price.parseMoneyInput(text);

test('"L40" (lấy 40) là giá 40.000, "sl40"/"xl40" thì không', () => {
  for (const [text, v] of [['L40', 40000], ['l40', 40000], ['chốt L40', 40000], ['L 40', 40000], ['L150k', 150000], ['sl40', null], ['xl40', null]])
    assert.equal(parsePrice(text), v, text);
  for (const text of ['L40', 'L 40', 'L40, L50']) assert.equal(isOnlyCodes(text), true, text);
});

// Android (LogicTest.kt) và iOS (PriceParserTests.swift) giữ đúng danh sách này.
const GLUED_VECTORS = [
  ['30L', 30000], ['30l', 30000], ['chốt 30L', 30000], ['30M', 30000], ['30XL', 30000], ['ao30', 30000],
  ['chot30', 30000], ['áo 30L size M', 30000], ['L5', 5000], ['150ka', 150000], ['150 200', 200000], ['150 2', 150000],
  ['size38', null], ['1m6', null], ['cao 1m65', null], ['45kg', null], ['8h', null], ['35t', null], ['30%', null],
  ['2k3', null], ['mix2', null], ['x2', null], ['350k x2', 350000], ['35 tuổi', null], ['giao 3 ngày', null],
  ['mã a12', null], ['ma30', 30000],
];

test('số dính chữ vẫn là giá ("30L", "ao30"), trừ size, số lượng, cân nặng, giờ, tuổi, phần trăm', () => {
  for (const [text, v] of GLUED_VECTORS) assert.equal(parsePrice(text), v, text);
  for (const text of ['30L', '30L 40L']) assert.equal(isOnlyCodes(text), true, text);
});

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
  ['1 triệu 2', 1200000],
  ['1 triệu 250', 1250000],
  ['1tr 2 cái', 1000000],
  ['1tr 200k', 1000000],
  ['giá 1 triệu.', 1000000],
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

test('số lượng: giá 1-2 chữ số sau "chốt/lấy" không bị đọc thành số lượng ("chốt 99" là 1 cái 99k)', () => {
  const qty = (text) => price.extractProductInfo(text, parsePrice(text)).quantity;
  for (const text of ['chốt 99', 'chốt 50', 'lấy 85', 'cho em 99', 'chốt 5', 'mua 45k', 'chốt 99k']) assert.equal(qty(text), 1, text);
  assert.equal(qty('chốt 2 cái 99'), 2);
  assert.equal(qty('lấy 2 cái 120'), 2);
  assert.equal(qty('chốt 2cái 99'), 2);
  assert.equal(qty('chốt 2 áo 150k'), 2);
  assert.equal(qty('chốt 2 99k'), 2);
  assert.equal(qty('350k x2'), 2);
  assert.equal(qty('350k x 3'), 3);
  assert.equal(qty('mix2 150k'), 1);
});

test('tên món: số sau "mã" giữ lại làm tên, giá có dấu vẫn được bỏ khỏi tên', () => {
  const name = (text) => price.extractProductInfo(text, parsePrice(text)).productName;
  assert.equal(name('Chốt mã 268'), 'Mã 268');
  assert.equal(name('chốt mã 15 giá 250k'), 'Mã 15');
  assert.equal(name('đầm hoa 350 size L'), 'Đầm hoa size L');
  assert.equal(name('chốt áo 150k'), 'Áo');
  assert.equal(name('chốt áo 1 triệu 2'), 'Áo');
  assert.equal(name('váy 150.000đ'), 'Váy');
});

test('in tem trên web đọc lại số lượng từ nội dung bình luận, không tin số lượng đã lưu', () => {
  const src = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function printSingleComment'), src.indexOf('async function handlePrintOrder'));
  assert.match(body, /qty: extractProductInfo\(/);
  assert.doesNotMatch(body, /qty: c\.qty/);
});
