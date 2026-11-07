/**
 * Dùng thử 3 ngày, gói do admin cấp, giới hạn 2 tài khoản mỗi IP: chạy server thật với đồng hồ tua được,
 * rồi thử như một người tìm cách dùng miễn phí mãi.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  accessOf,
  DAY_MS,
  extendedPlanEnd,
  ipKey,
  parseTrustProxy,
  PLAN_MONTH_DAYS,
  TRIAL_EXPIRED_MESSAGE,
  TRIAL_MS
} from '../access.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-access-'));
const PORT = 4300 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'admin-test-password';
const PASSWORD = 'mat-khau-tot';
const MINUTE = 60 * 1000;
/** Mỗi 5 giây server rà một lần; chờ dư ra một chút. */
const SWEEP_WAIT_MS = 8000;

let server;
let clockOffset = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer({ env = {}, port = PORT, dataDir = DATA_DIR, offset = clockOffset } = {}) {
  return spawn(
    process.execPath,
    ['--no-warnings', '--import', './test/fake-tiktok/register.js', '--import', './test/fake-clock.js', 'server.js'],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD, LAN_MODE: '', TRUST_PROXY: '', FAKE_CLOCK_OFFSET_MS: String(offset), ...env },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    }
  );
}

async function waitUp(base = BASE, child = server) {
  for (let i = 0; i < 200; i++) {
    assert.equal(child.exitCode, null, 'server đã thoát trong lúc khởi động');
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

/** Tắt rồi bật lại, kể cả khi đồng hồ đã tua: dữ liệu phải đủ vì Windows không cho server ghi nốt lúc tắt. */
async function restart() {
  await sleep(400);
  await stop(server);
  server = startServer();
  await waitUp();
}

async function advance(ms) {
  clockOffset += ms;
  const acked = new Promise((r) => {
    const onMessage = (m) => {
      if (m?.clockSet === clockOffset) {
        server.off('message', onMessage);
        r();
      }
    };
    server.on('message', onMessage);
  });
  server.send({ clockOffset });
  await acked;
}

async function call(method, url, { body, token, ip, base = BASE } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const post = (url, body, opts) => call('POST', url, { ...opts, body });

let ipCounter = 0;
const newIp = () => `198.51.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

const registerAt = (username, ip, extra = {}, base = BASE) =>
  post('/api/auth/register', { username, password: PASSWORD, confirmPassword: PASSWORD, ...extra }, { ip, base });

async function newUser(username) {
  const reg = await registerAt(username, newIp());
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  return { id: reg.body.user.id, token: reg.body.token, access: reg.body.user.access };
}

async function adminToken() {
  const login = await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, { ip: newIp() });
  assert.equal(login.status, 200);
  return login.body.token;
}

function device(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}&native=1`);
  const d = { ws, messages: [], lives: [], access: null, chats: 0 };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    d.messages.push(m);
    if (m.type === 'hello') {
      d.lives = m.lives || [];
      d.access = m.user?.access;
    }
    if (m.type === 'lives') d.lives = m.lives;
    if (m.type === 'access') d.access = m.access;
    if (m.type === 'chat') d.chats++;
  });
  ws.on('error', () => {});
  d.send = (m) => ws.send(JSON.stringify(m));
  d.close = () => ws.terminate();
  d.ready = until(() => d.messages.some((m) => m.type === 'hello'), 'nhận hello').then(() => d);
  return d;
}

async function until(fn, label, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  assert.fail(`Quá giờ chờ: ${label}`);
}

const liveOf = (d, name) => d.lives.find((l) => l.username === name);
const connected = (d, name) => until(() => liveOf(d, name)?.state === 'connected', `@${name} kết nối xong`);

/** Xin theo dõi và chờ server từ chối vì hết hạn. Server chỉ cần cho chạy là test này hỏng. */
async function assertRefused(token, name = 'shop.bi.chan', code = 'TRIAL_EXPIRED') {
  const d = await device(token).ready;
  d.send({ type: 'connect', username: name });
  const refusal = await until(() => d.messages.find((m) => m.type === 'status' && m.state === 'error'), 'bị từ chối');
  assert.equal(refusal.code, code);
  await sleep(150);
  assert.equal(liveOf(d, name), undefined, 'không được có live nào chạy');
  d.close();
  return refusal;
}

