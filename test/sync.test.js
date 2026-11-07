/**
 * Đồng bộ hai máy: chạy thật qua HTTP giữa hai thư mục dữ liệu riêng.
 * Điều quan trọng nhất cần giữ: không tình huống nào được làm mất dữ liệu của cả hai máy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { openDb } from '../db.js';
import { authHeaders, createContext, inspectDb, readState, runCycle, startHub, updateState } from '../sync/core.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susu-sync-'));
const servers = [];
let closedPort;
let counter = 0;

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

before(async () => {
  const s = http.createServer();
  closedPort = await listen(s);
  await close(s);
});

after(async () => {
  await Promise.all(servers.map(close));
  fs.rmSync(root, { recursive: true, force: true });
});

function writeOrders(dir, ids, { login } = {}) {
  const db = openDb(path.join(dir, 'susu.db'));
  db.exec('DELETE FROM orders; DELETE FROM users;');
  db.prepare('INSERT INTO users (id, data) VALUES (?, ?)').run('u1', JSON.stringify({ id: 'u1', username: 'admin', lastLoginAt: login || 1 }));
  ids.forEach((id, i) => db.prepare('INSERT INTO orders (user_id, id, pos, data) VALUES (?, ?, ?, ?)').run('u1', id, i, JSON.stringify({ id })));
  db.close();
}

function readOrders(dir) {
  const db = new DatabaseSync(path.join(dir, 'susu.db'), { readOnly: true });
  try {
    return db.prepare('SELECT id FROM orders ORDER BY pos').all().map((r) => r.id);
  } finally {
    db.close();
  }
}

const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const countDb = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.db')).length;

/** Một cặp laptop + mini PC mới tinh, nối với nhau qua cổng thật. */
async function pair({ key = 'ma-chung', laptopKey } = {}) {
  const id = ++counter;
  const hubDir = path.join(root, `hub${id}`);
  const laptopDir = path.join(root, `laptop${id}`);
  const hubCtx = createContext({ dataDir: hubDir, name: 'minipc', config: { key, serve: true, port: 0, appPort: closedPort } });
  const server = await startHub(hubCtx);
  servers.push(server);
  const laptopCtx = createContext({
    dataDir: laptopDir,
    name: 'laptop',
    config: { key: laptopKey || key, peerAddress: '127.0.0.1', peerPort: server.address().port, appPort: closedPort }
  });
  return { hubDir, laptopDir, hubCtx, laptopCtx, server };
}

test('chưa thêm mini PC: không lỗi, vẫn tự lưu bản sao trên máy này', async () => {
  const dir = path.join(root, 'alone');
  writeOrders(dir, ['a']);
  const ctx = createContext({ dataDir: dir, name: 'laptop', config: { key: 'k', appPort: closedPort } });
  assert.equal((await runCycle(ctx)).code, 'no-peer');
  assert.equal(countDb(path.join(ctx.workDir, 'own')), 1);
});

test('lần đầu: mini PC trống nhận toàn bộ dữ liệu từ laptop', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a', 'b']);
  assert.equal((await runCycle(laptopCtx)).code, 'uploaded');
  assert.deepEqual(readOrders(hubDir), ['a', 'b']);
  assert.equal((await runCycle(laptopCtx)).code, 'in-sync');
});

test('máy mới thay (trống) tự lấy lại toàn bộ dữ liệu từ máy còn lại', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(hubDir, ['a', 'b', 'c']);
  writeOrders(laptopDir, []);
  assert.equal((await runCycle(laptopCtx)).code, 'adopted');
  assert.deepEqual(readOrders(laptopDir), ['a', 'b', 'c']);
});

test('chỉ mini PC đổi: laptop tự nhận và lưu lại bản cũ trước khi thay', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(hubDir, ['a', 'b']);
  assert.equal((await runCycle(laptopCtx)).code, 'adopted');
  assert.deepEqual(readOrders(laptopDir), ['a', 'b']);
  assert.equal(countDb(path.join(laptopCtx.workDir, 'before-replace')), 1);
  assert.equal(fs.existsSync(path.join(laptopDir, 'susu.db-wal')), false);
});

