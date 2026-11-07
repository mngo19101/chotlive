/**
 * Đồng bộ dữ liệu ChốtLive giữa hai máy (laptop <-> mini PC) để máy này hỏng thì còn máy kia.
 *
 * Nguyên tắc: không bao giờ tự ghi đè lên dữ liệu mà máy kia chưa có.
 * - Chỉ một bên đổi  -> bên kia nhận bản mới (trước khi thay luôn lưu lại bản cũ).
 * - Cả hai bên cùng đổi -> mỗi máy giữ bản của mình và cất thêm bản của máy kia, chờ người dùng chọn.
 * - Một bên bỗng mất nhiều dữ liệu -> coi là sự cố, không lan sang máy còn lại.
 *
 * SQLite đang chạy ở chế độ WAL nên không chép thẳng file được: luôn tạo bản chụp bằng VACUUM INTO.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROW_TABLES = ['orders', 'customers', 'comments', 'live_sessions', 'accounts', 'live_comments'];
const TIME_WINDOW_MS = 5 * 60 * 1000;
const STATUS_TIMEOUT_MS = 8000;
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
const OWN_SNAPSHOT_EVERY_MS = 30 * 60 * 1000;
const KEEP_RECENT = 6;
const KEEP_DAYS = 14;
const STALE_LOCK_MS = 40 * 60 * 1000;
const SHRINK_MIN_ROWS = 20;

export const DEFAULT_CONFIG = {
  key: '',
  peerAddress: '',
  peerPort: 3100,
  serve: false,
  port: 3100,
  intervalMinutes: 5,
  appPort: Number(process.env.PORT) || 3000
};

export function createContext({ dataDir, config, name }) {
  const workDir = path.join(dataDir, 'sync');
  for (const d of ['received', 'own', 'before-replace']) fs.mkdirSync(path.join(workDir, d), { recursive: true });
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return {
    dataDir,
    workDir,
    dbFile: path.join(dataDir, 'susu.db'),
    stateFile: path.join(workDir, 'state.json'),
    lockFile: path.join(workDir, 'cycle.lock'),
    logFile: path.join(workDir, 'sync.log'),
    config: cfg,
    name: name || cfg.name || os.hostname(),
    authKey: createHash('sha256').update(`auth:${cfg.key}`).digest(),
    encKey: createHash('sha256').update(`enc:${cfg.key}`).digest()
  };
}

/* ---------- Trạng thái & nhật ký ---------- */

export function readState(ctx) {
  try {
    return JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
  } catch {
    return {};
  }
}

