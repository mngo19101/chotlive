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
    CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  for (const t of Object.values(TABLE_OF)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
      user_id TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    )`);
  }
  return db;
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
  for (const r of db.prepare('SELECT token, user_id, created_at FROM tokens').all()) {
    tokens[r.token] = { userId: r.user_id, createdAt: r.created_at };
  }
  return { users, tokens };
}

export function saveUsers(db, usersDb) {
  tx(db, () => {
    db.exec('DELETE FROM users; DELETE FROM tokens;');
    const insUser = db.prepare('INSERT INTO users (id, data) VALUES (?, ?)');
    for (const u of usersDb.users) insUser.run(String(u.id), JSON.stringify(u));
    const insTok = db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)');
    for (const [tk, info] of Object.entries(usersDb.tokens || {})) {
      insTok.run(tk, String(info.userId), Number(info.createdAt) || 0);
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
  });
}