test('chỉ laptop đổi: mini PC tự nhận', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(laptopDir, ['a', 'b']);
  assert.equal((await runCycle(laptopCtx)).code, 'uploaded');
  assert.deepEqual(readOrders(hubDir), ['a', 'b']);
});

test('chỉ đăng nhập (đổi lastLoginAt) thì không tính là có thay đổi', async () => {
  const { laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(laptopDir, ['a'], { login: 999 });
  assert.equal((await runCycle(laptopCtx)).code, 'in-sync');
});

test('cả hai cùng đổi: không ghi đè, mỗi bên cất thêm bản của bên kia, người dùng chọn thì mới thống nhất', async () => {
  const { hubDir, laptopDir, hubCtx, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(laptopDir, ['a', 'laptop']);
  writeOrders(hubDir, ['a', 'hub']);

  assert.equal((await runCycle(laptopCtx)).code, 'conflict');
  assert.deepEqual(readOrders(laptopDir), ['a', 'laptop']);
  assert.deepEqual(readOrders(hubDir), ['a', 'hub']);
  const laptopCopies = countDb(path.join(laptopCtx.workDir, 'received'));
  const hubCopies = countDb(path.join(hubCtx.workDir, 'received'));
  assert.equal(laptopCopies, 1); // bản của mini PC
  assert.equal(hubCopies, 2); // bản gửi lần đầu và bản của laptop lúc xung đột

  // Chạy lại không được gửi lặp các bản đã có.
  assert.equal((await runCycle(laptopCtx)).code, 'conflict');
  assert.equal(countDb(path.join(laptopCtx.workDir, 'received')), laptopCopies);
  assert.equal(countDb(path.join(hubCtx.workDir, 'received')), hubCopies);

  updateState(laptopCtx, { force: 'mine' });
  assert.equal((await runCycle(laptopCtx)).code, 'uploaded');
  assert.deepEqual(readOrders(hubDir), ['a', 'laptop']);
  assert.equal(readState(laptopCtx).force, null);
  assert.equal((await runCycle(laptopCtx)).code, 'in-sync');
});

test('khi có xung đột có thể chọn dùng bản của mini PC', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(laptopDir, ['a', 'laptop']);
  writeOrders(hubDir, ['a', 'hub']);
  await runCycle(laptopCtx);
  updateState(laptopCtx, { force: 'peer' });
  assert.equal((await runCycle(laptopCtx)).code, 'adopted');
  assert.deepEqual(readOrders(laptopDir), ['a', 'hub']);
});

test('mini PC hỏng rồi cài lại (trống): laptop không bị xoá mà gửi lại dữ liệu', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a', 'b']);
  await runCycle(laptopCtx);
  writeOrders(hubDir, []);
  assert.equal((await runCycle(laptopCtx)).code, 'uploaded');
  assert.deepEqual(readOrders(laptopDir), ['a', 'b']);
  assert.deepEqual(readOrders(hubDir), ['a', 'b']);
});

test('một bên bỗng mất hơn nửa dữ liệu: không lan sang bên kia, theo cả hai chiều', async () => {
  const full = range('o', 30);
  const part = range('o', 5);

  const a = await pair();
  writeOrders(a.laptopDir, full);
  await runCycle(a.laptopCtx);
  writeOrders(a.hubDir, part);
  assert.equal((await runCycle(a.laptopCtx)).code, 'guard-peer-shrank');
  assert.equal(readOrders(a.laptopDir).length, 30);

  const b = await pair();
  writeOrders(b.laptopDir, full);
  await runCycle(b.laptopCtx);
  writeOrders(b.laptopDir, part);
  assert.equal((await runCycle(b.laptopCtx)).code, 'guard-local-shrank');
  assert.equal(readOrders(b.hubDir).length, 30);
});

test('server trên laptop đang chạy: chỉ tải về, tắt server rồi mới áp dụng', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(hubDir, ['a', 'b']);

  const fakeApp = http.createServer((_req, res) => res.end('ok'));
  servers.push(fakeApp);
  laptopCtx.config.appPort = await listen(fakeApp);
  assert.equal((await runCycle(laptopCtx)).code, 'waiting-app');
  assert.deepEqual(readOrders(laptopDir), ['a']);
  await close(fakeApp);
  laptopCtx.config.appPort = closedPort;

  assert.equal((await runCycle(laptopCtx)).code, 'adopted');
  assert.deepEqual(readOrders(laptopDir), ['a', 'b']);
});

