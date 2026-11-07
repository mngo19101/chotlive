/**
 * Chat hỗ trợ giữa khách và Admin.
 * - Một phiên đóng sau 24 giờ không có tin mới (tính cả tin của Admin); khách nhắn tiếp thì mở phiên mới.
 * - Phiên đã đóng vẫn xem lại được; tin nhắn giữ 30 ngày rồi xoá.
 * - "Đã đọc" lưu theo từng phía bằng mã tin nhắn cuối đã xem.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TEXT = 2000;

export function initSupport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_support_sessions_user ON support_sessions (user_id, last_at);
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
      sender TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_support_messages_session ON support_messages (session_id, id);
    CREATE TABLE IF NOT EXISTS support_reads (
      user_id TEXT NOT NULL, side TEXT NOT NULL, last_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, side)
    );
  `);
}

const isOpen = (lastAt, now) => now - lastAt < SESSION_TTL_MS;

function sessionView(row, now) {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastAt: row.last_at,
    open: isOpen(row.last_at, now),
    closesAt: row.last_at + SESSION_TTL_MS
  };
}

function messageView(r) {
  return { id: Number(r.id), sessionId: r.session_id, userId: r.user_id, sender: r.sender, text: r.text, ts: r.ts };
}

export function cleanText(raw) {
  return String(raw ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
}

/**
 * Khách nhắn: dùng phiên đang mở, hết hạn thì mở phiên mới.
 * Admin trả lời: phải chỉ đúng phiên và phiên còn mở (trả null nếu không).
 */
export function postMessage(db, { userId, sender, text, sessionId = '', now = Date.now() }) {
  const body = cleanText(text);
  if (!body) return null;
  let session;
  if (sender === 'admin') {
    session = db.prepare('SELECT * FROM support_sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
    if (!session || !isOpen(session.last_at, now)) return null;
  } else {
    session = db.prepare('SELECT * FROM support_sessions WHERE user_id = ? ORDER BY last_at DESC LIMIT 1').get(userId);
    if (!session || !isOpen(session.last_at, now)) {
      const id = `ss_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare('INSERT INTO support_sessions (id, user_id, created_at, last_at) VALUES (?, ?, ?, ?)').run(id, userId, now, now);
      session = { id, user_id: userId, created_at: now, last_at: now };
    }
  }
  const r = db
    .prepare('INSERT INTO support_messages (session_id, user_id, sender, text, ts) VALUES (?, ?, ?, ?, ?)')
    .run(session.id, userId, sender, body, now);
  db.prepare('UPDATE support_sessions SET last_at = ? WHERE id = ?').run(now, session.id);
  const message = { id: Number(r.lastInsertRowid), sessionId: session.id, userId, sender, text: body, ts: now };
  return { message, session: sessionView({ ...session, last_at: now }, now) };
}

function lastReadId(db, userId, side) {
  return Number(db.prepare('SELECT last_id FROM support_reads WHERE user_id = ? AND side = ?').get(userId, side)?.last_id ?? 0);
}

/** Số tin chưa đọc mà `side` ('user' hoặc 'admin') nhận từ phía bên kia. */
export function unreadCount(db, userId, side, { forAllUsers = false } = {}) {
  const from = side === 'user' ? 'admin' : 'user';
  if (!forAllUsers) {
    return Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND sender = ? AND id > ?')
        .get(userId, from, lastReadId(db, userId, side)).n
    );
  }
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM support_messages m
         WHERE m.sender = 'user' AND m.id > COALESCE((SELECT last_id FROM support_reads r WHERE r.user_id = m.user_id AND r.side = 'admin'), 0)`
      )
      .get().n
  );
}

export function markRead(db, userId, side) {
  const top = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM support_messages WHERE user_id = ?').get(userId).n);
  db.prepare('INSERT OR REPLACE INTO support_reads (user_id, side, last_id) VALUES (?, ?, ?)').run(userId, side, top);
}

/** Các phiên của một khách, mới nhất trước, kèm tin cuối và số tin chưa đọc theo `side`. */
export function listSessions(db, userId, now = Date.now()) {
  const rows = db.prepare('SELECT * FROM support_sessions WHERE user_id = ? ORDER BY last_at DESC').all(userId);
  return rows.map((row) => withLast(db, sessionView(row, now)));
}

/** Mỗi khách một dòng (phiên mới nhất) cho Admin, tin chưa đọc nhiều nhất lên đầu rồi tới mới nhất. */
export function listSessionsForAdmin(db, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT s.* FROM support_sessions s
       WHERE s.last_at = (SELECT MAX(last_at) FROM support_sessions WHERE user_id = s.user_id)
       ORDER BY s.last_at DESC`
    )
    .all();
  return rows.map((row) => ({
    ...withLast(db, sessionView(row, now)),
    unread: unreadCount(db, row.user_id, 'admin')
  }));
}

function withLast(db, view) {
  const last = db
    .prepare('SELECT sender, text, ts FROM support_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1')
    .get(view.id);
  return { ...view, lastText: last?.text ?? '', lastSender: last?.sender ?? '', unread: 0 };
}

export function getSession(db, sessionId, now = Date.now()) {
  const row = db.prepare('SELECT * FROM support_sessions WHERE id = ?').get(sessionId);
  return row ? sessionView(row, now) : null;
}

export function latestSession(db, userId, now = Date.now()) {
  const row = db.prepare('SELECT * FROM support_sessions WHERE user_id = ? ORDER BY last_at DESC LIMIT 1').get(userId);
  return row ? sessionView(row, now) : null;
}

export function listMessages(db, sessionId) {
  return db.prepare('SELECT * FROM support_messages WHERE session_id = ? ORDER BY id').all(sessionId).map(messageView);
}

/** Xoá tin quá 30 ngày và các phiên không còn tin nào. */
export function purgeOld(db, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  db.prepare('DELETE FROM support_messages WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM support_sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM support_messages) AND last_at < ?').run(cutoff);
}

export function deleteUserSupport(db, userId) {
  db.prepare('DELETE FROM support_messages WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM support_sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM support_reads WHERE user_id = ?').run(userId);
}