async function assertCanFollow(token, name) {
  const d = await device(token).ready;
  d.send({ type: 'connect', username: name });
  await connected(d, name);
  return d;
}

before(async () => {
  server = startServer();
  await waitUp();
});

after(async () => {
  if (server) await stop(server);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ---------- Dùng thử ---------- */

test('đăng ký mới được đúng 3 ngày do server tính', async () => {
  const before = Date.now() + clockOffset;
  const u = await newUser('trial.moi');
  assert.equal(u.access.status, 'trial');
  assert.equal(u.access.canFollowLive, true);
  assert.ok(Math.abs(u.access.endsAt - before - TRIAL_MS) < 5000, 'hết hạn sau 3 ngày');
});

test('gần hết 3 ngày vẫn theo dõi được; quá 3 ngày: live đang chạy bị ngắt, xin mới bị từ chối và có thông báo', async () => {
  const u = await newUser('trial.het.han');
  await advance(TRIAL_MS - MINUTE);

  const d = await assertCanFollow(u.token, 'shop.dang.chay');
  // Live đang tự nối lại cũng phải dừng, không được lọt qua đường nối lại.
  d.send({ type: 'connect', username: 'flaky.dang.chay' });
  await connected(d, 'flaky.dang.chay');
  await until(() => d.chats > 3, 'có bình luận về');

  await advance(MINUTE + 1000);
  await until(() => d.lives.length === 0, 'mọi live bị dừng', SWEEP_WAIT_MS);
  await until(() => d.messages.some((m) => m.type === 'status' && m.code === 'TRIAL_EXPIRED'), 'báo cho thiết bị');
  const notice = d.messages.find((m) => m.code === 'TRIAL_EXPIRED');
  assert.equal(notice.message, TRIAL_EXPIRED_MESSAGE);
  assert.match(notice.message, /hết 3 ngày dùng thử/);
  assert.match(notice.message, /mua gói/);
  assert.equal(d.access.status, 'expired');

  const stopped = await call('GET', '/api/state', { token: u.token });
  assert.equal(stopped.body.state.sessions.filter((s) => s.isLive).length, 0, 'phiên đã đóng');
  const count = stopped.body.state.comments.length;
  await sleep(600);
  assert.equal((await call('GET', '/api/state', { token: u.token })).body.state.comments.length, count, 'không còn bình luận mới');

  // Kết nối đang mở từ trước lúc hết hạn cũng không xin được.
  d.messages.length = 0;
  d.send({ type: 'connect', username: 'shop.xin.lai' });
  await until(() => d.messages.some((m) => m.code === 'TRIAL_EXPIRED'), 'kết nối cũ bị từ chối');
  assert.equal(liveOf(d, 'shop.xin.lai'), undefined);
  d.close();

  await assertRefused(u.token);
});

test('hết hạn nhưng các tính năng khác vẫn dùng bình thường', async () => {
  const u = await newUser('trial.tinh.nang.khac');
  const ip = newIp();
  await advance(TRIAL_MS + 1000);

  const login = await post('/api/auth/login', { username: 'trial.tinh.nang.khac', password: PASSWORD }, { ip });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.access.status, 'expired');
  assert.equal(login.body.user.locked, false);

  const order = { id: 'don_1', uniqueId: 'khach_1', status: 'new', items: [{ id: 'mon_1', price: 1000, qty: 1 }], total: 1000 };
  assert.equal((await post('/api/sync', { state: { orders: [order] } }, { token: u.token })).status, 200);
  const state = await call('GET', '/api/state', { token: u.token });
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.state.orders.map((o) => o.id), ['don_1']);
  assert.equal((await call('GET', '/api/comments', { token: u.token })).status, 200);

  // Thiết bị vẫn đồng bộ được qua WebSocket và không bị đẩy ra ngoài.
  const d = await device(u.token).ready;
  d.send({ type: 'ping' });
  await until(() => d.messages.some((m) => m.type === 'pong'), 'vẫn nhận pong');
  assert.equal(d.ws.readyState, WebSocket.OPEN);
  d.close();
});