test('server trên mini PC đang chạy: giữ bản sao, tắt server rồi lượt sau mới áp dụng', async () => {
  const { hubDir, laptopDir, hubCtx, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(laptopDir, ['a', 'b']);

  const fakeApp = http.createServer((_req, res) => res.end('ok'));
  servers.push(fakeApp);
  hubCtx.config.appPort = await listen(fakeApp);
  assert.equal((await runCycle(laptopCtx)).code, 'waiting-peer');
  assert.deepEqual(readOrders(hubDir), ['a']);
  const copies = countDb(path.join(hubCtx.workDir, 'received'));
  assert.equal((await runCycle(laptopCtx)).code, 'waiting-peer');
  assert.equal(countDb(path.join(hubCtx.workDir, 'received')), copies); // không gửi lặp
  await close(fakeApp);
  hubCtx.config.appPort = closedPort;

  assert.equal((await runCycle(hubCtx)).code, 'hub');
  assert.deepEqual(readOrders(hubDir), ['a', 'b']);
  assert.equal((await runCycle(laptopCtx)).code, 'in-sync');
});

test('file đang bị chương trình khác mở: không thay, dữ liệu còn nguyên', { skip: process.platform !== 'win32' }, async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  await runCycle(laptopCtx);
  writeOrders(hubDir, ['a', 'b']);
  const holder = new DatabaseSync(path.join(laptopDir, 'susu.db'));
  try {
    assert.equal((await runCycle(laptopCtx)).code, 'waiting-app');
  } finally {
    holder.close();
  }
  assert.deepEqual(readOrders(laptopDir), ['a']);
  assert.equal((await runCycle(laptopCtx)).code, 'adopted');
});

test('sai mã kết nối: bị từ chối, không máy nào đổi dữ liệu', async () => {
  const { hubDir, laptopDir, laptopCtx } = await pair({ laptopKey: 'ma-sai' });
  writeOrders(hubDir, ['hub']);
  writeOrders(laptopDir, ['laptop']);
  assert.equal((await runCycle(laptopCtx)).code, 'bad-key');
  assert.deepEqual(readOrders(hubDir), ['hub']);
  assert.deepEqual(readOrders(laptopDir), ['laptop']);
});

test('mini PC tắt: báo chưa kết nối được, dữ liệu laptop không đổi', async () => {
  const { laptopDir, laptopCtx } = await pair();
  writeOrders(laptopDir, ['a']);
  laptopCtx.config.peerPort = closedPort;
  assert.equal((await runCycle(laptopCtx)).code, 'offline');
  assert.deepEqual(readOrders(laptopDir), ['a']);
});

test('dữ liệu truyền qua mạng đã mã hoá; thiếu chữ ký thì không lấy được', async () => {
  const { hubDir, server, hubCtx } = await pair();
  writeOrders(hubDir, ['khach-bi-mat']);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/sync/snapshot`)).status, 401);
  const res = await fetch(`${base}/sync/snapshot`, { headers: authHeaders(hubCtx, 'GET', '/sync/snapshot') });
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200);
  assert.equal(body.includes('SQLite format 3'), false);
  assert.equal(body.includes('khach-bi-mat'), false);
});

test('bản gửi đến bị cắt hoặc sửa thì bị từ chối, dữ liệu mini PC còn nguyên', async () => {
  const { hubDir, server, hubCtx } = await pair();
  writeOrders(hubDir, ['a']);
  const url = '/sync/snapshot?from=x&base=';
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST',
    headers: authHeaders(hubCtx, 'POST', url),
    body: Buffer.alloc(4096, 7)
  });
  assert.equal(res.status, 500);
  assert.deepEqual(readOrders(hubDir), ['a']);
  assert.equal(countDb(path.join(hubCtx.workDir, 'received')), 0);
  assert.ok(inspectDb(path.join(hubDir, 'susu.db')).hash);
});