export function updateState(ctx, patch) {
  const next = { ...readState(ctx), ...patch };
  const tmp = `${ctx.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, ctx.stateFile);
  return next;
}

export function log(ctx, message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    if (fs.existsSync(ctx.logFile) && fs.statSync(ctx.logFile).size > 1024 * 1024) {
      fs.renameSync(ctx.logFile, `${ctx.logFile}.old`);
    }
    fs.appendFileSync(ctx.logFile, line);
  } catch {}
}

/* ---------- Đọc, chụp và thay cơ sở dữ liệu ---------- */

/**
 * Dấu vân tay theo nội dung, không theo file: đăng nhập hay khởi động lại server
 * không làm đổi đơn hàng nên không được tính là "có thay đổi".
 */
export function inspectDb(file) {
  if (!fs.existsSync(file)) return { hash: null, rows: 0 };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has('users')) {
      if (tables.size === 0) return { hash: null, rows: 0 };
      throw new Error('file không phải dữ liệu ChốtLive');
    }
    const hash = createHash('sha256');
    let rows = 0;
    for (const t of [...ROW_TABLES, 'settings']) {
      if (!tables.has(t)) continue;
      for (const r of db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).iterate()) {
        hash.update(`${t}\n${JSON.stringify(r)}\n`);
        if (t !== 'settings') rows++;
      }
    }
    for (const r of db.prepare('SELECT id, data FROM users ORDER BY id').iterate()) {
      const user = JSON.parse(r.data);
      delete user.lastLoginAt;
      hash.update(`users\n${JSON.stringify(user)}\n`);
    }
    return { hash: hash.digest('hex'), rows };
  } finally {
    db.close();
  }
}

function snapshotDb(dbFile, dest) {
  fs.rmSync(dest, { force: true });
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

/** Bản nhận về phải đọc được và không hỏng thì mới được lưu. */
export function verifySnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('bản sao bị hỏng');
  } finally {
    db.close();
  }
  const info = inspectDb(file);
  if (!info.hash) throw new Error('bản sao trống');
  return info;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Giữ vài bản mới nhất và mỗi ngày một bản trong KEEP_DAYS ngày. */
function prune(dir, protectedFile) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse();
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
  const days = new Set();
  files.forEach((f, i) => {
    const day = f.slice(0, 8);
    const firstOfDay = !days.has(day);
    days.add(day);
    if (i < KEEP_RECENT || (firstOfDay && day >= cutoff) || f === protectedFile) return;
    fs.rmSync(path.join(dir, f), { force: true });
  });
}

function takeOwnSnapshot(ctx, local) {
  const st = readState(ctx);
  if (!local.hash || local.hash === st.ownHash) return;
  if (Date.now() - (st.ownAt || 0) < OWN_SNAPSHOT_EVERY_MS) return;
  const dir = path.join(ctx.workDir, 'own');
  snapshotDb(ctx.dbFile, path.join(dir, `${stamp()}_${local.hash.slice(0, 8)}.db`));
  prune(dir);
  updateState(ctx, { ownHash: local.hash, ownAt: Date.now() });
}

/** Nếu lần trước tắt máy đúng lúc đang thay file thì trả lại file cũ. */
function recoverInterruptedReplace(ctx) {
  const old = `${ctx.dbFile}.replacing`;
  if (fs.existsSync(old) && !fs.existsSync(ctx.dbFile)) fs.renameSync(old, ctx.dbFile);
}

/** Thay dữ liệu đang dùng bằng một bản sao. Server đang mở file thì Windows báo lỗi và không có gì bị đổi. */
export function replaceDb(ctx, file) {
  const { dbFile } = ctx;
  const incoming = `${dbFile}.incoming`;
  const old = `${dbFile}.replacing`;
  fs.copyFileSync(file, incoming);
  try {
    if (fs.existsSync(dbFile)) {
      const dir = path.join(ctx.workDir, 'before-replace');
      const safety = path.join(dir, `${stamp()}_truoc-khi-thay.db`);
      try {
        snapshotDb(dbFile, safety);
      } catch {
        fs.copyFileSync(dbFile, safety); // file hỏng thì vẫn giữ nguyên trạng để còn cứu được
      }
      prune(dir);
      fs.renameSync(dbFile, old);
    }
  } catch (err) {
    fs.rmSync(incoming, { force: true });
    throw err;
  }
  try {
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });
  } catch (err) {
    if (fs.existsSync(old)) fs.renameSync(old, dbFile);
    fs.rmSync(incoming, { force: true });
    throw err;
  }
  fs.renameSync(incoming, dbFile);
  fs.rmSync(old, { force: true });
}

export async function appRunning(ctx) {
  try {
    await fetch(`http://127.0.0.1:${ctx.config.appPort}/healthz`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch (err) {
    return err?.name === 'TimeoutError';
  }
}

/** Áp dụng bản đang chờ. Dữ liệu máy này đã đổi từ lúc tải về thì bỏ, để lượt sau tính lại. */
async function applyPending(ctx) {
  const { pending } = readState(ctx);
  if (!pending) return null;
  const file = path.join(ctx.workDir, 'received', pending.file);
  const own = inspectDb(ctx.dbFile);
  if (own.hash === pending.hash) {
    updateState(ctx, { pending: null, base: pending.hash, force: null });
    return 'adopted';
  }
  if (!fs.existsSync(file) || (own.rows > 0 && own.hash !== pending.base)) {
    updateState(ctx, { pending: null });
    return 'stale';
  }
  if (await appRunning(ctx)) return 'waiting';
  try {
    replaceDb(ctx, file);
  } catch (err) {
    log(ctx, `Chưa thay được dữ liệu: ${err.message}`);
    return 'waiting';
  }
  updateState(ctx, { pending: null, base: pending.hash, force: null });
  log(ctx, `Đã nhận dữ liệu mới từ ${pending.from} (${pending.hash.slice(0, 8)})`);
  return 'adopted';
}

async function withLock(ctx, fn) {
  try {
    if (fs.existsSync(ctx.lockFile) && Date.now() - fs.statSync(ctx.lockFile).mtimeMs > STALE_LOCK_MS) {
      fs.rmSync(ctx.lockFile, { force: true });
    }
    fs.closeSync(fs.openSync(ctx.lockFile, 'wx'));
  } catch {
    return null;
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(ctx.lockFile, { force: true });
  }
}

/* ---------- Mã hoá đường truyền: AES-256-GCM, khoá không bao giờ đi qua mạng ---------- */

