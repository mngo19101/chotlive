import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Viettel Post giả: tạo đơn trả về mã phường họ "hiểu" tuỳ địa chỉ, huỷ đơn ghi lại.
const calls = [];
const WARDS = [
  { WARDS_ID: 7969, WARDS_ID_NEW: 49357, WARDS_NAME: 'P.Thuỷ Xuân', WARDS_NAME_NEW: 'Phường Thuỷ Xuân', DISTRICT_ID: 422, PROVINCE_ID_NEW: 37, PROVINCE_NAME_NEW: 'Thành phố Huế' },
  { WARDS_ID: 1, WARDS_ID_NEW: 49823, WARDS_NAME: 'P.Hàng Buồm', WARDS_NAME_NEW: 'Phường Hoàn Kiếm', DISTRICT_ID: 1, PROVINCE_ID_NEW: 1, PROVINCE_NAME_NEW: 'Thành phố Hà Nội' },
  { WARDS_ID: 8001, WARDS_ID_NEW: 49400, WARDS_NAME: 'P.Bến Nghé', WARDS_NAME_NEW: 'Phường Sài Gòn', DISTRICT_ID: 43, PROVINCE_ID_NEW: 2, PROVINCE_NAME_NEW: 'Thành phố Hồ Chí Minh' }
];
// Danh mục thật có hơn 10.000 dòng; mock lặp cho đủ ngưỡng "không rỗng".
const WARD_LIST = [...WARDS, ...Array.from({ length: 1000 }, (_, i) => ({ WARDS_ID: 100000 + i, WARDS_ID_NEW: 60000 + i, WARDS_NAME: 'X', WARDS_NAME_NEW: 'Xã X', PROVINCE_ID_NEW: 1, PROVINCE_NAME_NEW: 'Tỉnh X' }))];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    calls.push({ url: req.url, body: json });
    const send = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/wards') return send(WARD_LIST);
    if (req.url === '/v2/order/createOrderNlp') {
      const addr = String(json.RECEIVER_ADDRESS);
      const ward = /Hà Nội/.test(addr) ? 1 : /Sài Gòn|Bến Nghé/.test(addr) ? 8001 : 7969;
      return send({ status: 200, error: false, message: 'OK', data: { ORDER_NUMBER: '15' + calls.length, MONEY_TOTAL: 18480, RECEIVER_PROVINCE: 0, RECEIVER_DISTRICT: 0, RECEIVER_WARDS: ward, SORT_CODE: 'X' } });
    }
    if (req.url === '/v2/order/UpdateOrder') return send({ status: 200, error: false, message: 'OK', data: null });
    if (req.url === '/v2/order/getPriceNlp') return send({ status: 200, error: false, message: 'OK', data: { MONEY_TOTAL: json.ORDER_SERVICE === 'STK' ? 20000 : 18480 } });
    if (req.url === '/v2/order/getPriceAllNlp') {
      const addr = String(json.RECEIVER_ADDRESS);
      const ward = /Hà Nội/.test(addr) ? 1 : 7969;
      return send({ SENDER_ADDRESS: {}, RECEIVER_ADDRESS: { PROVINCE_ID: 0, DISTRICT_ID: 0, WARD_ID: ward, ADDRESS: addr }, RESULT: [] });
    }
    send({ status: 404, error: true, message: 'no' });
  });
});

let vtp;
let store;
let wards;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtp-create-'));
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.VTP_BASE = base;
  process.env.VTP_WARDS_URL = base + '/wards';
  vtp = await import('../vtp.js?create');
  store = vtp.createVtpStore(dir);
  store.set('u1', { siteToken: 's', partnerToken: 'p', sender: { name: 'Shop', phone: '0900000000', address: '1 Lê Lợi, Phường Thuận Hoá, TP.Huế' } });
  wards = vtp.createVtpWardCatalog(dir);
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const group = (over = {}) => ({
  ref: 'HD1+HD2', receiver: 'Minh Trí', phone: '0363000000', address: 'cư chánh 1, Phường Thuỷ Xuân, TP.Huế',
  expect: { province: 'TP.Huế', ward: 'Phường Thuỷ Xuân' }, goodsName: 'Quần áo', qty: 2, weightG: 1000,
  goods: 230000, cod: 230000, senderPays: false, note: '', ...over
});

