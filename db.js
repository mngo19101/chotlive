import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS, snapCollections } from './delta.js';

const TABLE_OF = {
  orders: 'orders',
  customers: 'customers',
  comments: 'comments',
  sessions: 'live_sessions',
  accounts: 'accounts'
};

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  for (const t of Object.values(TABLE_OF)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
      user_id TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    )`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_comments (
      user_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, ts INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_live_comments_ts ON live_comments (user_id, ts);
    CREATE INDEX IF NOT EXISTS idx_live_comments_session ON live_comments (user_id, session_id, ts);
    CREATE TABLE IF NOT EXISTS ip_registrations (
      ip TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (ip, user_id)
    );
    CREATE TABLE IF NOT EXISTS vtp_waybills (
      user_id TEXT NOT NULL, code TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source TEXT NOT NULL, state TEXT NOT NULL, order_ids TEXT NOT NULL DEFAULT '[]',
      attempt_id TEXT, ref TEXT, cod INTEGER, goods INTEGER, fee INTEGER, service TEXT,
      status INTEGER, status_name TEXT, note TEXT,
      PRIMARY KEY (user_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_vtp_waybills_time ON vtp_waybills (user_id, created_at);
  `);
  migratePlainTokens(db);
  return db;
}

/**
 * Token phiên chỉ lưu dạng sha256 (AUTH-03): ai có bản sao lưu susu.db cũng không dùng được token trong đó.
 * Bộ nhớ (`usersDb.tokens`) cũng giữ theo chuỗi băm; token rõ chỉ trả cho thiết bị lúc đăng nhập.
 */
export const hashSessionToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Chuyển token rõ của bảng `tokens` cũ sang bảng `session_tokens` (băm), giữ nguyên phiên đang đăng nhập.
 * Bảng cũ còn dòng nghĩa là bản code cũ ghi lần cuối (bản mới luôn để trống bảng đó), nên danh sách cũ là danh sách
 * đúng và thay hẳn bảng băm. Xoá với secure_delete rồi dồn WAL để token rõ không còn sót trong file.
 */