async function* encryptStream(source, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  yield iv;
  for await (const chunk of source) yield cipher.update(chunk);
  yield cipher.final();
  yield cipher.getAuthTag();
}

/** Giải mã vào file. Sai khoá hoặc dữ liệu bị cắt/sửa thì báo lỗi. */
async function decryptToFile(source, dest, key) {
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher = null;
  await pipeline(
    source,
    async function* (input) {
      for await (const raw of input) {
        let chunk = raw;
        if (!decipher) {
          head = Buffer.concat([head, chunk]);
          if (head.length < 12) continue;
          decipher = createDecipheriv('aes-256-gcm', key, head.subarray(0, 12));
          chunk = head.subarray(12);
        }
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > 16) {
          yield decipher.update(tail.subarray(0, tail.length - 16));
          tail = tail.subarray(tail.length - 16);
        }
      }
      if (!decipher || tail.length !== 16) throw new Error('dữ liệu truyền bị thiếu');
      decipher.setAuthTag(tail);
      yield decipher.final();
    },
    fs.createWriteStream(dest)
  );
}

function sign(ctx, method, url, time) {
  return createHmac('sha256', ctx.authKey).update(`${method}\n${url}\n${time}`).digest();
}

export function authHeaders(ctx, method, url) {
  const time = String(Date.now());
  return { 'x-sync-time': time, 'x-sync-sign': sign(ctx, method, url, time).toString('hex') };
}