test('ghi chú vận đơn chỉ là ghi chú của khách, không kèm mã đơn hay câu mặc định', async () => {
  const r = await vtp.vtpCreateOrder(store, 'u1', group(), 'VSL9', wards);
  assert.equal(r.ok, true);
  const body = calls.findLast((c) => c.url === '/v2/order/createOrderNlp').body;
  assert.equal(body.ORDER_NOTE, '');
  assert.equal(body.ORDER_NUMBER, undefined);
  assert.equal(body.RECEIVER_FULLNAME, 'Minh Trí');
  const r2 = await vtp.vtpCreateOrder(store, 'u1', group({ note: 'Gọi trước khi giao' }), 'VSL9', wards);
  assert.equal(r2.ok, true);
  assert.equal(calls.findLast((c) => c.url === '/v2/order/createOrderNlp').body.ORDER_NOTE, 'Gọi trước khi giao');
});

test('Viettel Post hiểu đúng phường: trả mã và địa chỉ họ hiểu', async () => {
  const r = await vtp.vtpCreateOrder(store, 'u1', group(), 'VSL9', wards);
  assert.equal(r.ok, true);
  assert.equal(r.parsed, 'Phường Thuỷ Xuân, Thành phố Huế');
  assert.ok(fs.existsSync(path.join(dir, 'vtp-wards.json')), 'danh mục được lưu lại');
});

test('Viettel Post hiểu sang tỉnh khác: huỷ ngay vận đơn và báo lỗi', async () => {
  const n = calls.length;
  const r = await vtp.vtpCreateOrder(store, 'u1', group({ address: '12 Hàng Buồm, Phường Thuỷ Xuân, TP.Huế (Hà Nội)' }), 'VSL9', wards);
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.match(r.error, /Phường Hoàn Kiếm, Thành phố Hà Nội/);
  assert.match(r.error, /Phường Thuỷ Xuân, TP.Huế/);
  assert.match(r.error, /Đã huỷ vận đơn/);
  const cancel = calls.slice(n).find((c) => c.url === '/v2/order/UpdateOrder');
  assert.equal(cancel.body.TYPE, 4);
  assert.equal(cancel.body.ORDER_NUMBER, r.code);
});

test('app iOS không gửi expect: đối chiếu theo dòng địa chỉ; địa chỉ cũ 4 phần so phường cũ', async () => {
  // Địa chỉ mới 3 phần: phường + tỉnh lấy từ dòng địa chỉ.
  let r = await vtp.vtpCreateOrder(store, 'u1', group({ expect: undefined }), 'VSL9', wards);
  assert.equal(r.ok, true);
  r = await vtp.vtpCreateOrder(store, 'u1', group({ expect: undefined, address: '12 Lê Lợi, Phường Hoàn Kiếm, TP.Hà Nội' }), 'VSL9', wards);
  assert.equal(r.ok, true);
  // Địa chỉ cũ 4 phần: Viettel Post hiểu P.Bến Nghé (HCM) nhưng shop ghi Huế -> sai tỉnh.
  r = await vtp.vtpCreateOrder(store, 'u1', group({ expect: undefined, address: '25 Lê Lợi, P.Bến Nghé, Q.1, TP.Huế' }), 'VSL9', wards);
  assert.equal(r.ok, false);
  r = await vtp.vtpCreateOrder(store, 'u1', group({ expect: undefined, address: '25 Lê Lợi, P.Bến Nghé, Q.1, TP.Hồ Chí Minh' }), 'VSL9', wards);
  assert.equal(r.ok, true);
  assert.equal(r.parsed, 'Phường Sài Gòn, Thành phố Hồ Chí Minh');
});

