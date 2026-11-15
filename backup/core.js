/**
 * Sao lưu lên đám mây (Google Drive qua rclone). Xem hướng dẫn trong backup/README.md.
 *
 * Mỗi bản sao là một bản chụp nguyên vẹn của CSDL, được nén rồi mã hoá bằng mật khẩu sao lưu
 * trước khi rời máy: Google và người cầm được file đều không đọc được dữ liệu khách hàng.
 *
 * Định dạng file .enc: "CLBK1" (5 byte) + salt (16) + iv (12) + dữ liệu gzip đã mã hoá AES-256-GCM + tag (16).
 * Khoá = scrypt(mật khẩu, salt). Sai mật khẩu hoặc file bị sửa thì giải mã báo lỗi, không ra dữ liệu sai.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { verifySnapshot } from '../sync/core.js';

const MAGIC = Buffer.from('CLBK1');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const NAME_RE = /^chotlive-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db\.gz\.enc$/;
export const MIN_PASSPHRASE_LENGTH = 12;

const HOUR = 60 * 60 * 1000;

/** Đọc cấu hình từ biến môi trường (file .env, hoặc /etc/chotlive.env trên VPS). */
export function loadConfig(env = process.env, rootDir = process.cwd()) {
  const num = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
  return {
    remote: String(env.BACKUP_RCLONE_REMOTE || '').trim().replace(/\/+$/, ''),
    passphrase: String(env.BACKUP_PASSPHRASE || ''),
    rclonePath: String(env.BACKUP_RCLONE_PATH || '').trim() || 'rclone',
    rcloneConfig: String(env.BACKUP_RCLONE_CONFIG || '').trim(),
    keep: Math.round(num(env.BACKUP_KEEP, 30)),
    everyMs: num(env.BACKUP_EVERY_HOURS, 24) * HOUR,
    alertMs: num(env.BACKUP_ALERT_HOURS, 36) * HOUR,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(rootDir, 'data'),
    appPort: Number(env.PORT) || 3000
  };
}

/** Chưa bật thì trả về null ở `enabled`; bật mà điền sai thì có `problem` để báo người dùng. */
export function configState(cfg) {
  if (!cfg.remote && !cfg.passphrase) return { enabled: false, problem: null };
  if (!cfg.remote) return { enabled: false, problem: 'Thiếu BACKUP_RCLONE_REMOTE (ví dụ gdrive:ChotLive-SaoLuu).' };
  if (!/^[^:\s]+:/.test(cfg.remote)) {
    return { enabled: false, problem: 'BACKUP_RCLONE_REMOTE phải có dạng tên-kết-nối:thư-mục, ví dụ gdrive:ChotLive-SaoLuu.' };
  }
  if (cfg.passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return { enabled: false, problem: `BACKUP_PASSPHRASE phải dài ít nhất ${MIN_PASSPHRASE_LENGTH} ký tự.` };
  }
  return { enabled: true, problem: null };
}

/* ---------- Tình trạng lần sao lưu gần nhất ---------- */

const statusFile = (dataDir) => path.join(dataDir, 'cloud-backup-status.json');

export function readStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(statusFile(dataDir), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeStatus(dataDir, patch) {
  const next = { ...readStatus(dataDir), ...patch };
  const file = statusFile(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return next;
}

/* ---------- Mã hoá ---------- */

const deriveKey = (passphrase, salt) =>
  crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const out = fs.createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), zlib.createGzip(), cipher, out, { end: false });
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(cipher.getAuthTag(), resolve);
  });
}

export const WRONG_KEY_MESSAGE = 'Không giải mã được: sai mật khẩu sao lưu (BACKUP_PASSPHRASE) hoặc file bị hỏng.';

