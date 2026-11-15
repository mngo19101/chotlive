// INF-03: log máy chủ không được chứa SĐT, địa chỉ, tên người nhận do Viettel Post trả lại.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PHONE = '0363123456';
const STREET = 'cư chánh 1';
const NAME = 'Minh Trí';
const echo = { RECEIVER_FULLNAME: NAME, RECEIVER_PHONE: PHONE, RECEIVER_ADDRESS: `${STREET}, Phường Thuỷ Xuân, TP.Huế` };

let mode = 'error';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (req.url === '/wards') return send([]);
    if (req.url === '/v2/order/createOrderNlp') {
      if (mode === 'error') return send({ status: 200, error: true, message: `Số điện thoại ${PHONE} không hợp lệ`, data: echo });
      // Tạo được nhưng mã phường không tra được: trước đây log nguyên `data`.
      return send({ status: 200, error: false, message: 'OK', data: { ORDER_NUMBER: '1501', MONEY_TOTAL: 18480, RECEIVER_WARDS: 424242, ...echo } });
    }
    if (req.url === '/v2/order/UpdateOrder') return send({ status: 200, error: true, message: `Không huỷ được đơn của ${PHONE}`, data: echo });
    send({ status: 404, error: true, message: 'no' });
  });
});

let vtp, store, wards;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtp-log-'));
const logs = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.VTP_BASE = base;
  process.env.VTP_WARDS_URL = base + '/wards';
  vtp = await import('../vtp.js?logpii');
  store = vtp.createVtpStore(dir);
  store.set('u1', { siteToken: 's', partnerToken: 'p', sender: { name: 'Shop', phone: '0900000000', address: '1 Lê Lợi, Phường Thuận Hoá, TP.Huế' } });
  // Danh mục phường giả có một phường khác: mã 424242 không tra được.
  wards = { get: async () => null, lookup: () => null };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
});
after(() => {
  Object.assign(console, orig);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const group = { ref: 'HD1', receiver: NAME, phone: PHONE, address: echo.RECEIVER_ADDRESS, goodsName: 'Áo', qty: 1, weightG: 500, goods: 200000, cod: 200000, senderPays: false, note: '' };

const assertClean = (text) => {
  assert.ok(!text.includes(PHONE), `log còn SĐT: ${text}`);
  assert.ok(!text.includes(STREET), `log còn địa chỉ: ${text}`);
  assert.ok(!text.includes(NAME), `log còn tên người nhận: ${text}`);
};

test('tạo vận đơn lỗi: log có HTTP và lời báo (SĐT đã che), không có phản hồi thô', async () => {
  logs.length = 0;
  mode = 'error';
  const r = await vtp.vtpCreateOrder(store, 'u1', group, 'VSL9', wards);
  assert.equal(r.ok, false);
  const text = logs.join('\n');
  assert.match(text, /HTTP 200/);
  assert.match(text, /036•••456/);
  assertClean(text);
});

test('tạo được nhưng không đối chiếu được phường: log tên trường, không log giá trị', async () => {
  logs.length = 0;
  mode = 'ok';
  const r = await vtp.vtpCreateOrder(store, 'u1', group, 'VSL9', wards);
  assert.equal(r.ok, true);
  const text = logs.join('\n');
  assert.match(text, /RECEIVER_WARDS/);
  assertClean(text);
});

test('huỷ vận đơn lỗi: không log phản hồi thô', async () => {
  logs.length = 0;
  const r = await vtp.vtpCancel(store, 'u1', '1501');
  assert.equal(r.ok, false);
  const text = logs.join('\n');
  assert.match(text, /1501/);
  assertClean(text);
});

test('maskPhones che SĐT trong chuỗi, giữ mã vận đơn', () => {
  assert.equal(vtp.maskPhones('gọi 0363 123 456 hoặc +84363123456, vận đơn 1734567890123'), 'gọi 036•••456 hoặc 843•••456, vận đơn 1734567890123');
});