test('không cách nào phía người dùng gia hạn được dùng thử', async () => {
  const u = await newUser('trial.lach');
  const ip = newIp();
  const originalEnd = u.access.endsAt;
  await advance(TRIAL_MS + 1000);
  await assertRefused(u.token);

  // Đăng xuất rồi đăng nhập lại, token mới.
  await post('/api/auth/logout', {}, { token: u.token });
  const login = await post('/api/auth/login', { username: 'trial.lach', password: PASSWORD }, { ip });
  const token = login.body.token;
  await assertRefused(token);

  // Đổi mật khẩu.
  await post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'mat-khau-moi', confirmPassword: 'mat-khau-moi' }, { token });
  await assertRefused(token);

  // Xoá sạch dữ liệu của mình.
  assert.equal((await post('/api/reset', {}, { token })).status, 200);
  await assertRefused(token);

  // Gửi mốc thời gian giả qua đường đồng bộ.
  const far = Date.now() + clockOffset + 365 * DAY_MS;
  const forged = { trialEndsAt: far, planEndsAt: far, role: 'admin', access: { status: 'plan', canFollowLive: true }, settings: { trialEndsAt: far, planEndsAt: far } };
  await post('/api/sync', { state: forged }, { token });
  const d = await device(token).ready;
  d.send({ type: 'sync_update', state: forged });
  d.send({ type: 'native_update', id: 1, ...forged });
  d.send({ type: 'access', access: { status: 'plan', canFollowLive: true } });
  await sleep(200);
  d.close();
  await assertRefused(token);

  // Giả lệnh admin bằng chính token thường, và cố gắn trường vào yêu cầu theo dõi.
  const me = await call('GET', '/api/auth/me', { token });
  assert.equal(me.body.user.access.status, 'expired');
  assert.equal(me.body.user.role, 'user');
  assert.equal(me.body.user.access.trialEndsAt, originalEnd, 'mốc hết hạn giữ nguyên');
  assert.equal((await post(`/api/admin/users/${u.id}/plan`, { months: 12 }, { token })).status, 403);
});

test('đăng ký kèm trường thời hạn hoặc quyền admin: server bỏ qua', async () => {
  const far = Date.now() + clockOffset + 365 * DAY_MS;
  const reg = await registerAt('trial.gia.mao', newIp(), { trialEndsAt: far, planEndsAt: far, role: 'admin', access: { status: 'plan' } });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.user.role, 'user');
  assert.equal(reg.body.user.access.status, 'trial');
  assert.equal(reg.body.user.access.planEndsAt, null);
  assert.ok(reg.body.user.access.endsAt < far);
});

test('server tắt rồi bật lại: hạn dùng thử không được làm mới, live đã hết hạn không tự chạy lại', async () => {
  const active = await newUser('trial.khoi.dong.con.han');
  const expiring = await newUser('trial.khoi.dong.het.han');
  const device1 = await assertCanFollow(active.token, 'shop.con.han');
  const device2 = await assertCanFollow(expiring.token, 'shop.het.han');
  await advance(TRIAL_MS - 2 * MINUTE);
  await sleep(300);
  device1.close();
  device2.close();

  // Còn hạn: nối lại như bình thường, không có thêm 3 ngày.
  await restart();
  const me = await call('GET', '/api/auth/me', { token: active.token });
  assert.equal(me.body.user.access.trialEndsAt, active.access.endsAt);
  const d = await device(active.token).ready;
  await until(() => liveOf(d, 'shop.con.han')?.state === 'connected', 'live còn hạn tự nối lại', 6000);
  d.close();

  // Tắt server lúc còn hạn, bật lại khi đã hết hạn.
  await sleep(400);
  await stop(server);
  clockOffset += 3 * MINUTE;
  server = startServer();
  await waitUp();
  const after = await device(expiring.token).ready;
  await sleep(2000); // lâu hơn lượt nối lại đầu tiên
  assert.equal(after.lives.length, 0, 'không tự nối lại');
  assert.equal(after.access.status, 'expired');
  after.close();
  const state = await call('GET', '/api/state', { token: expiring.token });
  assert.equal(state.body.state.sessions.filter((s) => s.isLive).length, 0, 'phiên bị đóng');
  await assertRefused(expiring.token);
});

