/**
 * Server mở ra Internet: thử như một người lạ tự đăng ký tài khoản rồi tìm cách lạm dụng.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createLimiter, waitMessage } from '../rate-limit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-public-'));
const PORT = 4000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'admin-test-password';
let server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(env = {}, port = PORT, dataDir = DATA_DIR) {
  return spawn(process.execPath, ['--no-warnings', '--import', './test/fake-tiktok/register.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD, LAN_MODE: '', ...env },
    stdio: 'ignore'
  });
}

async function waitUp(base = BASE) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await sleep(50);
  }
  assert.fail('server không khởi động');
}

async function stop(child) {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([gone, sleep(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(100);
}

async function post(url, body, { token, ip, base = BASE } = {}) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

const register = (username, password = 'mat-khau-tot', ip) =>
  post('/api/auth/register', { username, password, confirmPassword: password }, { ip });

/** Mỗi test dùng một IP riêng để không chạm giới hạn của test khác. */
let ipCounter = 0;
const newIp = () => `203.0.113.${++ipCounter}`;

function openSocket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}&native=1`);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on('error', () => {});
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  const opened = new Promise((r) => ws.once('open', r));
  return { ws, messages, closed, opened };
}

async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await sleep(30);
  }
  assert.fail(`Quá giờ chờ: ${label}`);
}

before(async () => {
  server = startServer();
  await waitUp();
});

after(async () => {
  if (server) await stop(server);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('người lạ đăng ký được rồi đăng nhập lại được, dữ liệu trống', async () => {
  const ip = newIp();
  const reg = await register('Khách Mới 1', 'mat-khau-tot', ip);
  assert.equal(reg.status, 200);
  assert.ok(reg.body.token);
  assert.equal(reg.body.user.role, 'user');
  assert.deepEqual(reg.body.state.orders, []);

  const login = await post('/api/auth/login', { username: 'khách mới 1', password: 'mat-khau-tot' }, { ip });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
});

test('đăng ký bị từ chối khi mật khẩu yếu, tên sai hoặc tên đã có', async () => {
  const ip = newIp();
  assert.equal((await register('khach.yeu', '12345', ip)).status, 400);
  assert.equal((await register('x', 'mat-khau-tot', ip)).status, 400);
  assert.equal((await register('a'.repeat(33), 'mat-khau-tot', ip)).status, 400);
  assert.equal((await register('<script>', 'mat-khau-tot', ip)).status, 400);
  assert.equal((await register('khach\u0000ten', 'mat-khau-tot', ip)).status, 400);
  assert.equal((await register('khach.dai', 'a'.repeat(129), ip)).status, 400);
  assert.equal(
    (await post('/api/auth/register', { username: 'khach.lech', password: 'mat-khau-tot', confirmPassword: 'khac' }, { ip })).status,
    400
  );
  assert.equal((await register('admin', 'mat-khau-tot', ip)).status, 409);
  assert.equal((await register('ADMIN', 'mat-khau-tot', ip)).status, 409);
});

test('hai người đăng ký cùng một tên cùng lúc: chỉ một người được', async () => {
  const ip = newIp();
  const results = await Promise.all([register('trung.ten', 'mat-khau-tot', ip), register('trung.ten', 'mat-khau-tot', ip)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test('không tự đăng ký được quyền admin', async () => {
  const res = await post('/api/auth/register', {
    username: 'muon.lam.admin',
    password: 'mat-khau-tot',
    confirmPassword: 'mat-khau-tot',
    role: 'admin'
  }, { ip: newIp() });
  assert.equal(res.body.user.role, 'user');
});

test('mật khẩu admin123 từng ghi trên trang đăng nhập không dùng được', async () => {
  const login = await post('/api/auth/login', { username: 'admin', password: 'admin123' }, { ip: newIp() });
  assert.equal(login.status, 401);
  const page = await fetch(`${BASE}/`).then((r) => r.text());
  assert.ok(!page.includes('admin123'));
});

test('tài khoản thường không vào được API quản trị', async () => {
  const { body } = await register('khach.thuong', 'mat-khau-tot', newIp());
  const res = await fetch(`${BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(res.status, 403);
});