/** Giải mã ra `dest`. Chỉ khi kiểm tra xong toàn bộ file mới để lại kết quả. */
export async function decryptFile(src, dest, passphrase) {
  const size = fs.statSync(src).size;
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error('File sao lưu quá ngắn, không phải bản sao của ChốtLive.');
  const fd = fs.openSync(src, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    fs.readSync(fd, header, 0, HEADER_BYTES, 0);
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('File này không phải bản sao của ChốtLive.');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  const tmp = `${dest}.part`;
  try {
    // Phần dữ liệu nằm giữa header và tag. File rỗng thì không có byte nào để đọc.
    const body = size - TAG_BYTES - 1 >= HEADER_BYTES ? fs.createReadStream(src, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }) : [];
    await pipeline(body, decipher, zlib.createGunzip(), fs.createWriteStream(tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(WRONG_KEY_MESSAGE, { cause: err });
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/* ---------- CSDL ---------- */

/** Bản chụp nguyên vẹn dù server vẫn đang ghi. */
export function snapshotDb(dbFile, dest) {
  fs.rmSync(dest, { force: true });
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 15000');
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
}

/** Số tài khoản, đơn, khách, bình luận trong một file CSDL, để người dùng đối chiếu bằng mắt. */
export function countsOf(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const count = (table) => {
      try {
        return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      } catch {
        return 0;
      }
    };
    return { accounts: count('users'), orders: count('orders'), customers: count('customers'), comments: count('live_comments') };
  } finally {
    db.close();
  }
}

export const countsText = (c) =>
  `${c.accounts} tài khoản, ${c.orders} đơn hàng, ${c.customers} khách hàng, ${c.comments} bình luận`;

/* ---------- rclone ---------- */

function rcloneCommand(cfg) {
  // File .mjs chỉ dùng cho test tự động (rclone giả viết bằng Node, chạy được trên cả Windows).
  const base = /\.mjs$/.test(cfg.rclonePath) ? [process.execPath, cfg.rclonePath] : [cfg.rclonePath];
  return cfg.rcloneConfig ? [...base, '--config', cfg.rcloneConfig] : base;
}

export function rclone(cfg, args, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const [cmd, ...prefix] = rcloneCommand(cfg);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error('Không tìm thấy rclone. Hãy cài rclone, hoặc đặt BACKUP_RCLONE_PATH trỏ tới file rclone.')
          : err
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Dòng lỗi cuối của rclone, bỏ phần ngày giờ ở đầu. */
function rcloneError(r) {
  const lines = r.stderr.trim().split('\n').filter(Boolean);
  const last = (lines[lines.length - 1] || `rclone thoát với mã ${r.code}`).replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+/, '');
  if (/didn't find section in config file/i.test(last)) {
    return 'rclone chưa có kết nối tên này. Kiểm tra BACKUP_RCLONE_REMOTE và chạy lại bước đăng nhập Google Drive.';
  }
  return last.slice(0, 300);
}

const RCLONE_FLAGS = ['--retries', '3', '--contimeout', '30s', '--timeout', '5m'];

const timeOfName = (name) => {
  const m = NAME_RE.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
};

export function backupName(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `chotlive-${stamp}.db.gz.enc`;
}

/** Các bản sao đang có trên đám mây, mới nhất trước. Thư mục chưa có thì coi là chưa có bản nào. */
export async function listRemote(cfg) {
  const r = await rclone(cfg, ['lsjson', cfg.remote, '--files-only', ...RCLONE_FLAGS]);
  if (r.code !== 0) {
    if (/directory not found/i.test(r.stderr)) return [];
    throw new Error(`Không xem được thư mục sao lưu: ${rcloneError(r)}`);
  }
  let rows;
  try {
    rows = JSON.parse(r.stdout || '[]');
  } catch {
    throw new Error('rclone trả về danh sách không đọc được.');
  }
  return rows
    .filter((f) => NAME_RE.test(f.Name))
    .map((f) => ({ name: f.Name, size: Number(f.Size) || 0, at: timeOfName(f.Name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function upload(cfg, file, name) {
  const r = await rclone(cfg, ['copyto', file, `${cfg.remote}/${name}`, ...RCLONE_FLAGS]);
  if (r.code !== 0) throw new Error(`Không đẩy được bản sao lên đám mây: ${rcloneError(r)}`);
}

async function download(cfg, name, dest) {
  fs.rmSync(dest, { force: true });
  const r = await rclone(cfg, ['copyto', `${cfg.remote}/${name}`, dest, ...RCLONE_FLAGS]);
  if (r.code !== 0 || !fs.existsSync(dest)) throw new Error(`Không tải được bản sao ${name}: ${rcloneError(r)}`);
}

/* ---------- Sao lưu và lấy lại ---------- */

const tmpDirOf = (cfg) => path.join(cfg.dataDir, 'cloud-backup-tmp');

function freshTmpDir(cfg) {
  const dir = tmpDirOf(cfg);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Một lượt sao lưu: chụp CSDL, kiểm tra, mã hoá, giải mã thử, đẩy lên, xác nhận đã có trên đám mây, dọn bản cũ.
 * Thành công hay thất bại đều ghi vào file tình trạng để server biết mà báo.
 */
export async function runBackup(cfg, { now = Date.now() } = {}) {
  const state = configState(cfg);
  if (!state.enabled) throw new Error(state.problem || 'Chưa bật sao lưu đám mây (thiếu BACKUP_RCLONE_REMOTE và BACKUP_PASSPHRASE).');
  writeStatus(cfg.dataDir, { lastAttemptAt: now });
  const dir = freshTmpDir(cfg);
  try {
    const dbFile = path.join(cfg.dataDir, 'susu.db');
    if (!fs.existsSync(dbFile)) throw new Error(`Không thấy CSDL: ${dbFile}`);
    const snap = path.join(dir, 'snapshot.db');
    snapshotDb(dbFile, snap);
    verifySnapshot(snap);
    const counts = countsOf(snap);

    const name = backupName(now);
    const enc = path.join(dir, name);
    await encryptFile(snap, enc, cfg.passphrase);
    // Giải mã thử ngay: bản đẩy lên phải mở lại được bằng đúng mật khẩu đang dùng.
    const back = path.join(dir, 'check.db');
    await decryptFile(enc, back, cfg.passphrase);
    if ((await sha256Of(back)) !== (await sha256Of(snap))) throw new Error('Bản mã hoá giải ra không khớp bản gốc.');

    const size = fs.statSync(enc).size;
    await upload(cfg, enc, name);
    const remote = await listRemote(cfg);
    const mine = remote.find((f) => f.name === name);
    if (!mine || mine.size !== size) throw new Error('Đẩy lên xong nhưng không thấy bản sao đúng kích thước trên đám mây.');

    // Dọn bản cũ sau cùng, và chỉ khi bản mới đã chắc chắn nằm trên đám mây.
    let removed = 0;
    for (const old of remote.slice(Math.max(cfg.keep, 1))) {
      const r = await rclone(cfg, ['deletefile', `${cfg.remote}/${old.name}`, ...RCLONE_FLAGS]);
      if (r.code === 0) removed++;
    }

    writeStatus(cfg.dataDir, { lastSuccessAt: now, lastFile: name, lastSize: size, lastCounts: counts, lastError: '', kept: remote.length - removed });
    return { name, size, counts, kept: remote.length - removed, removed };
  } catch (err) {
    writeStatus(cfg.dataDir, { lastError: String(err.message || err).slice(0, 500), lastErrorAt: now });
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Tải một bản sao về (mặc định bản mới nhất), giải mã và kiểm tra CSDL.
 * Trả về đường dẫn file CSDL đã giải mã trong thư mục tạm; người gọi xoá bằng `cleanup()`.
 */
export async function fetchBackup(cfg, wanted = '') {
  const state = configState(cfg);
  if (!state.enabled) throw new Error(state.problem || 'Chưa bật sao lưu đám mây (thiếu BACKUP_RCLONE_REMOTE và BACKUP_PASSPHRASE).');
  const remote = await listRemote(cfg);
  if (!remote.length) throw new Error('Trên đám mây chưa có bản sao nào.');
  const entry = wanted ? remote.find((f) => f.name === wanted) : remote[0];
  if (!entry) throw new Error(`Không thấy bản sao tên ${wanted}. Xem danh sách bằng lệnh list.`);
  const dir = path.join(cfg.dataDir, 'cloud-backup-restore');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const enc = path.join(dir, entry.name);
    await download(cfg, entry.name, enc);
    const dbFile = path.join(dir, 'restored.db');
    await decryptFile(enc, dbFile, cfg.passphrase);
    fs.rmSync(enc, { force: true });
    const info = verifySnapshot(dbFile);
    return { entry, dbFile, rows: info.rows, counts: countsOf(dbFile), cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