test('tài khoản từ trước khi có dùng thử tính 3 ngày từ ngày tạo, đặt một lần chứ không phải mỗi lần khởi động', async () => {
  const veryOld = await newUser('tk.cu.100ngay');
  const recent = await newUser('tk.cu.1ngay');
  const noDate = await newUser('tk.cu.khongngay');
  await sleep(300);
  await stop(server);

  // Giả dữ liệu cũ: không có trialEndsAt.
  const now = Date.now() + clockOffset;
  const recentCreated = now - DAY_MS;
  const db = new DatabaseSync(path.join(DATA_DIR, 'susu.db'));
  const rewrite = (id, change) => {
    const old = JSON.parse(db.prepare('SELECT data FROM users WHERE id = ?').get(id).data);
    delete old.trialEndsAt;
    change(old);
    db.prepare('UPDATE users SET data = ? WHERE id = ?').run(JSON.stringify(old), id);
  };
  rewrite(veryOld.id, (u) => (u.createdAt = now - 100 * DAY_MS));
  rewrite(recent.id, (u) => (u.createdAt = recentCreated));
  rewrite(noDate.id, (u) => delete u.createdAt);
  db.close();

  server = startServer();
  await waitUp();
  const me = async (u) => (await call('GET', '/api/auth/me', { token: u.token })).body.user.access;

  assert.equal((await me(veryOld)).status, 'expired', 'tạo đã quá 3 ngày thì khoá ngay');
  await assertRefused(veryOld.token);

  const recentAccess = await me(recent);
  assert.equal(recentAccess.status, 'trial');
  assert.equal(recentAccess.endsAt, recentCreated + TRIAL_MS, 'còn đúng phần còn lại của 3 ngày');

  const noDateAccess = await me(noDate);
  assert.equal(noDateAccess.status, 'trial', 'không rõ ngày tạo thì cho 3 ngày từ lúc cập nhật');
  assert.ok(Math.abs(noDateAccess.endsAt - now - TRIAL_MS) < 10000);

  await advance(DAY_MS);
  await restart();
  assert.equal((await me(noDate)).endsAt, noDateAccess.endsAt, 'khởi động lại không được thêm hạn');
  assert.equal((await me(recent)).endsAt, recentAccess.endsAt);

  await advance(2 * DAY_MS + 1000);
  await assertRefused(recent.token);
  await assertRefused(noDate.token);
});

test('admin không bao giờ hết hạn; tài khoản admin tạo vẫn chỉ có 3 ngày', async () => {
  const token = await adminToken();
  const created = await post('/api/admin/users/create', { username: 'do.admin.tao', password: PASSWORD, confirmPassword: PASSWORD }, { token });
  assert.equal(created.status, 200);
  assert.equal(created.body.user.access.status, 'trial');
  const login = await post('/api/auth/login', { username: 'do.admin.tao', password: PASSWORD }, { ip: newIp() });

  await advance(100 * DAY_MS);
  const fresh = await adminToken();
  const me = await call('GET', '/api/auth/me', { token: fresh });
  assert.equal(me.body.user.access.status, 'admin');
  const d = await assertCanFollow(fresh, 'shop.cua.admin');
  d.send({ type: 'disconnect' });
  d.close();

  const again = await post('/api/auth/login', { username: 'do.admin.tao', password: PASSWORD }, { ip: newIp() });
  assert.ok(login.body.token);
  await assertRefused(again.body.token);
});

/* ---------- Giới hạn tạo tài khoản ---------- */