function migratePlainTokens(db) {
  const rows = db.prepare('SELECT token, user_id, created_at FROM tokens').all();
  if (!rows.length) return;
  db.exec('PRAGMA secure_delete = ON');
  try {
    tx(db, () => {
      db.exec('DELETE FROM session_tokens');
      const ins = db.prepare('INSERT OR REPLACE INTO session_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)');
      for (const r of rows) ins.run(hashSessionToken(r.token), String(r.user_id), Number(r.created_at) || 0);
      db.exec('DELETE FROM tokens');
    });
  } finally {
    db.exec('PRAGMA secure_delete = OFF');
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/*
 * Sổ vận đơn (BL-08): mọi mã vận đơn Viettel Post từng trả về hoặc báo qua webhook, ghi ngay lúc nhận được và độc lập
 * với dữ liệu đơn. Đơn bị xoá, tách, gộp, hay máy chủ tắt trước khi kịp ghi đơn thì mã vẫn còn ở đây để đối soát.
 * `state`: created · needsCancel · cancelled · detached (shop gỡ khỏi app) · delivered · returned · orphan (có mã mà
 * không gắn được vào đơn nào) · unmatched (chỉ biết qua webhook, chưa đơn nào nhận).
 * `source`: create (trả lời đúng hạn) · late (trả lời muộn) · shop (shop nhập mã) · webhook.
 */
const WAYBILL_FIELDS = ['source', 'state', 'attempt_id', 'ref', 'cod', 'goods', 'fee', 'service', 'status', 'status_name', 'note'];
const waybillRow = (r) => ({
  code: r.code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  source: r.source,
  state: r.state,
  orderIds: JSON.parse(r.order_ids || '[]'),
  attemptId: r.attempt_id,
  ref: r.ref,
  cod: r.cod,
  goods: r.goods,
  fee: r.fee,
  service: r.service,
  status: r.status,
  statusName: r.status_name,
  note: r.note
});

export function getWaybill(db, userId, code) {
  const r = db.prepare('SELECT * FROM vtp_waybills WHERE user_id = ? AND code = ?').get(userId, String(code));
  return r ? waybillRow(r) : null;
}

/**
 * Ghi hoặc cập nhật một mã trong sổ. Trường không truyền (undefined) thì giữ như cũ; `orderIds` rỗng không xoá danh sách
 * đơn đã ghi. Lần đầu ghi bắt buộc có `source` và `state`.
 */
export function recordWaybill(db, userId, code, w = {}, now = Date.now()) {
  const cur = db.prepare('SELECT * FROM vtp_waybills WHERE user_id = ? AND code = ?').get(userId, String(code));
  const val = {
    source: w.source,
    state: w.state,
    attempt_id: w.attemptId,
    ref: w.ref,
    cod: w.cod,
    goods: w.goods,
    fee: w.fee,
    service: w.service,
    status: w.status,
    status_name: w.statusName,
    note: w.note
  };
  const ids = Array.isArray(w.orderIds) ? [...new Set(w.orderIds.map(String))] : [];
  if (!cur) {
    db.prepare(
      `INSERT INTO vtp_waybills (user_id, code, created_at, updated_at, order_ids, ${WAYBILL_FIELDS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ${WAYBILL_FIELDS.map(() => '?').join(', ')})`
    ).run(userId, String(code), now, now, JSON.stringify(ids), ...WAYBILL_FIELDS.map((k) => (val[k] === undefined ? null : val[k])));
    return;
  }
  const sets = ['updated_at = ?'];
  const args = [now];
  for (const k of WAYBILL_FIELDS) {
    // Nguồn đầu tiên giữ nguyên: biết được mã này đến từ đâu.
    if (val[k] === undefined || (k === 'source' && cur.source)) continue;
    sets.push(`${k} = ?`);
    args.push(val[k]);
  }
  if (ids.length) {
    sets.push('order_ids = ?');
    args.push(JSON.stringify(ids));
  }
  db.prepare(`UPDATE vtp_waybills SET ${sets.join(', ')} WHERE user_id = ? AND code = ?`).run(...args, userId, String(code));
}

/** Sổ vận đơn của một tài khoản, mới nhất trước. `state` lọc theo trạng thái trong sổ. */
export function listWaybills(db, userId, { state = '', limit = 200 } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (state) {
    where.push('state = ?');
    args.push(state);
  }
  return db
    .prepare(`SELECT * FROM vtp_waybills WHERE ${where.join(' AND ')} ORDER BY created_at DESC, code DESC LIMIT ?`)
    .all(...args, Math.max(1, Math.min(1000, Number(limit) || 200)))
    .map(waybillRow);
}

/* Tài khoản đã tạo từ mỗi IP. Xoá tài khoản không xoá dòng này, nếu không xoá đi tạo lại sẽ né được giới hạn. */
export function countIpRegistrations(db, ip) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM ip_registrations WHERE ip = ?').get(ip).n);
}

export function addIpRegistration(db, ip, userId, at) {
  db.prepare('INSERT INTO ip_registrations (ip, user_id, created_at) VALUES (?, ?, ?)').run(ip, userId, at);
}

export function removeIpRegistration(db, ip, userId) {
  db.prepare('DELETE FROM ip_registrations WHERE ip = ? AND user_id = ?').run(ip, userId);
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

export function hasData(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

export function loadUsers(db) {
  const users = db.prepare('SELECT data FROM users').all().map((r) => JSON.parse(r.data));
  const tokens = {};
  for (const r of db.prepare('SELECT token_hash, user_id, created_at FROM session_tokens').all()) {
    tokens[r.token_hash] = { userId: r.user_id, createdAt: r.created_at };
  }
  return { users, tokens };
}

export function saveUsers(db, usersDb) {
  tx(db, () => {
    db.exec('DELETE FROM users; DELETE FROM tokens; DELETE FROM session_tokens;');
    const insUser = db.prepare('INSERT INTO users (id, data) VALUES (?, ?)');
    for (const u of usersDb.users) insUser.run(String(u.id), JSON.stringify(u));
    // Khoá của `usersDb.tokens` đã là sha256(token).
    const insTok = db.prepare('INSERT INTO session_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)');
    for (const [hash, info] of Object.entries(usersDb.tokens || {})) {
      insTok.run(hash, String(info.userId), Number(info.createdAt) || 0);
    }
  });
}

export function loadStates(db) {
  const states = {};
  for (const row of db.prepare('SELECT user_id, data FROM settings').all()) {
    const st = JSON.parse(row.data);
    for (const c of COLLECTIONS) {
      st[c] = db
        .prepare(`SELECT data FROM ${TABLE_OF[c]} WHERE user_id = ? ORDER BY pos`)
        .all(row.user_id)
        .map((r) => JSON.parse(r.data));
    }
    states[row.user_id] = st;
  }
  return states;
}

export function saveUserState(db, userId, state, prevSnap) {
  const next = snapCollections(state);
  const scalars = {};
  for (const [k, v] of Object.entries(state)) if (!COLLECTIONS.includes(k)) scalars[k] = v;
  tx(db, () => {
    db.prepare('INSERT OR REPLACE INTO settings (user_id, data) VALUES (?, ?)').run(userId, JSON.stringify(scalars));
    for (const c of COLLECTIONS) {
      const table = TABLE_OF[c];
      const p = prevSnap?.cols[c];
      const n = next.cols[c];
      if (!p) db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
      const upsert = db.prepare(`INSERT OR REPLACE INTO ${table} (user_id, id, pos, data) VALUES (?, ?, ?, ?)`);
      n.ids.forEach((id, i) => {
        if (!p || p.ids[i] !== id || p.json.get(id) !== n.json.get(id)) {
          upsert.run(userId, id, i, n.json.get(id));
        }
      });
      if (p) {
        const del = db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`);
        for (const id of p.ids) if (!n.json.has(id)) del.run(userId, id);
      }
    }
  });
  return next;
}

export function deleteUserData(db, userId) {
  tx(db, () => {
    db.prepare('DELETE FROM settings WHERE user_id = ?').run(userId);
    for (const t of Object.values(TABLE_OF)) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    db.prepare('DELETE FROM live_comments WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM vtp_waybills WHERE user_id = ?').run(userId);
  });
}

/* Lịch sử bình luận: mỗi bình luận một dòng, trùng mã thì bỏ qua. */
const commentRow = (c) => [String(c.id), c.sessionId ? String(c.sessionId) : null, Number(c.ts) || 0, JSON.stringify(c)];

/** Trả về true nếu là bình luận mới. */
export function insertComment(db, userId, c) {
  const r = db
    .prepare('INSERT OR IGNORE INTO live_comments (user_id, id, session_id, ts, data) VALUES (?, ?, ?, ?, ?)')
    .run(userId, ...commentRow(c));
  return Number(r.changes) > 0;
}

export function insertComments(db, userId, comments) {
  tx(db, () => {
    for (const c of comments) if (c && c.id != null) insertComment(db, userId, c);
  });
}

export function updateComment(db, userId, c) {
  db.prepare('UPDATE live_comments SET data = ? WHERE user_id = ? AND id = ?').run(JSON.stringify(c), userId, String(c.id));
}

export function markCommentPrinted(db, userId, id) {
  const row = db.prepare('SELECT data FROM live_comments WHERE user_id = ? AND id = ?').get(userId, id);
  if (!row) return;
  const c = JSON.parse(row.data);
  if (c.printed) return;
  c.printed = true;
  updateComment(db, userId, c);
}

export function listComments(db, userId, { sessionId = '', before = 0, beforeId = '', since = 0, limit = 200 } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (sessionId) {
    where.push('session_id = ?');
    args.push(sessionId);
  }
  if (before && beforeId) {
    // Nhiều bình luận có thể trùng mốc thời gian: phải kèm id thì sang trang mới không sót.
    where.push('(ts < ? OR (ts = ? AND id < ?))');
    args.push(before, before, beforeId);
  } else if (before) {
    where.push('ts < ?');
    args.push(before);
  }
  if (since) {
    where.push('ts >= ?');
    args.push(since);
  }
  // `since` đi từ cũ tới mới để app lấy dần phần còn thiếu; còn lại đi từ mới về cũ.
  const order = since ? 'ASC' : 'DESC';
  return db
    .prepare(`SELECT data FROM live_comments WHERE ${where.join(' AND ')} ORDER BY ts ${order}, id ${order} LIMIT ?`)
    .all(...args, limit)
    .map((r) => JSON.parse(r.data));
}

export function clearComments(db, userId) {
  db.prepare('DELETE FROM live_comments WHERE user_id = ?').run(userId);
}

/** Mốc thời gian trước ngày này coi là lỗi (0, tính bằng giây thay vì mili giây...): không bao giờ xóa. */
const MIN_VALID_TS = Date.UTC(2024, 0, 1);
/** Một lần dọn mà xóa quá tỉ lệ này thì gần như chắc là đồng hồ hay dữ liệu bị lỗi: dừng lại. */
const MAX_PURGE_FRACTION = 0.2;

/**
 * Xóa bình luận cũ hơn `olderThanMs`, trừ bình luận đã chốt:
 * đã in, có giá (đọc ra được số tiền) hoặc được đơn/khách tham chiếu qua `keepIds`.
 *
 * Chống xóa nhầm vì lỗi thời gian:
 * - Mốc thời gian vô lý (trước 2024, hay ở tương lai) thì bỏ qua, giữ nguyên bình luận.
 * - Tuổi bình luận tính từ bình luận mới nhất chứ không chỉ từ đồng hồ máy:
 *   đồng hồ laptop nhảy tới năm 2030 cũng không làm mọi thứ "quá 1 năm".
 * - Một lần mà phải xóa hơn 20% bình luận của tài khoản thì không xóa gì, báo `blocked`.
 *   Chạy đều mỗi ngày thì mỗi lần chỉ xóa khoảng một ngày bình luận cũ.
 */
export function purgeOldComments(db, userId, olderThanMs, keepIds = new Set(), now = Date.now()) {
  const { newest, total } = db
    .prepare('SELECT MAX(ts) AS newest, COUNT(*) AS total FROM live_comments WHERE user_id = ? AND ts >= ? AND ts <= ?')
    .get(userId, MIN_VALID_TS, now + 24 * 60 * 60 * 1000);
  if (!newest) return { deleted: 0 };
  const cutoff = Math.min(now, Number(newest)) - olderThanMs;
  if (cutoff <= MIN_VALID_TS) return { deleted: 0 };

  const rows = db
    .prepare(
      `SELECT id FROM live_comments
       WHERE user_id = ? AND ts >= ? AND ts < ?
         AND COALESCE(json_extract(data, '$.printed'), 0) = 0
         AND COALESCE(json_extract(data, '$.price'), 0) = 0`
    )
    .all(userId, MIN_VALID_TS, cutoff)
    .map((r) => r.id)
    .filter((id) => !keepIds.has(String(id)));
  if (!rows.length) return { deleted: 0 };
  if (rows.length > Number(total) * MAX_PURGE_FRACTION) return { deleted: 0, blocked: rows.length, total: Number(total) };

  const del = db.prepare('DELETE FROM live_comments WHERE user_id = ? AND id = ?');
  tx(db, () => {
    for (const id of rows) del.run(userId, id);
  });
  return { deleted: rows.length };
}
