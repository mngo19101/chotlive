import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as sqlite from '../db.js';
import {
  configState,
  countsOf,
  decryptFile,
  encryptFile,
  fetchBackup,
  listRemote,
  loadConfig,
  readStatus,
  runBackup,
  WRONG_KEY_MESSAGE
} from '../backup/core.js';
import { backupDue, backupLate, createBackupWatch } from '../server/backup-watch.js';
import { createTelegramBridge } from '../telegram.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_RCLONE = path.join(here, 'fake-rclone', 'rclone.mjs');
const PASS = 'mật khẩu sao lưu để test';
const HOUR = 60 * 60 * 1000;
const DAY0 = Date.UTC(2026, 10, 15, 3, 0, 0);

const dirs = [];
const savedCloud = process.env.FAKE_RCLONE_DIR;
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  if (savedCloud === undefined) delete process.env.FAKE_RCLONE_DIR;
  else process.env.FAKE_RCLONE_DIR = savedCloud;
});

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Một "máy" có CSDL với `orders` đơn, và một "đám mây" là thư mục riêng. */
function setup({ orders = 3, keep = 30 } = {}) {
  const dataDir = tempDir('cb-data-');
  const cloud = tempDir('cb-cloud-');
  process.env.FAKE_RCLONE_DIR = cloud;
  const db = sqlite.openDb(path.join(dataDir, 'susu.db'));
  db.prepare('INSERT INTO users (id, data) VALUES (?, ?)').run('u1', JSON.stringify({ id: 'u1', username: 'shop' }));
  for (let i = 0; i < orders; i++) {
    db.prepare('INSERT INTO orders (user_id, id, pos, data) VALUES (?, ?, ?, ?)').run('u1', `o${i}`, i, JSON.stringify({ id: `o${i}`, note: 'Nguyễn Thị Hoa 0905123456' }));
  }
  db.close();
  const cfg = loadConfig(
    { BACKUP_RCLONE_REMOTE: 'fake:SaoLuu', BACKUP_PASSPHRASE: PASS, BACKUP_RCLONE_PATH: FAKE_RCLONE, BACKUP_KEEP: String(keep), DATA_DIR: dataDir },
    dataDir
  );
  return { dataDir, cloud, cfg, cloudFiles: () => (fs.existsSync(path.join(cloud, 'SaoLuu')) ? fs.readdirSync(path.join(cloud, 'SaoLuu')).sort() : []) };
}

test('cấu hình: chưa điền gì thì tắt, điền thiếu hoặc mật khẩu ngắn thì báo rõ', () => {
  assert.deepEqual(configState(loadConfig({})), { enabled: false, problem: null });
  assert.match(configState(loadConfig({ BACKUP_PASSPHRASE: PASS })).problem, /BACKUP_RCLONE_REMOTE/);
  assert.match(configState(loadConfig({ BACKUP_RCLONE_REMOTE: 'ChotLive', BACKUP_PASSPHRASE: PASS })).problem, /tên-kết-nối:thư-mục/);
  assert.match(configState(loadConfig({ BACKUP_RCLONE_REMOTE: 'gdrive:A', BACKUP_PASSPHRASE: 'ngắn' })).problem, /ít nhất 12/);
  assert.equal(configState(loadConfig({ BACKUP_RCLONE_REMOTE: 'gdrive:A', BACKUP_PASSPHRASE: PASS })).enabled, true);
});