test('một IP chỉ tạo được 2 tài khoản, IP khác vẫn tạo được', async () => {
  const ip = newIp();
  assert.equal((await registerAt('ip.mot', ip)).status, 200);
  assert.equal((await registerAt('ip.hai', ip)).status, 200);
  const third = await registerAt('ip.ba', ip);
  assert.equal(third.status, 403);
  assert.equal(third.body.code, 'IP_ACCOUNT_LIMIT');
  assert.ok(!third.body.token, 'không có phiên đăng nhập');
  assert.match(third.body.error, /2 tài khoản/);
  assert.equal((await post('/api/auth/login', { username: 'ip.ba', password: PASSWORD }, { ip })).status, 401, 'tài khoản không được tạo');
  assert.equal((await registerAt('ip.khac', newIp())).status, 200);
  // Đã đủ số lượng vẫn đăng nhập tài khoản cũ được.
  assert.equal((await post('/api/auth/login', { username: 'ip.mot', password: PASSWORD }, { ip })).status, 200);
});

test('đăng ký hỏng không bị tính; gửi cùng lúc nhiều yêu cầu cũng không lọt quá 2', async () => {
  const ip = newIp();
  assert.equal((await registerAt('x', ip)).status, 400);
  assert.equal((await post('/api/auth/register', { username: 'ip.sai', password: '123', confirmPassword: '123' }, { ip })).status, 400);
  assert.equal((await registerAt('admin', ip)).status, 409);
  assert.equal((await registerAt('ip.hop.le', ip)).status, 200, 'các lần hỏng trước không chiếm chỗ');
  assert.equal((await registerAt('ip.hop.le', ip)).status, 409);
  assert.equal((await registerAt('ip.hop.le.2', ip)).status, 200);
  assert.equal((await registerAt('ip.hop.le.3', ip)).status, 403);

  const burstIp = newIp();
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => registerAt(`ip.dong.loat.${i}`, burstIp)));
  const statuses = burst.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 403, 403, 403, 403, 403, 403]);

  // Hai yêu cầu trùng tên cùng lúc: yêu cầu thua trả lại chỗ, tài khoản thứ hai vẫn tạo được.
  const sameIp = newIp();
  const same = await Promise.all([registerAt('ip.trung', sameIp), registerAt('ip.trung', sameIp)]);
  assert.deepEqual(same.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await registerAt('ip.trung.2', sameIp)).status, 200);
  assert.equal((await registerAt('ip.trung.3', sameIp)).status, 403);
});

test('xoá tài khoản hoặc khởi động lại server không trả lại lượt tạo', async () => {
  const ip = newIp();
  const a = await registerAt('ip.xoa.mot', ip);
  await registerAt('ip.xoa.hai', ip);

  const token = await adminToken();
  const del = await call('DELETE', `/api/admin/users/${a.body.user.id}`, { token });
  assert.equal(del.status, 200);
  assert.equal((await registerAt('ip.xoa.ba', ip)).status, 403, 'xoá đi tạo lại không né được');
  // Đúng tên vừa xoá cũng vậy.
  assert.equal((await registerAt('ip.xoa.mot', ip)).status, 403);

  await restart();
  assert.equal((await registerAt('ip.xoa.bon', ip)).status, 403, 'khởi động lại không đếm lại từ đầu');
});

test('đổi cách viết IP không né được giới hạn', async () => {
  // Cùng một IPv4 viết hai kiểu.
  const v4 = '198.18.0.7';
  assert.equal((await registerAt('ip.v4.mot', v4)).status, 200);
  assert.equal((await registerAt('ip.v4.hai', `::ffff:${v4}`)).status, 200);
  assert.equal((await registerAt('ip.v4.ba', v4)).status, 403);

  // Nhà mạng cấp nguyên dải /64: đổi phần sau của IPv6 vẫn là một người.
  assert.equal((await registerAt('ip.v6.mot', '2001:db8:aaaa:1::1')).status, 200);
  assert.equal((await registerAt('ip.v6.hai', '2001:DB8:AAAA:1:ffff::2')).status, 200);
  assert.equal((await registerAt('ip.v6.ba', '2001:db8:aaaa:1:1234:5678:9abc:def0')).status, 403);
  assert.equal((await registerAt('ip.v6.khac', '2001:db8:aaaa:2::1')).status, 200);

  // Caddy nối thêm IP thật vào cuối: phần người dùng tự thêm phía trước không có tác dụng.
  const real = newIp();
  assert.equal((await registerAt('ip.chuoi.mot', `1.1.1.1, ${real}`)).status, 200);
  assert.equal((await registerAt('ip.chuoi.hai', `2.2.2.2, ${real}`)).status, 200);
  assert.equal((await registerAt('ip.chuoi.ba', `3.3.3.3, ${real}`)).status, 403);
});

