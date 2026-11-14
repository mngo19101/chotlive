/**
 * INJ-01, INJ-02, INJ-03 trong audit/04-injection-input.md: một tài khoản dùng thử (hoặc người lạ chưa đăng nhập)
 * không được làm treo, đầy đĩa hay hết bộ nhớ server của mọi shop.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { extractProductInfo, parsePrice } from '../public/js/price.js';
import { cleanNativeUpdate, cleanState } from '../validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-inj-'));
const PORT = 4200 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = (fn) => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

/* ---------------- INJ-01: regex địa chỉ ---------------- */

test('INJ-01: bình luận dài toàn từ khoá ngắn không làm treo hàm nhận diện', () => {
  const inputs = {
    'o o o … 64k': 'o '.repeat(32000),
    'dc dc … 64k': 'dc '.repeat(21333),
    'tai tai … 64k': 'tai '.repeat(16000),
    'o + 64k khoảng trắng': 'o' + ' '.repeat(64000) + 'x',
    'a + 64k khoảng trắng + b': 'a' + ' '.repeat(64000) + 'b',
    'ở quận … 64k': 'ở quận '.repeat(9000),
    'o o o … 1 triệu': 'o '.repeat(500000)
  };
  for (const [name, s] of Object.entries(inputs)) {
    const { ms } = timed(() => extractProductInfo(s, parsePrice(s) || 0));
    assert.ok(ms < 100, `${name}: ${ms.toFixed(0)} ms`);
  }
  // Mức audit đề ra: 10.000 ký tự dưới 10 ms.
  const { ms } = timed(() => extractProductInfo('o '.repeat(5000), 0));
  assert.ok(ms < 10, `10k ký tự: ${ms.toFixed(1)} ms`);
});

test('INJ-01: bình luận thật vẫn nhận đúng địa chỉ, số lượng, tên món', () => {
  const r = extractProductInfo('chốt 2 cái áo 150k sdt 0988123456 đc 12 nguyễn trãi quận 1, hcm', 150000);
  assert.equal(r.phone, '0988123456');
  assert.equal(r.quantity, 2);
  assert.equal(r.address, '150k đc 12 nguyễn trãi quận 1');

  const r2 = extractProductInfo('lấy 1 váy hoa, địa chỉ: 25 lê lợi phường bến nghé quận 1', 0);
  assert.equal(r2.address, '25 lê lợi phường bến nghé quận 1');
  assert.equal(r2.productName, 'Váy hoa');

  // Bình luận dài bình thường (gần 500 ký tự) vẫn bắt được địa chỉ.
  const long = 'mình lấy bộ này nhé ' + 'đẹp quá '.repeat(50) + ', giao về 99 trần hưng đạo phường 5 quận 5 tp hcm';
  assert.ok(long.length < 500, String(long.length));
  assert.equal(extractProductInfo(long, 0).address, '99 trần hưng đạo phường 5 quận 5 tp hcm');

  assert.equal(extractProductInfo('', 0).productName, 'Sản phẩm livestream');
  assert.equal(extractProductInfo('   ', 0).address, '');
  assert.equal(extractProductInfo('x'.repeat(100000), 0).productName.length <= 500, true);
});

/* ---------------- INJ-02: bình luận không giới hạn ---------------- */

test('INJ-02: dữ liệu gửi lên bị cắt bình luận dài, bỏ bình luận quá lớn, tối đa 5.000 bình luận mỗi gói', () => {
  const huge = 'chốt '.repeat(100000);
  const many = Array.from({ length: 6000 }, (_, i) => ({ id: `c${i}`, text: 'chốt 50' }));
  const native = cleanNativeUpdate({
    comments: [
      { id: 'dai', text: huge, comment: huge },
      { id: 'ten-to', text: 'chốt 50', nickname: 'x'.repeat(100000) },
      ...many
    ]
  });
  assert.equal(native.comments.length, 5000);
  const dai = native.comments.find((c) => c.id === 'dai');
  assert.equal(dai.text.length, 500);
  assert.equal(dai.comment.length, 500);
  assert.ok(!native.comments.some((c) => c.id === 'ten-to'));

  const web = cleanState({ comments: [{ id: 'w', comment: huge }, { id: 'w2', comment: 'ok', extra: 'y'.repeat(50000) }] });
  assert.equal(web.comments.length, 1);
  assert.equal(web.comments[0].comment.length, 500);

  // Bình luận bình thường giữ nguyên, không bị tạo bản sao.
  const ok = { id: 'n', text: 'lấy 2 cái 150k', nickname: 'Chị Hoa' };
  assert.equal(cleanNativeUpdate({ comments: [ok] }).comments[0], ok);
});

/* ---------------- Chạy server thật ---------------- */

function startServer() {
  return spawn(process.execPath, ['--no-warnings', '--import', './test/fake-tiktok/register.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'admin-test-password', LAN_MODE: '' },
    stdio: 'ignore'
  });
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await sleep(50);
  }
  assert.fail('server không khởi động');
}

let ipCounter = 0;
async function register(username) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${++ipCounter}` },
    body: JSON.stringify({ username, password: 'mat-khau-tot', confirmPassword: 'mat-khau-tot' })
  });
  const body = await res.json();
  assert.ok(body.token, JSON.stringify(body));
  return body;
}

function openSocket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}&native=1`);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on('error', () => {});
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  const opened = new Promise((r) => ws.once('open', r));
  return { ws, messages, closed, opened };
}

async function until(fn, label, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await sleep(30);
  }
  assert.fail(`Quá giờ chờ: ${label}`);
}

