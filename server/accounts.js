/** Tài khoản: mật khẩu, danh sách người dùng, token đăng nhập. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as sqlite from '../db.js';
import { TRIAL_MS } from '../access.js';
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, TOKEN_TTL_MS, USERS_FILE } from './config.js';
import { db } from './database.js';
import { archiveLegacyFile, readLegacyJson } from './util.js';

/* ============================================================
   Mã hoá mật khẩu & Quản lý Người Dùng / Phân Quyền (Admin / User)
   ============================================================ */
const scrypt = promisify(crypto.scrypt);

/** Chạy ngoài luồng chính: nhiều người đăng nhập cùng lúc không làm đứng bình luận đang về. */
export async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(String(password), salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = await scrypt(String(password), salt, 64);
  const original = Buffer.from(originalHash, 'hex');
  return hash.length === original.length && crypto.timingSafeEqual(hash, original);
}

export function normalizeAccountName(name = '') {
  return String(name).trim().toLowerCase();
}

/** Trả về lỗi để báo người dùng, hoặc null nếu mật khẩu mới dùng được. */
export function newPasswordProblem(password, confirm) {
  const text = String(password ?? '');
  if (text.length < MIN_PASSWORD_LENGTH) return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`;
  if (text.length > MAX_PASSWORD_LENGTH) return `Mật khẩu không được dài quá ${MAX_PASSWORD_LENGTH} ký tự.`;
  if (text !== String(confirm ?? '')) return 'Mật khẩu xác nhận không khớp.';
  return null;
}

export function usernameProblem(rawName) {
  const clean = normalizeAccountName(rawName);
  if (clean.length < 2) return 'Tên tài khoản phải có ít nhất 2 ký tự.';
  if (clean.length > MAX_USERNAME_LENGTH) return `Tên tài khoản không được dài quá ${MAX_USERNAME_LENGTH} ký tự.`;
  if (/[\p{C}<>]/u.test(clean)) return 'Tên tài khoản có ký tự không hợp lệ.';
  return null;
}

let generatedAdminPassword = null;
function getInitialAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!generatedAdminPassword) {
    generatedAdminPassword = crypto.randomBytes(9).toString('base64url');
    console.warn(`[auth] Chưa đặt ADMIN_PASSWORD. Mật khẩu admin tạm thời: ${generatedAdminPassword}`);
  }
  return generatedAdminPassword;
}

function loadUsersData() {
  if (sqlite.hasData(db)) return sqlite.loadUsers(db);

  const legacy = readLegacyJson(USERS_FILE);
  if (legacy && Array.isArray(legacy.users) && legacy.users.length) {
    const migrated = { users: legacy.users, tokens: legacy.tokens || {} };
    sqlite.saveUsers(db, migrated);
    archiveLegacyFile(USERS_FILE);
    console.log(`[migrate] Đã chuyển ${migrated.users.length} tài khoản từ users.json sang SQLite.`);
    return migrated;
  }

  const defaultAdmin = {
    id: 'u_admin',
    username: 'admin',
    displayName: 'admin',
    passwordHash: hashPasswordSync(getInitialAdminPassword()),
    role: 'admin',
    locked: false,
    createdAt: Date.now(),
    lastLoginAt: Date.now()
  };

  const data = { users: [defaultAdmin], tokens: {} };
  sqlite.saveUsers(db, data);
  return data;
}

export const usersDb = loadUsersData();

// Đảm bảo luôn có ít nhất 1 tài khoản admin
if (!usersDb.users.some((u) => u.role === 'admin')) {
  usersDb.users.unshift({
    id: 'u_admin',
    username: 'admin',
    displayName: 'admin',
    passwordHash: hashPasswordSync(getInitialAdminPassword()),
    role: 'admin',
    locked: false,
    createdAt: Date.now(),
    lastLoginAt: Date.now()
  });
}
if (!usersDb.tokens || typeof usersDb.tokens !== 'object') {
  usersDb.tokens = {};
}

let saveUsersTimer = null;
export function persistUsersDb() {
  clearTimeout(saveUsersTimer);
  saveUsersTimer = setTimeout(() => {
    flushUsersDb();
  }, 80);
}

export function flushUsersDb() {
  clearTimeout(saveUsersTimer);
  try {
    sqlite.saveUsers(db, usersDb);
  } catch (err) {
    console.warn('[auth] Lỗi lưu SQLite (users):', err.message);
  }
}

/**
 * Tài khoản tạo trước khi có dùng thử cũng chỉ có 3 ngày tính từ ngày tạo, nên tài khoản đã quá 3 ngày bị khoá live ngay.
 * Không rõ ngày tạo thì không biết đã dùng bao lâu, cho 3 ngày từ lúc này.
 * Ghi xuống đĩa luôn để mốc chỉ đặt một lần.
 */
function startTrialForOldAccounts() {
  const now = Date.now();
  let changed = false;
  for (const u of usersDb.users) {
    if (u.role !== 'admin' && !Number.isFinite(u.trialEndsAt)) {
      const created = typeof u.createdAt === 'number' ? u.createdAt : Date.parse(u.createdAt);
      u.trialEndsAt = (Number.isFinite(created) ? Math.min(created, now) : now) + TRIAL_MS;
      changed = true;
    }
  }
  if (changed) flushUsersDb();
}

function purgeExpiredTokens() {
  const now = Date.now();
  let changed = false;
  for (const [tk, info] of Object.entries(usersDb.tokens)) {
    if (!info || !info.createdAt || now - info.createdAt > TOKEN_TTL_MS) {
      delete usersDb.tokens[tk];
      changed = true;
    }
  }
  if (changed) persistUsersDb();
}

// Phải chạy sau khi có saveUsersTimer: token hết hạn lúc khởi động từng làm server không lên được.
purgeExpiredTokens();
startTrialForOldAccounts();

export function createSessionToken(userId) {
  purgeExpiredTokens();
  const token = crypto.randomBytes(28).toString('hex');
  usersDb.tokens[token] = {
    userId,
    createdAt: Date.now()
  };
  persistUsersDb();
  return token;
}

export function revokeUserTokens(userId, exceptToken = null) {
  for (const [tk, info] of Object.entries(usersDb.tokens)) {
    if (info.userId === userId && tk !== exceptToken) {
      delete usersDb.tokens[tk];
    }
  }
  persistUsersDb();
}

export function getUserByToken(token) {
  if (!token) return null;
  const clean = String(token).replace(/^Bearer\s+/i, '').trim();
  const sess = usersDb.tokens[clean];
  if (!sess) return null;
  if (!sess.createdAt || Date.now() - sess.createdAt > TOKEN_TTL_MS) {
    delete usersDb.tokens[clean];
    persistUsersDb();
    return null;
  }
  const user = usersDb.users.find((u) => u.id === sess.userId);
  if (!user) return null;
  return user;
}

export function isDefaultAdminUser(userId) {
  if (!userId || userId === 'u_admin') return true;
  const u = usersDb.users.find((x) => x.id === userId);
  return Boolean(u && normalizeAccountName(u.username) === 'admin');
}

export const usernameOf = (userId) => {
  const u = usersDb.users.find((x) => x.id === userId);
  return u ? u.displayName || u.username : '';
};