test('nối thẳng vào server mà giả X-Forwarded-For: không né được giới hạn', async (t) => {
  const external = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal);
  if (!external) return t.skip('máy không có địa chỉ mạng ngoài');
  const base = `http://${external.address}:${PORT}`;
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await registerAt(`ip.gia.${i}`, `100.64.0.${i + 1}`, {}, base)).status);
  assert.deepEqual(results, [200, 200, 403, 403]);
});

test('TRUST_PROXY=1 (Render): mỗi khách là một IP, không bị tính chung IP của proxy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-proxy-'));
  const port = PORT + 100;
  const base = `http://127.0.0.1:${port}`;
  const child = startServer({ env: { TRUST_PROXY: '1' }, port, dataDir: dir, offset: 0 });
  try {
    await waitUp(base, child);
    for (const i of [1, 2, 3, 4]) {
      assert.equal((await registerAt(`proxy.${i}`, `192.0.2.${i}`, {}, base)).status, 200, `khách ${i}`);
    }
    assert.equal((await registerAt('proxy.1b', '192.0.2.1', {}, base)).status, 200);
    assert.equal((await registerAt('proxy.1c', '192.0.2.1', {}, base)).status, 403);
  } finally {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin vẫn tạo được tài khoản cho người ở IP đã đủ lượt', async () => {
  const ip = newIp();
  await registerAt('ip.day.mot', ip);
  await registerAt('ip.day.hai', ip);
  assert.equal((await registerAt('ip.day.ba', ip)).status, 403);
  const token = await adminToken();
  const created = await post('/api/admin/users/create', { username: 'ip.day.ba', password: PASSWORD, confirmPassword: PASSWORD }, { token, ip });
  assert.equal(created.status, 200);
  assert.equal((await post('/api/auth/login', { username: 'ip.day.ba', password: PASSWORD }, { ip })).status, 200);
});

/* ---------- Admin cấp gói ---------- */

test('chỉ admin mới cấp hoặc thu hồi được gói', async () => {
  const a = await newUser('goi.nguoi.thuong');
  const b = await newUser('goi.nguoi.khac');
  for (const [method, body] of [['POST', { months: 1 }], ['DELETE', undefined]]) {
    assert.equal((await call(method, `/api/admin/users/${a.id}/plan`, { body })).status, 401, 'chưa đăng nhập');
    assert.equal((await call(method, `/api/admin/users/${a.id}/plan`, { body, token: 'token-gia' })).status, 401);
    assert.equal((await call(method, `/api/admin/users/${a.id}/plan`, { body, token: a.token })).status, 403, 'tự cấp cho mình');
    assert.equal((await call(method, `/api/admin/users/${a.id}/plan`, { body, token: b.token })).status, 403, 'cấp cho người khác');
  }
  const me = await call('GET', '/api/auth/me', { token: a.token });
  assert.equal(me.body.user.access.status, 'trial');
  assert.equal(me.body.user.access.planEndsAt, null);
});

test('admin nhập số tháng sai bị từ chối, tài khoản không đổi; không cấp cho admin hay tài khoản không có', async () => {
  const u = await newUser('goi.so.sai');
  const token = await adminToken();
  for (const months of [0, -1, 1.5, 37, '1', '12', null, true, [1], {}, Infinity, 1e308]) {
    const res = await post(`/api/admin/users/${u.id}/plan`, { months }, { token });
    assert.equal(res.status, 400, `months=${JSON.stringify(months)}`);
  }
  assert.equal((await post(`/api/admin/users/${u.id}/plan`, {}, { token })).status, 400);
  const me = await call('GET', '/api/auth/me', { token: u.token });
  assert.equal(me.body.user.access.planEndsAt, null);

  assert.equal((await post('/api/admin/users/u_admin/plan', { months: 1 }, { token })).status, 400);
  assert.equal((await call('DELETE', '/api/admin/users/u_admin/plan', { token })).status, 400);
  assert.equal((await post('/api/admin/users/khong-co/plan', { months: 1 }, { token })).status, 404);
});

