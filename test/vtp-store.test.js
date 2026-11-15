import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVtpStore } from '../vtp.js';

const ENV = process.env.VTP_SECRET_KEY;
const dirs = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vtp-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  if (ENV === undefined) delete process.env.VTP_SECRET_KEY;
  else process.env.VTP_SECRET_KEY = ENV;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
const fileOf = (dir) => path.join(dir, 'vtp-connections.json');
const readJson = (dir) => JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));

test('token Viettel Post không nằm nguyên văn trong file, mở lại vẫn đọc được', () => {
  delete process.env.VTP_SECRET_KEY;
  const dir = tempDir();
  createVtpStore(dir).set('u1', { siteToken: 'SITE-SECRET-123', partnerToken: 'PARTNER-SECRET-456', hookId: 'h1' });

  const raw = fs.readFileSync(fileOf(dir), 'utf8');
  assert.doesNotMatch(raw, /SITE-SECRET-123|PARTNER-SECRET-456/);
  assert.match(readJson(dir).u1.siteToken, /^enc:v1:/);
  assert.equal(readJson(dir).u1.hookId, 'h1');

  const again = createVtpStore(dir);
  assert.equal(again.get('u1').siteToken, 'SITE-SECRET-123');
  assert.equal(again.get('u1').partnerToken, 'PARTNER-SECRET-456');
  assert.equal(again.byHook('h1').userId, 'u1');
});

test('file khoá tự tạo khi chưa đặt VTP_SECRET_KEY', { skip: process.platform === 'win32' }, () => {
  delete process.env.VTP_SECRET_KEY;
  const dir = tempDir();
  createVtpStore(dir).set('u1', { siteToken: 's' });
  const keyFile = path.join(dir, 'vtp-secret.key');
  assert.ok(fs.existsSync(keyFile));
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fileOf(dir)).mode & 0o777, 0o600);
});

test('dùng VTP_SECRET_KEY thì không tạo file khoá', () => {
  process.env.VTP_SECRET_KEY = 'khoa-bi-mat-tren-vps';
  const dir = tempDir();
  createVtpStore(dir).set('u1', { siteToken: 's' });
  assert.equal(fs.existsSync(path.join(dir, 'vtp-secret.key')), false);
  assert.equal(createVtpStore(dir).get('u1').siteToken, 's');
});

test('file cũ còn token nguyên văn được mã hoá lại ngay khi bật server', () => {
  delete process.env.VTP_SECRET_KEY;
  const dir = tempDir();
  fs.writeFileSync(fileOf(dir), JSON.stringify({ u1: { siteToken: 'OLD-PLAIN', partnerToken: 'OLD-PARTNER', sender: { name: 'Shop' } } }));

  const store = createVtpStore(dir);
  assert.equal(store.get('u1').siteToken, 'OLD-PLAIN');
  assert.equal(store.get('u1').sender.name, 'Shop');
  assert.doesNotMatch(fs.readFileSync(fileOf(dir), 'utf8'), /OLD-PLAIN|OLD-PARTNER/);
});

test('chuyển từ file khoá sang VTP_SECRET_KEY không mất kết nối', () => {
  delete process.env.VTP_SECRET_KEY;
  const dir = tempDir();
  createVtpStore(dir).set('u1', { siteToken: 'TOKEN' });
  const before = readJson(dir).u1.siteToken;

  process.env.VTP_SECRET_KEY = 'khoa-moi';
  assert.equal(createVtpStore(dir).get('u1').siteToken, 'TOKEN');
  assert.notEqual(readJson(dir).u1.siteToken, before, 'đã mã hoá lại bằng khoá mới');

  // Bỏ file khoá cũ đi, khoá mới vẫn đủ để đọc.
  fs.rmSync(path.join(dir, 'vtp-secret.key'));
  assert.equal(createVtpStore(dir).get('u1').siteToken, 'TOKEN');
});

test('sai khoá thì bỏ token, giữ phần còn lại để shop dán lại token', () => {
  process.env.VTP_SECRET_KEY = 'khoa-a';
  const dir = tempDir();
  createVtpStore(dir).set('u1', { siteToken: 'TOKEN', sender: { name: 'Shop' } });

  process.env.VTP_SECRET_KEY = 'khoa-b';
  const store = createVtpStore(dir);
  assert.equal(store.get('u1').siteToken, undefined);
  assert.equal(store.get('u1').sender.name, 'Shop');
});

test('file kết nối hỏng thì giữ lại bản hỏng, không ghi đè mất', () => {
  delete process.env.VTP_SECRET_KEY;
  const dir = tempDir();
  fs.writeFileSync(fileOf(dir), '{ hỏng');
  const store = createVtpStore(dir);
  assert.equal(store.get('u1'), null);
  store.set('u2', { siteToken: 'x' });
  const broken = fs.readdirSync(dir).filter((f) => f.startsWith('vtp-connections.json.broken-'));
  assert.equal(broken.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, broken[0]), 'utf8'), '{ hỏng');
});