test('app iOS không gửi expect, số nhà có dấu phẩy: không huỷ nhầm vận đơn đúng phường', async () => {
  // Địa chỉ mới 4 phần vì số nhà có dấu phẩy; Viettel Post trả mã phường cũ (7969, có tên phường cũ).
  let r = await vtp.vtpCreateOrder(store, 'u1', group({ expect: undefined, address: '12 Lê Lợi, Tổ 5, Phường Thuỷ Xuân, Thành phố Huế' }), 'VSL9', wards);
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, undefined);
  // Địa chỉ cũ có quận mà số nhà có dấu phẩy (5 phần).
  r = await vtp.vtpCreateOrder(store, 'u1', group({ expect: undefined, address: '25 Lê Lợi, Tổ 2, P.Bến Nghé, Q.1, TP.Hồ Chí Minh' }), 'VSL9', wards);
  assert.equal(r.ok, true);
  // Sai phường thật thì vẫn huỷ: Viettel Post hiểu Thuỷ Xuân nhưng shop ghi phường khác.
  r = await vtp.vtpCreateOrder(store, 'u1', group({ expect: undefined, address: '12 Lê Lợi, Tổ 5, Phường An Cựu, Thành phố Huế' }), 'VSL9', wards);
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.match(r.error, /Phường An Cựu/);
});

test('không có danh mục thì vẫn tạo đơn, không đối chiếu', async () => {
  const r = await vtp.vtpCreateOrder(store, 'u1', group({ address: '1 Hàng Buồm, Phường Thuỷ Xuân, TP.Huế (Hà Nội)' }), 'VSL9', null);
  assert.equal(r.ok, true);
  assert.equal(r.parsed, undefined);
});

test('so địa danh: bỏ dấu, bỏ tiền tố tỉnh/thành', () => {
  assert.equal(vtp.placeKey('TP.Huế', true), vtp.placeKey('Thành phố Huế', true));
  assert.equal(vtp.placeKey('T.Hà Tĩnh', true), vtp.placeKey('Tỉnh Hà Tĩnh', true));
  assert.equal(vtp.placeKey('Phường Thuỷ Xuân'), vtp.placeKey('Phường Thủy Xuân'));
  assert.notEqual(vtp.placeKey('Phường Thuỷ Xuân'), vtp.placeKey('Phường Thuỷ Biều'));
  assert.deepEqual(vtp.expectedPlace({ address: '1 A, Phường B, TP.C' }), { province: 'TP.C', ward: 'Phường B', oldWard: '' });
  assert.deepEqual(vtp.expectedPlace({ address: '1 A, P.B, Q.X, TP.C' }), { province: 'TP.C', ward: '', oldWard: 'P.B' });
});

test('nháp: hỏi cước và địa chỉ Viettel Post hiểu, không tạo đơn', async () => {
  const n = calls.length;
  const q = await vtp.vtpQuote(store, 'u1', group(), 'VSL9', wards);
  assert.equal(q.ok, true);
  assert.equal(q.fee, 18480);
  assert.equal(q.parsed, 'Phường Thuỷ Xuân, Thành phố Huế');
  assert.equal(q.addrOk, true);
  const urls = calls.slice(n).map((c) => c.url).sort();
  assert.deepEqual(urls, ['/v2/order/getPriceAllNlp', '/v2/order/getPriceNlp']);
  assert.equal((await vtp.vtpQuote(store, 'u1', group(), 'STK', wards)).fee, 20000);
});

test('nháp: Viettel Post hiểu sang tỉnh khác thì báo addrOk=false', async () => {
  const q = await vtp.vtpQuote(store, 'u1', group({ address: '12 Hàng Buồm, Phường Thuỷ Xuân, TP.Huế (Hà Nội)' }), 'VSL9', wards);
  assert.equal(q.ok, true);
  assert.equal(q.addrOk, false);
  assert.equal(q.parsed, 'Phường Hoàn Kiếm, Thành phố Hà Nội');
});