test('hết dùng thử → admin cấp gói → dùng được ngay, thiết bị đang mở biết liền, không mất sau khi khởi động lại', async () => {
  const u = await newUser('goi.cap.moi');
  await advance(TRIAL_MS + 1000);
  await assertRefused(u.token);

  const open = await device(u.token).ready;
  assert.equal(open.access.status, 'expired');

  const token = await adminToken();
  const grant = await post(`/api/admin/users/${u.id}/plan`, { months: 1 }, { token });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.user.access.status, 'plan');
  const now = Date.now() + clockOffset;
  assert.ok(Math.abs(grant.body.user.access.endsAt - now - PLAN_MONTH_DAYS * DAY_MS) < 5000);
  assert.ok(grant.body.users.some((x) => x.id === u.id && x.access.status === 'plan'), 'danh sách của admin cập nhật');

  await until(() => open.access.status === 'plan', 'thiết bị nhận gói mới');
  open.send({ type: 'connect', username: 'shop.co.goi' });
  await connected(open, 'shop.co.goi');
  open.send({ type: 'disconnect' });
  await sleep(100);
  open.close();

  // Cấp ghi xuống đĩa ngay: mất điện liền sau đó cũng không mất gói đã bán.
  await stop(server);
  server = startServer();
  await waitUp();
  const me = await call('GET', '/api/auth/me', { token: u.token });
  assert.equal(me.body.user.access.status, 'plan');
  assert.equal(me.body.user.access.endsAt, grant.body.user.access.endsAt);
});

test('còn hạn thì cộng nối tiếp; hết gói thì live dừng và báo hết gói', async () => {
  const u = await newUser('goi.gia.han');
  const token = await adminToken();
  const first = await post(`/api/admin/users/${u.id}/plan`, { months: 1 }, { token });
  const second = await post(`/api/admin/users/${u.id}/plan`, { months: 3 }, { token });
  const firstEnd = first.body.user.access.endsAt;
  const secondEnd = second.body.user.access.endsAt;
  assert.equal(secondEnd, firstEnd + 3 * PLAN_MONTH_DAYS * DAY_MS);

  const d = await assertCanFollow(u.token, 'shop.goi.chay');
  // Qua 3 ngày dùng thử vẫn chạy vì có gói.
  await advance(TRIAL_MS + DAY_MS);
  await sleep(5500);
  assert.equal(liveOf(d, 'shop.goi.chay')?.state, 'connected');

  await advance(secondEnd - (Date.now() + clockOffset) + 1000);
  await until(() => d.lives.length === 0, 'live dừng khi hết gói', SWEEP_WAIT_MS);
  await until(() => d.messages.some((m) => m.type === 'status' && m.code === 'PLAN_EXPIRED'), 'báo hết gói');
  assert.match(d.messages.find((m) => m.code === 'PLAN_EXPIRED').message, /Gói của bạn đã hết hạn/);
  d.close();
  // Đã qua 30 ngày nên token cũ cũng hết hiệu lực: đăng nhập lại rồi mới thử.
  const relogin = await post('/api/auth/login', { username: 'goi.gia.han', password: PASSWORD }, { ip: newIp() });
  await assertRefused(relogin.body.token, 'shop.goi.xin.lai', 'PLAN_EXPIRED');

  // Cấp lại sau khi hết: tính từ lúc cấp, không phải từ ngày hết hạn cũ.
  const again = await post(`/api/admin/users/${u.id}/plan`, { months: 1 }, { token: await adminToken() });
  const now = Date.now() + clockOffset;
  assert.ok(Math.abs(again.body.user.access.endsAt - now - PLAN_MONTH_DAYS * DAY_MS) < 5000);
});