function requestAuthorized(ctx, req) {
  const time = String(req.headers['x-sync-time'] || '');
  if (Math.abs(Date.now() - Number(time)) > TIME_WINDOW_MS) return false;
  const given = Buffer.from(String(req.headers['x-sync-sign'] || ''), 'hex');
  const expected = sign(ctx, req.method, req.url, time);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* ---------- Máy nhận kết nối (mini PC) ---------- */

async function acceptUpload(ctx, req, from, base) {
  const dir = path.join(ctx.workDir, 'received');
  const tmp = path.join(dir, `incoming-${randomBytes(4).toString('hex')}.tmp`);
  let info;
  let fileName;
  try {
    await decryptToFile(req, tmp, ctx.encKey);
    info = verifySnapshot(tmp);
    fileName = `${stamp()}_${from}_${info.hash.slice(0, 8)}.db`;
    fs.renameSync(tmp, path.join(dir, fileName));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const st = readState(ctx);
  updateState(ctx, { received: { ...st.received, [from]: info.hash } });
  prune(dir, st.pending?.file);
  log(ctx, `Đã nhận bản sao từ ${from} (${info.hash.slice(0, 8)})`);

  let own = null;
  try {
    own = inspectDb(ctx.dbFile);
  } catch {
    return { applied: false, hash: info.hash, reason: 'own-unreadable' };
  }
  if (own.hash === info.hash) return { applied: true, hash: info.hash };
  if (own.rows > 0 && own.hash !== base) return { applied: false, hash: info.hash, reason: 'conflict' };

  updateState(ctx, { pending: { file: fileName, hash: info.hash, base: own.hash, from } });
  const result = await withLock(ctx, () => applyPending(ctx));
  return { applied: result === 'adopted', hash: info.hash, reason: result === 'adopted' ? undefined : 'waiting' };
}

async function handleRequest(ctx, req, res) {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!requestAuthorized(ctx, req)) {
    req.resume();
    return json(401, { error: 'unauthorized' });
  }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/sync/status') {
    const st = readState(ctx);
    const base = { name: ctx.name, received: st.received || {}, pendingHash: st.pending?.hash || null };
    try {
      return json(200, { ...base, ...inspectDb(ctx.dbFile) });
    } catch (err) {
      return json(200, { ...base, error: err.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/sync/snapshot') {
    if (!fs.existsSync(ctx.dbFile)) return json(404, { error: 'no-data' });
    const tmp = path.join(ctx.workDir, `outgoing-${randomBytes(4).toString('hex')}.tmp`);
    try {
      snapshotDb(ctx.dbFile, tmp);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      await pipeline(Readable.from(encryptStream(fs.createReadStream(tmp), ctx.encKey)), res);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return undefined;
  }
  if (req.method === 'POST' && url.pathname === '/sync/snapshot') {
    const from = String(url.searchParams.get('from') || 'may-khac').replace(/[^\w.-]/g, '_');
    return json(200, await acceptUpload(ctx, req, from, url.searchParams.get('base') || ''));
  }
  return json(404, { error: 'not-found' });
}

export function startHub(ctx) {
  const server = http.createServer((req, res) => {
    handleRequest(ctx, req, res).catch((err) => {
      log(ctx, `Lỗi khi phục vụ ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = TRANSFER_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ctx.config.port, () => resolve(server));
  });
}

/* ---------- Máy chủ động kết nối (laptop) ---------- */

function peerUrl(ctx, pathAndQuery) {
  const { peerAddress, peerPort } = ctx.config;
  const host = peerAddress.includes(':') ? peerAddress : `${peerAddress}:${peerPort}`;
  return `http://${host}${pathAndQuery}`;
}

class PeerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function peerFetch(ctx, method, pathAndQuery, { body, timeout = STATUS_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(peerUrl(ctx, pathAndQuery), {
      method,
      headers: authHeaders(ctx, method, pathAndQuery),
      signal: AbortSignal.timeout(timeout),
      ...(body ? { body, duplex: 'half' } : {})
    });
  } catch (err) {
    throw new PeerError('offline', `Không kết nối được: ${err.cause?.code || err.message}`);
  }
  if (res.status === 401) {
    throw new PeerError('bad-key', 'Mini PC từ chối: khác mã kết nối, hoặc đồng hồ hai máy lệch quá 5 phút');
  }
  if (!res.ok) throw new PeerError('peer-error', `Mini PC báo lỗi ${res.status}`);
  return res;
}

async function downloadPeerCopy(ctx, peerName) {
  const dir = path.join(ctx.workDir, 'received');
  const tmp = path.join(dir, `download-${randomBytes(4).toString('hex')}.tmp`);
  try {
    const res = await peerFetch(ctx, 'GET', '/sync/snapshot', { timeout: TRANSFER_TIMEOUT_MS });
    await decryptToFile(Readable.fromWeb(res.body), tmp, ctx.encKey);
    const info = verifySnapshot(tmp);
    const fileName = `${stamp()}_${String(peerName).replace(/[^\w.-]/g, '_')}_${info.hash.slice(0, 8)}.db`;
    fs.renameSync(tmp, path.join(dir, fileName));
    const st = readState(ctx);
    updateState(ctx, { received: { ...st.received, [peerName]: info.hash } });
    prune(dir, st.pending?.file);
    return { ...info, fileName };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function uploadOwnCopy(ctx, base) {
  const tmp = path.join(ctx.workDir, `upload-${randomBytes(4).toString('hex')}.tmp`);
  try {
    snapshotDb(ctx.dbFile, tmp);
    const info = verifySnapshot(tmp);
    const query = `/sync/snapshot?from=${encodeURIComponent(ctx.name)}&base=${encodeURIComponent(base || '')}`;
    const res = await peerFetch(ctx, 'POST', query, {
      body: Readable.from(encryptStream(fs.createReadStream(tmp), ctx.encKey)),
      timeout: TRANSFER_TIMEOUT_MS
    });
    return { ...(await res.json()), hash: info.hash };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const shrankALot = (rows, otherRows) => otherRows >= SHRINK_MIN_ROWS && rows < otherRows * 0.5;

async function adoptFromPeer(ctx, local, remote) {
  const st = readState(ctx);
  if (st.pending?.hash !== remote.hash) {
    const copy = await downloadPeerCopy(ctx, remote.name);
    updateState(ctx, { pending: { file: copy.fileName, hash: copy.hash, base: local.hash, from: remote.name } });
  }
  const result = await applyPending(ctx);
  if (result === 'adopted') return { code: 'adopted', message: `Đã nhận dữ liệu mới từ ${remote.name}` };
  if (result === 'waiting') {
    return {
      code: 'waiting-app',
      message: `Đã tải dữ liệu mới từ ${remote.name}, sẽ áp dụng khi tắt server và chạy lại npm start trên máy này`
    };
  }
  return { code: 'retry', message: 'Dữ liệu máy này vừa đổi, sẽ so sánh lại ở lượt sau' };
}

async function sendToPeer(ctx, remote, base) {
  // Chỉ bỏ qua khi bên kia còn đang chờ áp dụng đúng bản này. "Đã từng nhận" thì chưa đủ:
  // máy đó có thể đã mất dữ liệu và đang cần được gửi lại.
  if (remote.pendingHash && remote.pendingHash === inspectDb(ctx.dbFile).hash) {
    return { code: 'waiting-peer', message: `${remote.name} đã giữ bản sao mới nhất, sẽ dùng khi server bên đó tắt` };
  }
  const result = await uploadOwnCopy(ctx, base);
  if (result.applied) {
    updateState(ctx, { base: result.hash, force: null });
    return { code: 'uploaded', message: `Đã gửi dữ liệu mới sang ${remote.name}` };
  }
  return { code: 'waiting-peer', message: `${remote.name} đã giữ bản sao, sẽ dùng khi server bên đó tắt` };
}

/** Giữ cả hai bản và không thay dữ liệu đang dùng ở bên nào. */
async function keepBoth(ctx, local, remote, code, message) {
  const st = readState(ctx);
  if (st.received?.[remote.name] !== remote.hash) await downloadPeerCopy(ctx, remote.name);
  if (remote.received?.[ctx.name] !== local.hash) await uploadOwnCopy(ctx, '');
  return { code, message };
}

async function reconcile(ctx, local, remote) {
  const st = readState(ctx);
  const L = local.hash;
  const R = remote.hash;
  if (L === R || (local.rows === 0 && remote.rows === 0)) {
    updateState(ctx, { base: L, pending: null, force: null });
    return { code: 'in-sync', message: `Hai máy đã giống nhau (${local.rows} dòng dữ liệu)` };
  }
  if (st.force === 'peer' && R) return adoptFromPeer(ctx, local, remote);
  if (st.force === 'mine' && L) return sendToPeer(ctx, remote, R);
  if (local.rows === 0) return adoptFromPeer(ctx, local, remote);
  if (remote.rows === 0) return sendToPeer(ctx, remote, R);

  const localChanged = L !== st.base;
  const remoteChanged = R !== st.base;
  if (!localChanged) {
    if (shrankALot(remote.rows, local.rows)) {
      return keepBoth(ctx, local, remote, 'guard-peer-shrank',
        `${remote.name} mất nhiều dữ liệu (${remote.rows}/${local.rows} dòng) nên không làm theo. Hai bản đều được giữ`);
    }
    return adoptFromPeer(ctx, local, remote);
  }
  if (!remoteChanged) {
    if (shrankALot(local.rows, remote.rows)) {
      return keepBoth(ctx, local, remote, 'guard-local-shrank',
        `Máy này mất nhiều dữ liệu (${local.rows}/${remote.rows} dòng) nên không gửi đi. Hai bản đều được giữ`);
    }
    return sendToPeer(ctx, remote, R);
  }
  return keepBoth(ctx, local, remote, 'conflict', 'Hai máy đều có thay đổi riêng. Hai bản đều được giữ, cần bạn chọn bản dùng tiếp');
}

const OK_CODES = new Set(['in-sync', 'adopted', 'uploaded', 'waiting-app', 'waiting-peer']);

/** Một lượt đồng bộ. Không ném lỗi: mọi kết quả đều trả về dạng { code, message }. */
export async function runCycle(ctx) {
  const result = await withLock(ctx, async () => {
    try {
      recoverInterruptedReplace(ctx);
      let local = inspectDb(ctx.dbFile);
      takeOwnSnapshot(ctx, local);
      const applied = await applyPending(ctx);
      local = inspectDb(ctx.dbFile);
      if (!ctx.config.peerAddress) {
        return ctx.config.serve
          ? { code: 'hub', message: 'Mini PC đang chờ laptop kết nối' }
          : { code: 'no-peer', message: 'Chưa thêm mini PC, hiện chỉ tự lưu bản sao trên máy này' };
      }
      const remote = await (await peerFetch(ctx, 'GET', '/sync/status')).json();
      if (remote.error) return { code: 'peer-error', message: `Dữ liệu trên ${remote.name} không đọc được: ${remote.error}` };
      const outcome = await reconcile(ctx, local, remote);
      if (applied === 'adopted' && outcome.code === 'in-sync') {
        return { code: 'adopted', message: `Đã áp dụng dữ liệu mới từ ${remote.name}` };
      }
      return outcome;
    } catch (err) {
      if (err instanceof PeerError) return { code: err.code, message: err.message };
      return { code: 'error', message: err.message };
    }
  });
  if (!result) return { code: 'busy', message: 'Một lượt đồng bộ khác đang chạy' };

  const prev = readState(ctx).last;
  if (prev?.code !== result.code || !['in-sync', 'no-peer', 'hub', 'offline'].includes(result.code)) {
    log(ctx, `[${result.code}] ${result.message}`);
  }
  updateState(ctx, {
    last: { ...result, at: Date.now() },
    ...(OK_CODES.has(result.code) ? { lastOkAt: Date.now() } : {})
  });
  return result;
}
