/**
 * Chạy server thật (dữ liệu tạm, TikTok giả) rồi nối nhiều thiết bị vào như ngoài đời:
 * web và app cùng tài khoản, rớt mạng, khởi động lại server.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'susu-test-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  assert.fail(`Quá giờ chờ: ${label}`);
}

function startServer() {
  const child = spawn(process.execPath, ['--no-warnings', '--import', './test/fake-tiktok/register.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'admin-test' },
    stdio: 'ignore'
  });
  return child;
}

async function waitUp() {
  await until(async () => {
    try {
      return (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 'server khởi động');
}

async function stopServer(child) {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([gone, sleep(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(100);
}

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) }
  });
  return { status: res.status, body: await res.json() };
}

function device({ native = false, delta = true } = {}) {
  const url = `ws://127.0.0.1:${PORT}/ws?token=${token}${native ? '&native=1' : ''}`;
  const ws = new WebSocket(url);
  const d = { ws, messages: [], chats: [], lives: [], hello: null, snapshot: null, send: (m) => ws.send(JSON.stringify(m)) };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    d.messages.push(m);
    if (m.type === 'hello') {
      d.hello = m;
      if (m.lives) d.lives = m.lives;
      if (m.snapshot) d.snapshot = m.snapshot;
    }
    if (m.type === 'chat') d.chats.push(m);
    if (m.type === 'lives') d.lives = m.lives;
    if (m.type === 'native_state') d.snapshot = m.snapshot;
  });
  ws.on('error', () => {});
  d.opened = new Promise((r) => ws.once('open', r)).then(async () => {
    if (!native) d.send({ type: 'auth', token, delta });
    await until(() => d.hello, 'nhận hello');
    return d;
  });
  d.close = () => {
    try {
      ws.terminate();
    } catch {}
  };
  return d;
}

before(async () => {
  server = startServer();
  await waitUp();
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'shop.test', password: 'mat-khau', confirmPassword: 'mat-khau' })
  });
  token = reg.body.token;
  assert.ok(token);
});

after(async () => {
  if (server) await stopServer(server);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('web và app nhận cùng bình luận; server giữ được nhiều hơn giới hạn 60 cũ, không trùng', async () => {
  const web = await device().opened;
  const app = await device({ native: true }).opened;
  web.send({ type: 'connect', username: 'shop.one' });
  await until(() => web.chats.length >= 70, 'đủ 70 bình luận', 20000);
  web.send({ type: 'disconnect', username: 'shop.one' });
  await until(() => web.lives.length === 0, 'dừng live');
  await sleep(100);

  assert.equal(new Set(web.chats.map((c) => c.id)).size, web.chats.length, 'không trùng');
  assert.deepEqual(app.chats.map((c) => c.id), web.chats.map((c) => c.id), 'hai thiết bị nhận như nhau');

  const stored = await api(`/api/comments?limit=1000`);
  assert.equal(stored.body.comments.length, web.chats.length, 'server lưu đủ, không chỉ 60');
  const chot = stored.body.comments.find((c) => /^Chốt/.test(c.comment));
  assert.ok(chot.price > 0, 'server tự bắt giá');
  assert.ok(chot.sessionId);

  const st = await api('/api/state');
  assert.equal(st.body.state.sessions.length, 1, 'phiên được ghi lại');
  assert.equal(st.body.state.sessions[0].commentCount, web.chats.length);
  assert.equal(st.body.state.sessions[0].isLive, false);
  assert.ok(st.body.state.sessions[0].priceCount > 0);
  web.close();
  app.close();
});

test('xem bình luận cũ theo từng trang qua API: đủ, không lặp, đúng định dạng cho app', async () => {
  const all = (await api('/api/comments?limit=1000&format=native')).body.comments;
  assert.ok(all.length > 10, 'có đủ bình luận để chia trang');
  const seen = [];
  let query = '';
  for (let guard = 0; guard < 500; guard++) {
    const { body } = await api(`/api/comments?limit=7&format=native${query}`);
    assert.equal(typeof body.comments[0].text, 'string');
    seen.push(...body.comments.map((c) => c.id));
    if (!body.hasMore) break;
    const last = body.comments[body.comments.length - 1];
    query = `&before=${last.ts}&beforeId=${encodeURIComponent(last.id)}`;
  }
  assert.deepEqual(seen, all.map((c) => c.id));
});

test('thiết bị đẩy dữ liệu lên không làm mất bình luận của nhau', async () => {
  const web = await device().opened;
  const before = (await api('/api/comments?limit=1000')).body.comments.length;
  assert.ok(before > 60);
  // Thiết bị bản cũ gửi danh sách ngắn như trước.
  web.send({ type: 'sync_update', clientId: 'old', state: { comments: [{ id: 'chi-mot-cai', ts: Date.now(), comment: 'x' }] } });
  await until(() => web.messages.some((m) => m.type === 'sync_ack'), 'ack');
  const st = await api('/api/state');
  assert.ok(st.body.state.comments.length >= before, 'danh sách không bị thu ngắn');
  const stored = await api('/api/comments?limit=1000');
  assert.equal(stored.body.comments.length, before + 1);
  web.close();
});

test('theo dõi nhiều live cùng lúc, dừng riêng từng live', async () => {
  const web = await device().opened;
  web.send({ type: 'connect', username: 'shop.a' });
  web.send({ type: 'connect', username: 'https://www.tiktok.com/@shop.b/live' });
  await until(() => web.lives.filter((l) => l.state === 'connected').length === 2, 'cả hai live chạy');
  assert.deepEqual(web.lives.map((l) => l.username).sort(), ['shop.a', 'shop.b'], 'đọc được tên từ link');
  await until(() => new Set(web.chats.map((c) => c.live)).size === 2, 'bình luận của cả hai live');
  const byLive = Object.fromEntries(web.lives.map((l) => [l.username, l.sessionId]));
  assert.notEqual(byLive['shop.a'], byLive['shop.b'], 'mỗi live một phiên');
  for (const c of web.chats) assert.equal(c.sessionId, byLive[c.live], 'bình luận vào đúng phiên');

  web.send({ type: 'disconnect', username: 'shop.a' });
  await until(() => web.lives.length === 1, 'dừng shop.a');
  assert.equal(web.lives[0].username, 'shop.b');
  const seen = web.chats.length;
  await until(() => web.chats.length > seen + 2, 'shop.b vẫn chạy');
  web.send({ type: 'disconnect' });
  await until(() => web.lives.length === 0, 'dừng tất cả');

  const sess = await api(`/api/comments?sessionId=${byLive['shop.b']}&limit=1000`);
  assert.ok(sess.body.comments.every((c) => c.live === 'shop.b'), 'lọc theo phiên đúng');
  web.close();
});

test('live rớt kết nối thì tự nối lại trong cùng phiên, tin gửi lại không bị trùng', async () => {
  const web = await device().opened;
  web.send({ type: 'connect', username: 'flaky.shop' });
  await until(() => web.lives.some((l) => l.state === 'reconnecting'), 'báo đang nối lại');
  const sid = web.lives[0].sessionId;
  await until(() => web.chats.filter((c) => c.live === 'flaky.shop').length > 12, 'có bình luận sau khi nối lại', 15000);
  assert.equal(web.lives[0].sessionId, sid, 'vẫn phiên cũ');
  const mine = web.chats.filter((c) => c.live === 'flaky.shop');
  assert.equal(new Set(mine.map((c) => c.id)).size, mine.length, 'lô gửi lại lúc nối lại không tạo trùng');
  web.send({ type: 'disconnect' });
  await until(() => web.lives.length === 0, 'dừng');
  web.close();
});

test('thiết bị mất mạng giữa phiên: bình luận vẫn được server lưu, nối lại lấy được đủ', async () => {
  const web = await device().opened;
  web.send({ type: 'connect', username: 'shop.gap' });
  await until(() => web.chats.length >= 2, 'bắt đầu có bình luận');
  // Cả thiết bị đều mất mạng, không ai đang nghe.
  const lastSeen = Math.max(...web.chats.map((c) => c.ts));
  const seenCount = web.chats.length;
  web.close();
  await sleep(1200);

  const web2 = await device().opened;
  const missed = await api(`/api/comments?since=${lastSeen}&limit=1000&format=native`);
  assert.ok(missed.body.comments.length > 3, 'có bình luận trong lúc không ai mở app');
  assert.equal(typeof missed.body.comments[0].text, 'string', 'định dạng cho app');
  const session = web2.hello.state.sessions.find((s) => s.tiktok === 'shop.gap');
  assert.ok(session.commentCount > seenCount, 'bộ đếm phiên tính cả lúc không có thiết bị nào');
  assert.equal(web2.lives[0].username, 'shop.gap', 'mở lại thấy live vẫn đang theo dõi');
  web2.send({ type: 'disconnect' });
  await until(() => web2.lives.length === 0, 'dừng');
  web2.close();
});

test('app gửi đơn lên thì web nhận được, web sửa thì app nhận được', async () => {
  const web = await device().opened;
  const app = await device({ native: true }).opened;

  app.send({
    type: 'native_update',
    id: 7,
    customers: [
      {
        id: 'mai.pham',
        uniqueId: 'mai.pham',
        userId: '72538194012',
        nickname: 'Mai Phạm',
        items: [
          { id: 'cmt-app-1', comment: 'Chốt 120', price: 120000, ts: Date.now(), qty: 1, groupId: 'g1', code: '120', commentId: 'cmt-app-1', printed: true }
        ]
      }
    ]
  });
  const ack = await until(() => app.messages.find((m) => m.type === 'native_ack'), 'app được xác nhận');
  assert.equal(ack.id, 7);

  const delta = await until(
    () => web.messages.find((m) => m.type === 'state_delta' && m.collections?.orders),
    'web nhận đơn mới'
  );
  const webOrder = delta.collections.orders.upsert[0];
  assert.equal(webOrder.uniqueId, 'mai.pham');
  assert.equal(webOrder.status, 'printed');
  assert.ok(delta.collections.customers.upsert.some((c) => c.uniqueId === 'mai.pham'));

  // App nhận lại bản chuẩn của server.
  await until(() => app.snapshot?.customers?.some((c) => c.id === 'mai.pham'), 'app nhận lại khách');

  // Web đổi trạng thái đơn.
  const st = (await api('/api/state')).body.state;
  const orders = st.orders.map((o) => (o.id === webOrder.id ? { ...o, status: 'shipping' } : o));
  web.send({ type: 'sync_update', clientId: 'web1', action: 'order_status', state: { orders } });
  await until(() => {
    const c = app.snapshot.customers.find((x) => x.id === 'mai.pham');
    return c?.items[0].shipping === true;
  }, 'app thấy đơn đang giao');
  web.close();
  app.close();
});

test('địa chỉ server không bị đồng bộ sang thiết bị khác', async () => {
  const web = await device().opened;
  web.send({ type: 'sync_update', clientId: 'web1', state: { settings: { shopName: 'Shop A', serverUrl: 'http://localhost:3000' } } });
  await until(() => web.messages.some((m) => m.type === 'sync_ack'), 'ack');
  const st = (await api('/api/state')).body.state;
  assert.equal(st.settings.shopName, 'Shop A');
  assert.ok(!st.settings.serverUrl, 'không lưu serverUrl');
  web.close();
});

test('tối đa 10 live; live lỗi báo đúng cho người dùng', async () => {
  const web = await device().opened;
  web.send({ type: 'connect', username: 'offline.shop' });
  const err = await until(() => web.messages.find((m) => m.type === 'status' && m.state === 'error'), 'báo lỗi');
  assert.match(err.message, /không livestream/);
  assert.equal(web.lives.length, 0);
  for (let i = 0; i < 11; i++) web.send({ type: 'connect', username: `many.${i}` });
  await until(() => web.lives.length === 10, 'đủ 10 live');
  const limit = await until(() => web.messages.find((m) => /tối đa/.test(m.message || '')), 'báo giới hạn');
  assert.equal(limit.username, 'many.10');
  web.send({ type: 'disconnect' });
  await until(() => web.lives.length === 0, 'dừng tất cả');
  web.close();
});

test('server khởi động lại giữa phiên: dữ liệu còn nguyên và tự theo dõi lại live', async () => {
  let web = await device().opened;
  web.send({ type: 'connect', username: 'shop.restart' });
  await until(() => web.chats.length >= 3, 'có bình luận');
  const sessionId = web.lives[0].sessionId;
  const countBefore = (await api(`/api/comments?sessionId=${sessionId}&limit=1000`)).body.comments.length;
  web.close();

  await stopServer(server);
  server = startServer();
  await waitUp();

  web = await device().opened;
  await until(() => web.lives.some((l) => l.username === 'shop.restart' && l.state === 'connected'), 'tự nối lại live', 10000);
  assert.equal(web.lives[0].sessionId, sessionId, 'tiếp tục đúng phiên cũ');
  await until(async () => {
    const r = await api(`/api/comments?sessionId=${sessionId}&limit=1000`);
    return r.body.comments.length > countBefore;
  }, 'có thêm bình luận');
  web.send({ type: 'disconnect' });
  await until(() => web.lives.length === 0, 'dừng');
  web.close();
});