test('mã hoá rồi giải mã ra đúng file gốc; sai mật khẩu hoặc file bị sửa thì báo lỗi và không để lại file', async () => {
  const dir = tempDir('cb-enc-');
  const src = path.join(dir, 'a.bin');
  const data = Buffer.concat([Buffer.from('Nguyễn Thị Hoa 0905123456\n'.repeat(5000)), Buffer.alloc(100000, 7)]);
  fs.writeFileSync(src, data);
  const enc = path.join(dir, 'a.enc');
  await encryptFile(src, enc, PASS);
  assert.ok(!fs.readFileSync(enc).includes('Nguyễn'), 'file mã hoá không lộ nội dung');

  const out = path.join(dir, 'a.out');
  await decryptFile(enc, out, PASS);
  assert.ok(fs.readFileSync(out).equals(data));

  const bad = path.join(dir, 'bad.out');
  await assert.rejects(decryptFile(enc, bad, 'mật khẩu khác hẳn'), { message: WRONG_KEY_MESSAGE });
  const raw = fs.readFileSync(enc);
  raw[raw.length - 40] ^= 1;
  fs.writeFileSync(enc, raw);
  await assert.rejects(decryptFile(enc, bad, PASS), { message: WRONG_KEY_MESSAGE });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('bad')), []);

  fs.writeFileSync(enc, 'đây không phải bản sao, chỉ là một file chữ dài hơn năm mươi byte cho đủ');
  await assert.rejects(decryptFile(enc, bad, PASS), /không phải bản sao/);
});

test('sao lưu: bản trên đám mây đã mã hoá, tải về giải mã ra đúng dữ liệu', async () => {
  const { cfg, dataDir, cloud, cloudFiles } = setup({ orders: 5 });
  const r = await runBackup(cfg, { now: DAY0 });
  assert.equal(r.name, 'chotlive-20261115-030000.db.gz.enc');
  assert.deepEqual(cloudFiles(), [r.name]);
  const uploaded = fs.readFileSync(path.join(cloud, 'SaoLuu', r.name));
  assert.ok(!uploaded.includes('SQLite format') && !uploaded.includes('0905123456'), 'không lộ dữ liệu khách');

  const st = readStatus(dataDir);
  assert.equal(st.lastSuccessAt, DAY0);
  assert.equal(st.lastFile, r.name);
  assert.equal(st.lastError, '');
  assert.equal(st.lastCounts.orders, 5);
  assert.equal(fs.existsSync(path.join(dataDir, 'cloud-backup-tmp')), false, 'không để lại bản chưa mã hoá');

  const got = await fetchBackup(cfg);
  assert.equal(got.entry.name, r.name);
  assert.deepEqual(got.counts, countsOf(path.join(dataDir, 'susu.db')));
  const db = new DatabaseSync(got.dbFile, { readOnly: true });
  assert.match(db.prepare("SELECT data FROM orders WHERE id = 'o4'").get().data, /Nguyễn Thị Hoa/);
  db.close();
  got.cleanup();
  assert.equal(fs.existsSync(got.dbFile), false);
});

test('sao lưu: chỉ giữ số bản mới nhất đã đặt, lấy được đúng bản theo tên', async () => {
  const { cfg, cloudFiles } = setup({ keep: 3 });
  for (let day = 0; day < 5; day++) await runBackup(cfg, { now: DAY0 + day * 24 * HOUR });
  assert.deepEqual(cloudFiles(), ['chotlive-20261117-030000.db.gz.enc', 'chotlive-20261118-030000.db.gz.enc', 'chotlive-20261119-030000.db.gz.enc']);
  assert.equal((await listRemote(cfg))[0].name, 'chotlive-20261119-030000.db.gz.enc');
  const got = await fetchBackup(cfg, 'chotlive-20261117-030000.db.gz.enc');
  assert.equal(got.entry.at, DAY0 + 2 * 24 * HOUR);
  got.cleanup();
  await assert.rejects(fetchBackup(cfg, 'chotlive-20200101-000000.db.gz.enc'), /Không thấy bản sao/);
});

test('sao lưu lỗi (mất mạng): ghi lại lỗi, giữ nguyên mốc thành công cũ, không dọn bản nào', async () => {
  const { cfg, dataDir, cloud, cloudFiles } = setup();
  await runBackup(cfg, { now: DAY0 });
  fs.writeFileSync(path.join(cloud, 'FAIL'), '');
  await assert.rejects(runBackup(cfg, { now: DAY0 + 24 * HOUR }), /Không đẩy được bản sao/);
  const st = readStatus(dataDir);
  assert.equal(st.lastSuccessAt, DAY0);
  assert.equal(st.lastAttemptAt, DAY0 + 24 * HOUR);
  assert.match(st.lastError, /mất mạng/);
  fs.rmSync(path.join(cloud, 'FAIL'));
  assert.equal(cloudFiles().length, 1);
});