test('thu hồi gói: live dừng ngay nếu hết dùng thử; còn dùng thử thì chạy tiếp', async () => {
  const late = await newUser('goi.thu.hoi');
  const stillTrial = await newUser('goi.thu.hoi.con.trial');
  let token = await adminToken();
  await post(`/api/admin/users/${late.id}/plan`, { months: 1 }, { token });
  await advance(TRIAL_MS + 1000);
  token = await adminToken();
  const d = await assertCanFollow(late.token, 'shop.se.thu.hoi');

  const revoke = await call('DELETE', `/api/admin/users/${late.id}/plan`, { token });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.user.access.status, 'expired');
  assert.equal(revoke.body.user.access.code, 'TRIAL_EXPIRED');
  await until(() => d.lives.length === 0, 'dừng ngay, không chờ lượt rà', 1500);
  d.close();
  await assertRefused(late.token);

  // Tài khoản này đăng ký cùng lúc nên cũng đã hết dùng thử: cấp rồi thu hồi vẫn về hết hạn.
  await post(`/api/admin/users/${stillTrial.id}/plan`, { months: 1 }, { token });
  const fresh = await newUser('goi.thu.hoi.moi');
  await post(`/api/admin/users/${fresh.id}/plan`, { months: 1 }, { token });
  const freshLive = await assertCanFollow(fresh.token, 'shop.con.dung.thu');
  const back = await call('DELETE', `/api/admin/users/${fresh.id}/plan`, { token });
  assert.equal(back.body.user.access.status, 'trial');
  await sleep(300);
  assert.equal(liveOf(freshLive, 'shop.con.dung.thu')?.state, 'connected');
  freshLive.close();
});

test('server có token đã hết hạn lúc khởi động vẫn lên được', async () => {
  const u = await newUser('token.cu');
  await sleep(300);
  await stop(server);
  clockOffset += 40 * DAY_MS;
  server = startServer();
  await waitUp();
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).status, 401, 'token cũ hết hiệu lực');
});

/* ---------- Logic thuần ---------- */

test('accessOf: thiếu mốc thời gian là hết hạn, không phải miễn phí mãi', () => {
  const now = 1_000_000;
  assert.equal(accessOf({ role: 'user' }, now).canFollowLive, false);
  assert.equal(accessOf({ role: 'user', trialEndsAt: 'mai' }, now).canFollowLive, false);
  assert.equal(accessOf({ role: 'user', trialEndsAt: NaN }, now).canFollowLive, false);
  assert.equal(accessOf({ role: 'user', trialEndsAt: now }, now).canFollowLive, false, 'đúng mốc là hết');
  assert.equal(accessOf({ role: 'user', trialEndsAt: now + 1 }, now).status, 'trial');
  assert.equal(accessOf({ role: 'user', trialEndsAt: 1, planEndsAt: now + 1 }, now).status, 'plan');
  assert.equal(accessOf({ role: 'user', trialEndsAt: 1, planEndsAt: now }, now).code, 'PLAN_EXPIRED');
  assert.equal(accessOf({ role: 'admin' }, now).status, 'admin');
  assert.equal(accessOf(null, now).canFollowLive, false);
});

test('extendedPlanEnd: nối tiếp khi còn hạn, tính từ lúc cấp khi hết hạn, không tràn số', () => {
  const now = 1000;
  const month = PLAN_MONTH_DAYS * DAY_MS;
  assert.equal(extendedPlanEnd(undefined, 1, now), now + month);
  assert.equal(extendedPlanEnd(500, 1, now), now + month);
  assert.equal(extendedPlanEnd(now + 5, 2, now), now + 5 + 2 * month);
  assert.ok(extendedPlanEnd(now + 3650 * DAY_MS, 36, now) <= now + 3650 * DAY_MS);
});

test('ipKey và parseTrustProxy', () => {
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('::FFFF:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('2001:DB8::1'), ipKey('2001:0db8:0:0:9::2'));
  assert.equal(ipKey('fe80::1%eth0'), ipKey('fe80::2'));
  assert.notEqual(ipKey('2001:db8:0:1::'), ipKey('2001:db8:0:2::'));
  assert.equal(ipKey(''), 'unknown');
  assert.equal(ipKey(undefined), 'unknown');

  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy(' 2 '), 2);
  assert.equal(parseTrustProxy(''), 'loopback');
  assert.equal(parseTrustProxy(undefined), 'loopback');
  assert.equal(parseTrustProxy('loopback, 10.0.0.1'), 'loopback, 10.0.0.1');
});