function countComments(userId) {
  const db = new DatabaseSync(path.join(DATA_DIR, 'susu.db'), { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n, MAX(LENGTH(data)) AS biggest FROM live_comments WHERE user_id = ?').get(userId);
  } finally {
    db.close();
  }
}

before(async () => {
  server = startServer();
  await waitUp();
});

after(async () => {
  if (server) {
    const gone = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
    await sleep(100);
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('INJ-01: app gửi một bình luận 64k ký tự, server vẫn trả lời ngay', async () => {
  const { token, user } = await register('khach.redos');
  const sock = openSocket(token);
  await sock.opened;
  sock.ws.send(JSON.stringify({ type: 'native_update', id: 1, comments: [{ id: 'redos-1', text: 'o '.repeat(32000), ts: Date.now() }] }));
  await sleep(20); // để gói tới server trước
  const t0 = performance.now();
  assert.ok((await fetch(`${BASE}/healthz`)).ok);
  const ms = performance.now() - t0;
  await until(() => sock.messages.find((m) => m.type === 'native_ack' && m.id === 1), 'nhận gói');
  assert.ok(ms < 500, `/healthz chờ ${ms.toFixed(0)} ms`);
  const row = countComments(user.id);
  assert.equal(row.n, 1);
  assert.ok(row.biggest < 2000, `bình luận lưu ${row.biggest} ký tự`);
  sock.ws.close();
});

test('INJ-02: một tài khoản không đẩy được quá 5.000 bình luận mỗi gói, quá 20.000 bình luận mới mỗi ngày', async () => {
  const { token, user } = await register('khach.day.dia');
  const sock = openSocket(token);
  await sock.opened;
  const ts = Date.now();
  for (let p = 0; p < 5; p++) {
    const comments = Array.from({ length: 6000 }, (_, i) => ({ id: `p${p}-${i}`, text: 'chốt 50', ts: ts + i }));
    sock.ws.send(JSON.stringify({ type: 'native_update', id: 100 + p, comments }));
    await until(() => sock.messages.find((m) => m.id === 100 + p), `gói ${p}`);
  }
  const row = countComments(user.id);
  assert.ok(row.n <= 20000, `đã lưu ${row.n} bình luận`);
  assert.ok(row.n >= 5000, `đã lưu ${row.n} bình luận`);
  sock.ws.close();
});

/** Mở WebSocket bằng tay để gửi được phần đầu khung mà chưa gửi dữ liệu. */
function rawSocket(query = '') {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('error', reject);
    s.once('connect', () => {
      s.write(
        `GET /ws${query} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        s.off('data', onData);
        if (!buf.startsWith('HTTP/1.1 101')) reject(new Error(buf.split('\r\n')[0]));
        else resolve(s);
      }
    };
    s.on('data', onData);
  });
}

/** Phần đầu khung văn bản có mặt nạ, báo dài `len` byte (dạng 64 bit). */
function frameHeader(len) {
  const h = Buffer.alloc(14);
  h[0] = 0x81;
  h[1] = 0x80 | 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h; // 4 byte mặt nạ cuối để 0
}

test('INJ-03: người chưa đăng nhập báo gửi khung 32 MB thì bị ngắt ngay, server không đệm cả gói', async () => {
  const s = await rawSocket();
  const closed = new Promise((r) => s.once('close', () => r(true)));
  s.on('error', () => {});
  s.write(frameHeader(32 * 1024 * 1024 - 100));
  s.write(Buffer.alloc(1024, 0x20)); // chỉ gửi 1 KB, phần còn lại không bao giờ tới
  const result = await Promise.race([closed, sleep(2000).then(() => false)]);
  s.destroy();
  assert.equal(result, true, 'server vẫn giữ kết nối chờ đủ 32 MB');
  assert.ok((await fetch(`${BASE}/healthz`)).ok);
});

test('INJ-03: tài khoản đã đăng nhập vẫn gửi được gói vài MB qua WebSocket', async () => {
  const { token, user } = await register('khach.goi.to');
  const sock = openSocket(token);
  await sock.opened;
  const comments = Array.from({ length: 4000 }, (_, i) => ({ id: `big-${i}`, text: 'chốt 50 ' + 'x'.repeat(400), ts: Date.now() + i }));
  const payload = JSON.stringify({ type: 'native_update', id: 7, comments });
  assert.ok(payload.length > 1024 * 1024);
  sock.ws.send(payload);
  await until(() => sock.messages.find((m) => m.type === 'native_ack' && m.id === 7), 'nhận gói lớn');
  assert.equal(countComments(user.id).n, 4000);
  sock.ws.close();
});

test('INJ-03: kết nối mang token sai cũng chỉ được gửi gói nhỏ', async () => {
  const s = await rawSocket('?token=khong-hop-le&native=1');
  const closed = new Promise((r) => s.once('close', () => r(true)));
  s.on('error', () => {});
  s.write(frameHeader(1024 * 1024));
  const result = await Promise.race([closed, sleep(2000).then(() => false)]);
  s.destroy();
  assert.equal(result, true);
});

test('INJ-03: nối không token rồi đăng nhập bằng tin auth vẫn nhận tin như thiết bị khác; gói nhỏ vẫn qua', async () => {
  const { token } = await register('khach.auth.sau');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on('error', () => {});
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'ping' }));
  await until(() => messages.find((m) => m.type === 'pong'), 'pong khi chưa đăng nhập');
  ws.send(JSON.stringify({ type: 'auth', token }));
  await until(() => messages.find((m) => m.type === 'hello' && m.user), 'hello sau khi đăng nhập');
  const other = openSocket(token);
  await other.opened;
  await until(() => messages.find((m) => m.type === 'clients_count' && m.clientsCount === 2), 'nhận số thiết bị');
  other.ws.close();
  ws.close();
});