test('chưa có thư mục trên đám mây thì coi là chưa có bản nào; sai tên kết nối thì báo rõ', async () => {
  const { cfg } = setup();
  assert.deepEqual(await listRemote(cfg), []);
  await assert.rejects(fetchBackup(cfg), /chưa có bản sao nào/);
  await assert.rejects(listRemote({ ...cfg, remote: 'khongco:SaoLuu' }), /chưa có kết nối tên này/);
  await assert.rejects(listRemote({ ...cfg, rclonePath: path.join(os.tmpdir(), 'khong-co-rclone-o-day') }), /Không tìm thấy rclone/);
});

test('lệnh restore: máy trống lấy lại đủ dữ liệu; thiếu --yes thì không làm gì; máy còn dữ liệu thì giữ bản cũ', async () => {
  const { cfg, dataDir } = setup({ orders: 7 });
  await runBackup(cfg, { now: DAY0 });
  const newMachine = tempDir('cb-new-');
  const cli = (args, dir) =>
    spawnSync(process.execPath, ['--no-warnings', path.join(here, '..', 'backup', 'cloud-backup.mjs'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: '39', // không có server nào nghe ở cổng này
        BACKUP_RCLONE_REMOTE: cfg.remote,
        BACKUP_PASSPHRASE: PASS,
        BACKUP_RCLONE_PATH: FAKE_RCLONE
      }
    });

  const refused = cli(['restore'], newMachine);
  assert.equal(refused.status, 1);
  assert.equal(fs.existsSync(path.join(newMachine, 'susu.db')), false);

  const drill = cli(['test-restore'], newMachine);
  assert.equal(drill.status, 0, drill.stderr);
  assert.match(drill.stdout, /khôi phục được/);
  assert.equal(fs.existsSync(path.join(newMachine, 'susu.db')), false, 'thử khôi phục không tạo dữ liệu');

  const done = cli(['restore', '--yes'], newMachine);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(countsOf(path.join(newMachine, 'susu.db')), countsOf(path.join(dataDir, 'susu.db')));

  // Máy đang có dữ liệu khác: khôi phục xong vẫn còn bản cũ để lấy lại.
  const db = new DatabaseSync(path.join(dataDir, 'susu.db'));
  db.prepare("DELETE FROM orders WHERE id != 'o0'").run();
  db.close();
  const again = cli(['restore', '--yes'], dataDir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(countsOf(path.join(dataDir, 'susu.db')).orders, 7);
  const kept = fs.readdirSync(path.join(dataDir, 'sync', 'before-replace'));
  assert.equal(kept.length, 1);
  assert.equal(countsOf(path.join(dataDir, 'sync', 'before-replace', kept[0])).orders, 1);
});

test('đến giờ sao lưu và trễ: tính theo lần thành công gần nhất', () => {
  const cfg = { everyMs: 24 * HOUR, alertMs: 36 * HOUR };
  const t = DAY0;
  assert.equal(backupDue({}, cfg, t), true, 'chưa có bản nào');
  assert.equal(backupDue({ lastSuccessAt: t - 23 * HOUR }, cfg, t), false);
  assert.equal(backupDue({ lastSuccessAt: t - 24 * HOUR }, cfg, t), true);
  assert.equal(backupDue({ lastSuccessAt: t - 30 * HOUR, lastAttemptAt: t - 0.5 * HOUR }, cfg, t), false, 'vừa thử hỏng thì chờ 1 giờ');
  assert.equal(backupDue({ lastSuccessAt: t - 30 * HOUR, lastAttemptAt: t - 1.5 * HOUR }, cfg, t), true);

  assert.equal(backupLate({}, cfg, t), false, 'chưa thử lần nào thì chưa gọi là trễ');
  assert.equal(backupLate({ lastError: 'x', lastAttemptAt: t }, cfg, t), true, 'chưa có bản nào mà lần đầu hỏng');
  assert.equal(backupLate({ lastSuccessAt: t - 35 * HOUR, lastError: 'x' }, cfg, t), false);
  assert.equal(backupLate({ lastSuccessAt: t - 37 * HOUR }, cfg, t), true);
});

test('tự sao lưu và cảnh báo: báo khi bật xong, báo một lần mỗi ngày khi trễ, báo khi chạy lại', async () => {
  const { cfg, cloud } = setup();
  let clock = DAY0;
  const sent = [];
  let telegramUp = true;
  const watch = createBackupWatch({
    cfg,
    now: () => clock,
    runBackup: () => runBackup(cfg, { now: clock }),
    notify: async (text) => (telegramUp ? (sent.push(text), true) : false),
    log: { warn() {}, log() {} }
  });

  await watch.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /đã bật sao lưu/);

  clock += 12 * HOUR;
  await watch.tick();
  assert.equal(sent.length, 1, 'chưa đến giờ, không có gì để báo');

  // Mất mạng từ đây: đến giờ thì thử, hỏng; quá 36 giờ không có bản mới thì báo.
  fs.writeFileSync(path.join(cloud, 'FAIL'), '');
  clock = DAY0 + 25 * HOUR;
  await watch.tick();
  assert.equal(sent.length, 1, 'mới trễ 25 giờ, chưa báo');
  clock = DAY0 + 37 * HOUR;
  telegramUp = false;
  await watch.tick();
  telegramUp = true;
  clock += 10 * 60 * 1000;
  await watch.tick();
  assert.equal(sent.length, 2, 'Telegram gửi hỏng thì lần kiểm tra sau gửi lại');
  assert.match(sent[1], /đang bị trễ/);
  assert.match(sent[1], /mất mạng/);
  assert.match(sent[1], /37 giờ trước/);

  clock += 5 * HOUR;
  await watch.tick();
  assert.equal(sent.length, 2, 'không nhắc lại trong vòng 24 giờ');
  clock = DAY0 + 62 * HOUR;
  await watch.tick();
  assert.equal(sent.length, 3, 'vẫn trễ thì hôm sau nhắc lại');

  fs.rmSync(path.join(cloud, 'FAIL'));
  clock += 2 * HOUR;
  await watch.tick();
  assert.equal(sent.length, 4);
  assert.match(sent[3], /chạy lại bình thường/);
  clock += 10 * 60 * 1000;
  await watch.tick();
  assert.equal(sent.length, 4);
});

