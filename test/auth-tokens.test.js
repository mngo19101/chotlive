/**
 * AUTH-03: token phiên không được nằm dạng rõ trong susu.db (đi theo bản sao lưu).
 * AUTH-01: bộ đếm sai mật khẩu theo IP phải gộp cả dải IPv6 /64 như phần đăng ký.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-tokens-'));
const DB_FILE = path.join(DATA_DIR, 'susu.db');
const PORT = 4700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;

async function start() {
  server = spawn(process.execPath, ['--no-warnings', '--import', './test/fake-tiktok/register.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'admin-test-password', LAN_MODE: '' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await sleep(50);
  }
  assert.fail('server không khởi động');
}

async function stop() {
  // Server ghi tài khoản/token sau 80ms; trên Windows kill là dừng cứng, nên đợi ghi xong.
  await sleep(400);
  const gone = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await Promise.race([gone, sleep(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await sleep(150);
  server = null;
}

async function post(url, body, { token, ip } = {}) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const me = async (token) => (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status;

/** Mọi chuỗi trong mọi bảng của susu.db (cả file -wal). */
function dbText() {
  return ['', '-wal']
    .map((s) => (fs.existsSync(DB_FILE + s) ? fs.readFileSync(DB_FILE + s).toString('latin1') : ''))
    .join('\n');
}

after(async () => {
  if (server) await stop();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('AUTH-03: token phiên lưu dạng băm, không có token rõ trong susu.db; đăng xuất và đổi mật khẩu vẫn thu hồi đúng', async () => {
  await start();
  const reg = await post('/api/auth/register', { username: 'shop.bam', password: 'mat-khau-tot', confirmPassword: 'mat-khau-tot' }, { ip: '198.51.100.1' });
  assert.equal(reg.status, 200);
  const t1 = reg.body.token;
  const t2 = (await post('/api/auth/login', { username: 'shop.bam', password: 'mat-khau-tot' }, { ip: '198.51.100.1' })).body.token;
  const t3 = (await post('/api/auth/login', { username: 'shop.bam', password: 'mat-khau-tot' }, { ip: '198.51.100.1' })).body.token;
  assert.equal(await me(t1), 200);
  await stop();

  const text = dbText();
  for (const t of [t1, t2, t3]) assert.ok(!text.includes(t), 'token rõ còn trong susu.db');
  const sha = crypto.createHash('sha256').update(t1).digest('hex');
  assert.ok(text.includes(sha), 'phải lưu sha256(token)');

  await start();
  assert.equal(await me(t1), 200, 'token còn dùng được sau khi khởi động lại');
  assert.equal(await me(sha), 401, 'chuỗi băm lấy từ bản sao lưu không đăng nhập được');
  assert.equal((await post('/api/auth/logout', {}, { token: t3 })).status, 200);
  assert.equal(await me(t3), 401, 'đăng xuất xoá đúng token');
  const cp = await post('/api/auth/change-password', { currentPassword: 'mat-khau-tot', newPassword: 'mat-khau-moi', confirmPassword: 'mat-khau-moi' }, { token: t1 });
  assert.equal(cp.status, 200);
  assert.equal(await me(t1), 200, 'thiết bị đổi mật khẩu vẫn giữ phiên');
  assert.equal(await me(t2), 401, 'thiết bị khác bị đăng xuất');
  await stop();
});

test('AUTH-03: token cũ lưu dạng rõ được chuyển sang dạng băm khi khởi động, vẫn đăng nhập được', async () => {
  const db = new DatabaseSync(DB_FILE);
  const userId = JSON.parse(db.prepare('SELECT data FROM users').all().map((r) => r.data).find((d) => d.includes('shop.bam'))).id;
  const legacy = crypto.randomBytes(28).toString('hex');
  db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(legacy, userId, Date.now());
  db.close();

  await start();
  assert.equal(await me(legacy), 200);
  await stop();
  assert.ok(!dbText().includes(legacy), 'token rõ cũ phải biến khỏi susu.db');
  await start();
  assert.equal(await me(legacy), 200, 'vẫn dùng được sau lần khởi động thứ hai');
  await stop();
});

test('AUTH-01: sai mật khẩu từ nhiều địa chỉ IPv6 cùng dải /64 bị tính chung', async () => {
  await start();
  const owner = '198.51.100.9';
  await post('/api/auth/register', { username: 'shop.v6', password: 'mat-khau-tot', confirmPassword: 'mat-khau-tot' }, { ip: owner });
  for (let i = 0; i < 10; i++) {
    const r = await post('/api/auth/login', { username: 'shop.v6', password: `sai-${i}` }, { ip: `2001:db8:1:2::${(i + 1).toString(16)}` });
    assert.equal(r.status, 401);
  }
  const blocked = await post('/api/auth/login', { username: 'shop.v6', password: 'sai' }, { ip: '2001:db8:1:2::ff' });
  assert.equal(blocked.status, 429);
  // Dải /64 khác và IPv4 của chủ shop không bị ảnh hưởng.
  assert.equal((await post('/api/auth/login', { username: 'shop.v6', password: 'mat-khau-tot' }, { ip: '2001:db8:1:3::1' })).status, 200);
  assert.equal((await post('/api/auth/login', { username: 'shop.v6', password: 'mat-khau-tot' }, { ip: owner })).status, 200);
  await stop();
});