test('file trong máy chủ không tải được qua web', async () => {
  for (const p of ['/data/susu.db', '/.env', '/server.js', '/package.json']) {
    assert.equal((await fetch(BASE + p)).status, 404, p);
  }
});

test('in LAN bị tắt: tài khoản đăng ký từ xa không chạm được dịch vụ nội bộ của máy chủ', async () => {
  const { body } = await register('khach.ssrf', 'mat-khau-tot', newIp());
  let received = 0;
  const internal = net.createServer((s) => s.on('data', (d) => (received += d.length)));
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  const res = await post('/api/print-lan', { ip: '127.0.0.1', port: internal.address().port, bytes: [1, 2, 3] }, { token: body.token });
  await sleep(100);
  internal.close();
  assert.equal(res.status, 403);
  assert.equal(received, 0);

  const info = await fetch(`${BASE}/api/server-info`, { headers: { Authorization: `Bearer ${body.token}` } }).then((r) => r.json());
  assert.deepEqual(info.lanUrls, []);
});

test('đổi mật khẩu: thiết bị khác bị ngắt ngay, thiết bị đang đổi vẫn dùng được', async () => {
  const ip = newIp();
  const { body } = await register('khach.doi.pass', 'mat-khau-tot', ip);
  const other = await post('/api/auth/login', { username: 'khach.doi.pass', password: 'mat-khau-tot' }, { ip });

  const kept = openSocket(body.token);
  const kicked = openSocket(other.body.token);
  await Promise.all([kept.opened, kicked.opened]);
  await until(() => kept.messages.length && kicked.messages.length, 'nhận hello');

  const change = await post('/api/auth/change-password', {
    currentPassword: 'mat-khau-tot',
    newPassword: 'mat-khau-moi',
    confirmPassword: 'mat-khau-moi'
  }, { token: body.token });
  assert.equal(change.status, 200);

  assert.equal(await kicked.closed, 4001);
  assert.ok(kicked.messages.some((m) => m.type === 'password_changed_force_login'));
  assert.equal(kept.ws.readyState, WebSocket.OPEN);
  kept.ws.close();

  const stale = await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${other.body.token}` } });
  assert.equal(stale.status, 401);
});

test('đăng xuất rồi: kết nối cũ không gửi được dữ liệu nữa', async () => {
  const { body } = await register('khach.dang.xuat', 'mat-khau-tot', newIp());
  const sock = openSocket(body.token);
  await sock.opened;
  await until(() => sock.messages.length, 'nhận hello');
  await post('/api/auth/logout', {}, { token: body.token });

  sock.ws.send(JSON.stringify({ type: 'ping' }));
  await until(() => sock.messages.some((m) => m.type === 'auth_error'), 'báo hết phiên');
  assert.equal(await sock.closed, 4001);
});

test('admin khoá và xoá tài khoản: thiết bị đang mở bị ngắt và không tạo lại dữ liệu', async () => {
  const admin = await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, { ip: newIp() });
  assert.equal(admin.status, 200);
  const ip = newIp();

  const locked = await register('khach.bi.khoa', 'mat-khau-tot', ip);
  const lockedSock = openSocket(locked.body.token);
  await lockedSock.opened;
  await until(() => lockedSock.messages.length, 'nhận hello');
  await post(`/api/admin/users/${locked.body.user.id}/lock`, { locked: true }, { token: admin.body.token });
  assert.equal(await lockedSock.closed, 4001);
  assert.ok(lockedSock.messages.some((m) => m.type === 'account_locked'));

  const removed = await register('khach.bi.xoa', 'mat-khau-tot', ip);
  const removedSock = openSocket(removed.body.token);
  await removedSock.opened;
  await until(() => removedSock.messages.length, 'nhận hello');
  const del = await fetch(`${BASE}/api/admin/users/${removed.body.user.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${admin.body.token}` }
  });
  assert.equal(del.status, 200);
  assert.equal(await removedSock.closed, 4001);
  assert.equal((await post('/api/auth/login', { username: 'khach.bi.xoa', password: 'mat-khau-tot' }, { ip })).status, 401);
});

test('gói WebSocket quá lớn bị ngắt, server vẫn sống', async () => {
  const { body } = await register('khach.goi.lon', 'mat-khau-tot', newIp());
  const sock = openSocket(body.token);
  await sock.opened;
  sock.ws.send(Buffer.alloc(33 * 1024 * 1024, 0x20));
  assert.equal(await sock.closed, 1009);
  assert.ok((await fetch(`${BASE}/healthz`)).ok);
});

test('server đang chạy thử: trang đăng nhập web không còn nút điền sẵn admin', async () => {
  const js = await fetch(`${BASE}/js/app.js`).then((r) => r.text());
  assert.ok(!js.includes('admin123'));
  assert.ok(!js.includes('btn-fill-admin-cred'));
});

test('dò mật khẩu bị chặn sau 10 lần sai, người ở IP khác và đúng mật khẩu ở IP khác không bị ảnh hưởng', async () => {
  // Tin X-Forwarded-For vì test nối từ 127.0.0.1, giống Caddy trên cùng máy.
  const attacker = newIp();
  const owner = newIp();
  await register('khach.bi.do', 'mat-khau-tot', owner);

  for (let i = 0; i < 10; i++) {
    const r = await post('/api/auth/login', { username: 'khach.bi.do', password: `sai-${i}` }, { ip: attacker });
    assert.equal(r.status, 401);
  }
  const blocked = await post('/api/auth/login', { username: 'khach.bi.do', password: 'mat-khau-tot' }, { ip: attacker });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  const ok = await post('/api/auth/login', { username: 'khach.bi.do', password: 'mat-khau-tot' }, { ip: owner });
  assert.equal(ok.status, 200);
});

test('đăng nhập đúng xoá số lần sai trước đó của chính người đó', async () => {
  const ip = newIp();
  await register('khach.hay.quen', 'mat-khau-tot', ip);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 6; i++) {
      assert.equal((await post('/api/auth/login', { username: 'khach.hay.quen', password: 'sai' }, { ip })).status, 401);
    }
    assert.equal((await post('/api/auth/login', { username: 'khach.hay.quen', password: 'mat-khau-tot' }, { ip })).status, 200);
  }
});

test('đăng ký hàng loạt từ một IP bị chặn sau 20 tài khoản', async () => {
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await register(`spam.${i}`, 'mat-khau-tot', ip)).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
  assert.equal(statuses[20], 429);
  // Người khác vẫn đăng ký bình thường.
  assert.equal((await register('khach.that', 'mat-khau-tot', newIp())).status, 200);
});

test('server vẫn trả lời nhanh trong lúc nhiều người đăng nhập', async () => {
  const flood = Array.from({ length: 30 }, (_, i) => post('/api/auth/login', { username: `khong.co.${i}`, password: 'sai' }, { ip: newIp() }));
  // Băm mật khẩu của tài khoản có thật mới tốn thời gian.
  const ip = newIp();
  await register('khach.ban.ron', 'mat-khau-tot', ip);
  const busy = Array.from({ length: 30 }, () => post('/api/auth/login', { username: 'khach.ban.ron', password: 'mat-khau-tot' }, { ip }));
  const start = Date.now();
  await fetch(`${BASE}/healthz`);
  const elapsed = Date.now() - start;
  await Promise.all([...flood, ...busy]);
  assert.ok(elapsed < 500, `/healthz mất ${elapsed}ms`);
});

test('LAN_MODE=1 (server chạy ở shop): in LAN vẫn dùng được', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-lan-'));
  const port = PORT + 100;
  const base = `http://127.0.0.1:${port}`;
  const child = startServer({ LAN_MODE: '1' }, port, dir);
  try {
    await waitUp(base);
    const reg = await post('/api/auth/register', { username: 'shop.lan', password: 'mat-khau-tot', confirmPassword: 'mat-khau-tot' }, { base });
    let received = 0;
    const printer = net.createServer((s) => s.on('data', (d) => (received += d.length)));
    await new Promise((r) => printer.listen(0, '127.0.0.1', r));
    const res = await post('/api/print-lan', { ip: '127.0.0.1', port: printer.address().port, bytes: [1, 2, 3] }, { token: reg.body.token, base });
    await sleep(100);
    printer.close();
    assert.equal(res.status, 200);
    assert.equal(received, 3);
  } finally {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HOST=127.0.0.1: chỉ nối được từ chính máy chủ', async (t) => {
  const external = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal);
  if (!external) return t.skip('máy không có địa chỉ mạng ngoài');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-host-'));
  const port = PORT + 200;
  const child = startServer({ HOST: '127.0.0.1' }, port, dir);
  try {
    await waitUp(`http://127.0.0.1:${port}`);
    const reachable = await fetch(`http://${external.address}:${port}/healthz`, { signal: AbortSignal.timeout(1500) }).then(
      () => true,
      () => false
    );
    assert.equal(reachable, false);
  } finally {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bộ đếm giới hạn: chặn đủ số lần, hết giờ thì mở lại, đọc bộ đếm không làm tăng', () => {
  let now = 1000;
  const limiter = createLimiter({ max: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.retryAfter('a'), 0);
  limiter.hit('a');
  assert.equal(limiter.retryAfter('a'), 0);
  limiter.hit('a');
  assert.equal(limiter.retryAfter('a'), 1);
  assert.equal(limiter.retryAfter('b'), 0);
  limiter.reset('a');
  assert.equal(limiter.retryAfter('a'), 0);

  limiter.hit('a');
  limiter.hit('a');
  now += 1000;
  assert.equal(limiter.retryAfter('a'), 0);

  limiter.hit('c');
  now += 1000;
  limiter.sweep();
  assert.equal(limiter.size, 0);
  assert.match(waitMessage(61), /2 phút/);
  assert.match(waitMessage(1), /1 phút/);
});

test('sao lưu khi server đang chạy: bản sao mở được, chỉ giữ số bản quy định', async () => {
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-backups-'));
  try {
    await register('khach.sao.luu', 'mat-khau-tot', newIp());
    await sleep(300); // chờ server ghi xuống đĩa
    for (const old of ['susu-20200101-000000.db', 'susu-20200102-000000.db']) fs.writeFileSync(path.join(backups, old), 'cu');
    fs.writeFileSync(path.join(backups, 'ghi-chu.txt'), 'khong phai ban sao');

    const run = spawnSync(process.execPath, ['--no-warnings', 'deploy/backup.mjs', DATA_DIR, backups, '2'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);

    const files = fs.readdirSync(backups).sort();
    assert.equal(files.length, 3);
    assert.ok(files.includes('ghi-chu.txt'));
    assert.ok(files.includes('susu-20200102-000000.db'));
    const fresh = files.find((f) => /^susu-20[3-9]|^susu-202[1-9]/.test(f));
    assert.ok(fresh, files.join(','));

    const copy = new DatabaseSync(path.join(backups, fresh), { readOnly: true });
    let names;
    try {
      names = copy.prepare('SELECT data FROM users').all().map((u) => JSON.parse(u.data).username);
    } finally {
      copy.close();
    }
    assert.ok(names.includes('khach.sao.luu'));
  } finally {
    fs.rmSync(backups, { recursive: true, force: true });
  }
});