test('chưa có bản nào mà lần sao lưu đầu hỏng thì báo ngay', async () => {
  const { cfg, cloud } = setup();
  fs.writeFileSync(path.join(cloud, 'FAIL'), '');
  const sent = [];
  const watch = createBackupWatch({
    cfg,
    now: () => DAY0,
    runBackup: () => runBackup(cfg, { now: DAY0 }),
    notify: async (text) => (sent.push(text), true),
    log: { warn() {}, log() {} }
  });
  await watch.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Chưa có bản sao nào/);
});

test('bot Telegram gửi cảnh báo hệ thống cho Admin; chưa có mã chat Admin thì trả về false', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ method: url.split('/').pop(), ...JSON.parse(init.body) });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }), status: 200 };
  };
  const bridge = createTelegramBridge({ token: 'T', adminChatId: '111', db: new DatabaseSync(':memory:'), fetchImpl, log: {}, onReply: async () => ({ ok: true }) });
  assert.equal(await bridge.notifyAdmin('sao lưu trễ'), true);
  assert.deepEqual(sent, [{ method: 'sendMessage', chat_id: '111', text: 'sao lưu trễ' }]);

  const noAdmin = createTelegramBridge({ token: 'T', adminChatId: '', db: new DatabaseSync(':memory:'), fetchImpl, log: {}, onReply: async () => ({ ok: true }) });
  assert.equal(await noAdmin.notifyAdmin('x'), false);
  const down = createTelegramBridge({ token: 'T', adminChatId: '111', db: new DatabaseSync(':memory:'), log: {}, onReply: async () => ({ ok: true }), fetchImpl: async () => { throw new Error('mất mạng'); } });
  assert.equal(await down.notifyAdmin('x'), false);
});
