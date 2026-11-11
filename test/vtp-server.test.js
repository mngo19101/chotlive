/**
 * Chạy server thật với Viettel Post giả (trả lời chậm) để thử tạo vận đơn qua /api/vtp/create:
 * hai yêu cầu cho cùng một đơn gửi cùng lúc chỉ được tạo một vận đơn.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-vtp-'));
const PORT = 4100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let created = 0;
const fakeVtp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const send = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    const okData = (data) => send({ status: 200, error: false, message: 'OK', data });
    if (req.url === '/wards') return send([]);
    if (req.url === '/v2/user/LoginVTP') return okData({ token: 'partner', phone: '0900000000', userId: 1 });
    if (req.url === '/v2/user/listInventory') return okData([{ groupaddressId: 1, name: 'Shop', phone: '0900000000', address: '1 Lê Lợi, Phường Thuận Hoá, TP.Huế' }]);
    if (req.url === '/v2/order/createOrderNlp') {
      created += 1;
      const code = 'VTP' + created;
      await sleep(400);
      return okData({ ORDER_NUMBER: code, MONEY_TOTAL: 18480, RECEIVER_WARDS: 7969 });
    }
    send({ status: 404, error: true, message: 'no' });
  });
});

let server;
let token;
async function api(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  await new Promise((r) => fakeVtp.listen(0, '127.0.0.1', r));
  const vtpBase = `http://127.0.0.1:${fakeVtp.address().port}`;
  server = spawn(process.execPath, ['--no-warnings', '--import', './test/fake-tiktok/register.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'admin-test', LAN_MODE: '', VTP_BASE: vtpBase, VTP_WARDS_URL: vtpBase + '/wards' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await sleep(40);
  }
  const reg = await api('/api/auth/register', { username: 'shop.vtp', password: 'mat-khau', confirmPassword: 'mat-khau' });
  token = reg.body.token;
  assert.ok(token);
  assert.equal((await api('/api/vtp/connect', { siteToken: 'site' })).status, 200);
  assert.equal((await api('/api/vtp/sender', { id: 1 })).status, 200);
});

after(async () => {
  if (server) {
    const gone = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  fakeVtp.close();
  await sleep(100);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('bấm tạo vận đơn hai lần cùng lúc: chỉ tạo một vận đơn, lần sau nhận lại đúng mã đó', async () => {
  const order = {
    id: 'o1', code: 'HD1', uniqueId: 'lan.nguyen', nickname: 'Lan', status: 'printed', ts: Date.now(), total: 150000,
    items: [{ id: 'it1', name: 'Mã 150', price: 150000, qty: 1 }], ship: { state: 'ready', pay: 'cod' }
  };
  assert.equal((await api('/api/sync', { state: { orders: [order], customers: [] } })).status, 200);

  const group = {
    key: 'lan', orderIds: ['o1'], ref: 'HD1', receiver: 'Lan', phone: '0363000000',
    address: '12 Lê Lợi, Phường Thuỷ Xuân, TP.Huế', goodsName: 'Quần áo', qty: 1, weightG: 500, goods: 150000, cod: 150000
  };
  const [a, b] = await Promise.all([
    api('/api/vtp/create', { service: 'VSL9', groups: [group] }),
    api('/api/vtp/create', { service: 'VSL9', groups: [group] })
  ]);

  assert.equal(created, 1, 'Viettel Post chỉ nhận một lần tạo đơn');
  const results = [a.body.results[0], b.body.results[0]];
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.deepEqual(results.map((r) => r.code), ['VTP1', 'VTP1']);
  assert.equal(results.filter((r) => r.already).length, 1, 'một trong hai yêu cầu được báo là đã có vận đơn');

  const state = (await api('/api/state')).body;
  const saved = (state.state || state).orders.find((o) => o.id === 'o1');
  assert.equal(saved.ship.vtpCode, 'VTP1');
  assert.equal(saved.status, 'shipping');
});

const serverOrder = async () => {
  const state = (await api('/api/state')).body;
  return (state.state || state).orders.find((o) => o.id === 'o1');
};
const hookPath = async () => new URL((await api('/api/vtp/status')).body.hookUrl).pathname;
const until = async (fn, label) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await sleep(40);
  }
  assert.fail(`Quá giờ chờ: ${label}`);
};

test('web gửi lại danh sách đơn cũ: không làm mất mã vận đơn và trạng thái Viettel Post vừa báo', async () => {
  const hook = await hookPath();
  await api(hook, { DATA: { ORDER_NUMBER: 'VTP1', ORDER_STATUS: 103, STATUS_NAME: 'Giao cho bưu cục', ORDER_STATUSDATE: '11/11/2026 10:00:00' } });
  await until(async () => (await serverOrder()).ship.vtpStatus === 103, 'ghi trạng thái webhook');

  // Bản web chụp từ trước khi tạo vận đơn: chưa có mã, đơn còn "đã duyệt".
  const stale = {
    id: 'o1', code: 'HD1', uniqueId: 'lan.nguyen', nickname: 'Lan đổi tên', status: 'printed', ts: Date.now(), total: 150000,
    items: [{ id: 'it1', name: 'Mã 150', price: 150000, qty: 1 }], ship: { state: 'ready', pay: 'cod' }
  };
  assert.equal((await api('/api/sync', { state: { orders: [stale], customers: [] } })).status, 200);
  let o = await serverOrder();
  assert.equal(o.nickname, 'Lan đổi tên', 'phần web sửa vẫn được nhận');
  assert.equal(o.ship.vtpCode, 'VTP1');
  assert.equal(o.ship.state, 'exported');
  assert.equal(o.status, 'shipping');
  assert.equal(o.ship.vtpStatus, 103);

  // Bản web ngay sau khi tạo vận đơn: có mã nhưng còn "Chờ lấy hàng".
  const justCreated = { ...stale, status: 'shipping', ship: { state: 'exported', pay: 'cod', vtpCode: 'VTP1', vtpStatus: 0, vtpStatusName: 'Chờ lấy hàng', vtpKind: 'created' } };
  assert.equal((await api('/api/sync', { state: { orders: [justCreated], customers: [] } })).status, 200);
  o = await serverOrder();
  assert.equal(o.ship.vtpStatus, 103);
  assert.equal(o.ship.vtpStatusName, 'Giao cho bưu cục');
});

test('xoá tài khoản thì xoá luôn kết nối Viettel Post, webhook cũ không dựng lại dữ liệu', async () => {
  const hook = await hookPath();
  const file = path.join(DATA_DIR, 'vtp-connections.json');
  assert.match(fs.readFileSync(file, 'utf8'), /"siteToken"/);
  const userToken = token;
  const userId = (await api('/api/auth/me')).body.user?.id;

  const login = await api('/api/auth/login', { username: 'admin', password: 'admin-test' });
  token = login.body.token;
  assert.ok(token, 'đăng nhập admin');
  const users = (await api('/api/admin/users')).body.users;
  const target = userId || users.find((u) => u.username === 'shop.vtp').id;
  const del = await fetch(`${BASE}/api/admin/users/${target}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(del.status, 200);

  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /"siteToken"/, 'token Viettel Post đã bị xoá');
  const res = await api(hook, { DATA: { ORDER_NUMBER: 'VTP1', ORDER_STATUS: 501, STATUS_NAME: 'Phát thành công' } });
  assert.equal(res.status, 200);
  token = userToken;
  assert.equal((await api('/api/vtp/status')).status, 401, 'tài khoản đã xoá không còn dùng được');
});
