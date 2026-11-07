/**
 * Susu Live Order / ChốtLive – Server, Auth, Admin & Real-Time Sync Hub (Web <-> iOS IPA App)
 * - Hệ thống Đăng nhập / Đăng ký (Chỉ cần Tên tài khoản + Mật khẩu + Xác nhận mật khẩu)
 * - Phân quyền:
 *   + Tài khoản Admin riêng (mật khẩu đặt qua ADMIN_PASSWORD, xem .env.example) quản lý toàn bộ tài khoản:
 *     Xem danh sách, Tạo mới, Khoá / Mở khoá tài khoản (đẩy văng tức thì nếu đang online), Đổi mật khẩu, Xoá tài khoản.
 *   + Tài khoản Thành viên (user): sử dụng đầy đủ tính năng chốt đơn, in tem, đồng bộ Web <-> App IPA.
 * - Lưu trữ và đồng bộ dữ liệu thời gian thực theo từng tài khoản qua WebSocket (/ws) + REST API.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import {
  DEFAULT_SETTINGS,
  initialCustomers,
  initialOrders,
  initialComments,
  initialSessions,
  initialSalesMetrics
} from './public/js/store.js';
import * as sqlite from './db.js';
import { snapCollections, diffCollections, snapScalars, diffScalars } from './delta.js';
import { parsePrice, extractProductInfo } from './public/js/price.js';
import { LiveManager, liveKey } from './live-manager.js';
import { createLimiter, waitMessage } from './rate-limit.js';
import { cleanNativeUpdate, cleanState, isObject } from './validate.js';
import {
  applyNativeUpdate,
  durationText,
  mergeNativeSessions,
  nativeComment,
  sessionName,
  timeOf,
  toNativeSnapshot
} from './native-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
/** Trên VPS đặt 127.0.0.1 để chỉ Caddy nối được vào, không ai đi vòng qua HTTPS. */
const HOST = process.env.HOST || undefined;
/**
 * Chỉ bật khi server chạy trong cùng mạng với máy in (laptop, mini PC).
 * Tắt trên VPS: in LAN cho server tự mở kết nối tới địa chỉ nội bộ theo yêu cầu của người dùng.
 */
const LAN_MODE = process.env.LAN_MODE === '1';
const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
const MAX_USERNAME_LENGTH = 32;
/** Dữ liệu đồng bộ lần đầu của một shop lớn vẫn lọt, gói lớn hơn thì coi là bất thường. */
const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024;
const TOKEN_TTL_MS = (Number(process.env.TOKEN_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;
/** Số bình luận mới nhất giữ sẵn trong dữ liệu đồng bộ. Toàn bộ nằm trong bảng live_comments. */
const COMMENT_WINDOW = 500;
const MAX_LIVES_PER_USER = 10;
const SESSION_RESUME_MS = 5 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STATES_FILE = path.join(DATA_DIR, 'sync-states-by-user.json');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

const db = sqlite.openDb(path.join(DATA_DIR, 'susu.db'));

/**
 * Lỗi khi xử lý một tin nhắn hay một sự kiện chỉ được ảnh hưởng tới chính nó:
 * server chạy chung cho mọi shop, không thể để một gói dữ liệu sai làm ngắt tất cả.
 */
function safely(label, fn, onError) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error(`[${label}]`, err);
      try {
        onError?.(...args);
      } catch {}
    }
  };
}

function readLegacyJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[migrate] Không đọc được ${path.basename(file)}:`, err.message);
  }
  return null;
}

function archiveLegacyFile(file) {
  try {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.migrated`);
  } catch {}
}

/* ============================================================
   Mã hoá mật khẩu & Quản lý Người Dùng / Phân Quyền (Admin / User)
   ============================================================ */
const scrypt = promisify(crypto.scrypt);

/** Chạy ngoài luồng chính: nhiều người đăng nhập cùng lúc không làm đứng bình luận đang về. */
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(String(password), salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = await scrypt(String(password), salt, 64);
  const original = Buffer.from(originalHash, 'hex');
  return hash.length === original.length && crypto.timingSafeEqual(hash, original);
}

function normalizeAccountName(name = '') {
  return String(name).trim().toLowerCase();
}

/** Trả về lỗi để báo người dùng, hoặc null nếu mật khẩu mới dùng được. */
function newPasswordProblem(password, confirm) {
  const text = String(password ?? '');
  if (text.length < MIN_PASSWORD_LENGTH) return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`;
  if (text.length > MAX_PASSWORD_LENGTH) return `Mật khẩu không được dài quá ${MAX_PASSWORD_LENGTH} ký tự.`;
  if (text !== String(confirm ?? '')) return 'Mật khẩu xác nhận không khớp.';
  return null;
}

function usernameProblem(rawName) {
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

let usersDb = loadUsersData();

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
purgeExpiredTokens();
if (!usersDb.tokens || typeof usersDb.tokens !== 'object') {
  usersDb.tokens = {};
}

let saveUsersTimer = null;
function persistUsersDb() {
  clearTimeout(saveUsersTimer);
  saveUsersTimer = setTimeout(() => {
    flushUsersDb();
  }, 80);
}

function flushUsersDb() {
  clearTimeout(saveUsersTimer);
  try {
    sqlite.saveUsers(db, usersDb);
  } catch (err) {
    console.warn('[auth] Lỗi lưu SQLite (users):', err.message);
  }
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

function createSessionToken(userId) {
  purgeExpiredTokens();
  const token = crypto.randomBytes(28).toString('hex');
  usersDb.tokens[token] = {
    userId,
    createdAt: Date.now()
  };
  persistUsersDb();
  return token;
}

function revokeUserTokens(userId, exceptToken = null) {
  for (const [tk, info] of Object.entries(usersDb.tokens)) {
    if (info.userId === userId && tk !== exceptToken) {
      delete usersDb.tokens[tk];
    }
  }
  persistUsersDb();
}

function getUserByToken(token) {
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

function sanitizeUser(u) {
  return {
    id: u.id,
    username: u.displayName || u.username,
    role: u.role || 'user',
    locked: Boolean(u.locked),
    createdAt: u.createdAt || Date.now(),
    lastLoginAt: u.lastLoginAt || null,
    onlineCount: countOnlineClientsForUser(u.id)
  };
}

/* ============================================================
   Quản lý Trạng Thái Đồng Bộ Theo Từng Tài Khoản
   ============================================================ */
function createDefaultSharedState(shopName = 'Shop Hoa Hồng') {
  return {
    rev: 1,
    updatedAt: Date.now(),
    isCleanAccount: false,
    settings: { ...DEFAULT_SETTINGS, shopName, voiceEnabled: false },
    seq: 5,
    orders: structuredClone(initialOrders),
    customers: structuredClone(initialCustomers),
    comments: structuredClone(initialComments),
    sessions: structuredClone(initialSessions),
    salesMetrics: structuredClone(initialSalesMetrics),
    accounts: structuredClone(DEFAULT_SETTINGS.accounts),
    prints: [],
    selectedCustomerUniqueId: 'linh.nguyen98',
    activeSessionId: 's_evening'
  };
}

function createEmptyUserState(shopName = 'Shop mới') {
  const cleanName = String(shopName || 'Shop mới').trim();
  return {
    rev: 1,
    updatedAt: Date.now(),
    isCleanAccount: true,
    settings: {
      ...DEFAULT_SETTINGS,
      shopName: cleanName,
      shopHandle: 'Chưa liên kết TikTok',
      footer: `Cảm ơn bạn đã ủng hộ ${cleanName} ♥`,
      lastUsername: '',
      voiceEnabled: false,
      accounts: []
    },
    seq: 0,
    orders: [],
    customers: [],
    comments: [],
    sessions: [],
    salesMetrics: {
      todayRevenue: 0,
      todayGrowth: '0% so với hôm qua',
      todayCustomers: 0,
      todayNewCustomers: 0,
      monthRevenue: 0,
      monthGrowth: '0% so với tháng trước',
      chartDays: [
        { day: 'T2', amount: 0, height: 4 },
        { day: 'T3', amount: 0, height: 4 },
        { day: 'T4', amount: 0, height: 4 },
        { day: 'T5', amount: 0, height: 4 },
        { day: 'T6', amount: 0, height: 4 },
        { day: 'T7', amount: 0, height: 4 },
        { day: 'CN', amount: 0, height: 4, highlight: true, text: '0đ' }
      ]
    },
    accounts: [],
    prints: [],
    selectedCustomerUniqueId: '',
    activeSessionId: ''
  };
}

function isDefaultAdminUser(userId) {
  if (!userId || userId === 'u_admin') return true;
  const u = usersDb.users.find((x) => x.id === userId);
  return Boolean(u && normalizeAccountName(u.username) === 'admin');
}

const savedSnaps = {};

function loadAllStatesByUser() {
  const fromDb = sqlite.loadStates(db);
  if (Object.keys(fromDb).length) {
    // Dữ liệu sai đã lưu từ trước không được làm sập server mỗi lần có thiết bị mở tài khoản đó.
    for (const [uid, st] of Object.entries(fromDb)) {
      savedSnaps[uid] = snapCollections(st);
      fromDb[uid] = cleanState(st);
    }
    return fromDb;
  }

  const legacy = readLegacyJson(STATES_FILE);
  if (legacy && typeof legacy === 'object' && Object.keys(legacy).length) {
    for (const [uid, st] of Object.entries(legacy)) {
      savedSnaps[uid] = sqlite.saveUserState(db, uid, st, null);
    }
    archiveLegacyFile(STATES_FILE);
    console.log(`[migrate] Đã chuyển dữ liệu của ${Object.keys(legacy).length} tài khoản sang SQLite.`);
    return legacy;
  }
  return {
    u_admin: createDefaultSharedState('Shop Hoa Hồng')
  };
}

const statesByUserId = loadAllStatesByUser();

for (const [uid, st] of Object.entries(statesByUserId)) {
  if (Array.isArray(st.comments)) sqlite.insertComments(db, uid, st.comments);
}

function getStateForUser(userId) {
  const key = userId || 'u_admin';
  const u = usersDb.users.find((x) => x.id === key);
  const isDefaultAdmin = isDefaultAdminUser(key);

  if (!statesByUserId[key]) {
    statesByUserId[key] = isDefaultAdmin
      ? createDefaultSharedState(u?.displayName || 'Shop Hoa Hồng')
      : createEmptyUserState(u?.displayName || u?.username || 'Shop mới');
    persistAllStates(key);
  } else if (!isDefaultAdmin && !statesByUserId[key].isCleanAccount) {
    // Chỉ đánh dấu cờ, KHÔNG xoá dữ liệu thật của người dùng (trước đây xoá nhầm dữ liệu
    // của các tài khoản được migrate từ file JSON cũ, do thiếu cờ isCleanAccount).
    statesByUserId[key].isCleanAccount = true;
    persistAllStates(key);
  }
  return statesByUserId[key];
}

let saveStateTimer = null;
const dirtyStates = new Set();
let dirtyAllStates = false;

function persistAllStates(userId) {
  if (userId) dirtyStates.add(userId);
  else dirtyAllStates = true;
  // Hẹn giờ một lần: bình luận về liên tục không được đẩy lùi việc ghi mãi.
  if (!saveStateTimer) saveStateTimer = setTimeout(flushStates, 150);
}

function flushStates() {
  clearTimeout(saveStateTimer);
  saveStateTimer = null;
  const ids = dirtyAllStates ? Object.keys(statesByUserId) : [...dirtyStates];
  dirtyAllStates = false;
  dirtyStates.clear();
  for (const id of ids) {
    if (!statesByUserId[id]) continue;
    try {
      savedSnaps[id] = sqlite.saveUserState(db, id, statesByUserId[id], savedSnaps[id] || null);
    } catch (err) {
      console.warn('[sync] Lỗi ghi SQLite (state):', err.message);
      dirtyStates.add(id);
    }
  }
}

function flushAllAndExit() {
  liveManager.stopAll();
  flushStates();
  flushUsersDb();
  process.exit(0);
}
process.on('SIGTERM', flushAllAndExit);
process.on('SIGINT', flushAllAndExit);
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => {
  // Lỗi lọt qua mọi lớp chặn: ghi nốt dữ liệu rồi thoát để nền tảng khởi động lại server sạch.
  console.error('[uncaughtException]', err);
  try {
    flushStates();
    flushUsersDb();
  } catch {}
  process.exit(1);
});

/* ============================================================
   Express Server & Middleware
   ============================================================ */
const app = express();

app.disable('x-powered-by');
// Mặc định chỉ tin IP do Caddy trên cùng máy báo lại; người ngoài không giả IP được để né giới hạn.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    etag: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store');
    }
  })
);

function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  return req.query?.token || req.body?.token || '';
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  const user = getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', code: 'UNAUTHORIZED' });
  }
  if (user.locked) {
    return res.status(403).json({ error: 'Tài khoản của bạn đã bị quản trị viên khoá.', code: 'ACCOUNT_LOCKED' });
  }
  req.user = user;
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Chỉ tài khoản Admin mới có quyền thực hiện thao tác này.' });
    }
    next();
  });
}

app.get('/healthz', (_req, res) =>
  res.json({
    ok: true,
    time: Date.now(),
    clients: wss.clients.size
  })
);

/* ============================================================
   API ĐĂNG NHẬP / ĐĂNG KÝ / ĐỔI MẬT KHẨU
   ============================================================ */

// Nhiều shop có thể chung một IP (mạng di động), nên giới hạn theo IP phải rộng hơn theo từng tài khoản.
const loginFailuresByAccount = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const loginFailuresByIp = createLimiter({ max: 100, windowMs: 15 * 60 * 1000 });
const registrationsByIp = createLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
setInterval(() => {
  loginFailuresByAccount.sweep();
  loginFailuresByIp.sweep();
  registrationsByIp.sweep();
}, 10 * 60 * 1000).unref();

// 1. Đăng nhập
app.post('/api/auth/login', async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const cleanName = normalizeAccountName(username);
  if (!cleanName || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tên tài khoản và mật khẩu.' });
  }

  const accountKey = `${req.ip}|${cleanName}`;
  const wait = Math.max(loginFailuresByAccount.retryAfter(accountKey), loginFailuresByIp.retryAfter(req.ip));
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: waitMessage(wait), code: 'TOO_MANY_ATTEMPTS' });
  }

  const user = usersDb.users.find((u) => normalizeAccountName(u.username) === cleanName);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    loginFailuresByAccount.hit(accountKey);
    loginFailuresByIp.hit(req.ip);
    return res.status(401).json({ error: 'Tên tài khoản hoặc mật khẩu không chính xác.' });
  }
  loginFailuresByAccount.reset(accountKey);

  if (user.locked) {
    return res.status(403).json({
      error: 'Tài khoản này đã bị quản trị viên khoá. Vui lòng liên hệ Admin.',
      code: 'ACCOUNT_LOCKED'
    });
  }

  user.lastLoginAt = Date.now();
  const token = createSessionToken(user.id);
  persistUsersDb();
  broadcastAdminUsersUpdate();

  return res.json({
    ok: true,
    token,
    user: sanitizeUser(user),
    state: getStateForUser(user.id)
  });
});

// 2. Đăng ký (Chỉ cần nhập: Tên tài khoản, Mật khẩu, Xác nhận mật khẩu)
app.post('/api/auth/register', async (req, res) => {
  const { username = '', password = '', confirmPassword = '' } = req.body || {};
  const rawName = String(username).trim();
  const cleanName = normalizeAccountName(rawName);

  const problem = usernameProblem(rawName) || newPasswordProblem(password, confirmPassword);
  if (problem) return res.status(400).json({ error: problem });

  const nameTaken = () => usersDb.users.some((u) => normalizeAccountName(u.username) === cleanName);
  if (nameTaken()) {
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại, vui lòng chọn tên khác.' });
  }

  const wait = registrationsByIp.retryAfter(req.ip);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: waitMessage(wait), code: 'TOO_MANY_ATTEMPTS' });
  }
  registrationsByIp.hit(req.ip);

  const passwordHash = await hashPassword(password);
  // Hai người cùng đăng ký một tên: trong lúc chờ mã hoá mật khẩu, người kia có thể đã tạo xong.
  if (nameTaken()) {
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại, vui lòng chọn tên khác.' });
  }

  const newUser = {
    id: 'u_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    username: cleanName,
    displayName: rawName,
    passwordHash,
    role: 'user',
    locked: false,
    createdAt: Date.now(),
    lastLoginAt: Date.now()
  };

  usersDb.users.push(newUser);
  getStateForUser(newUser.id);
  persistAllStates();

  const token = createSessionToken(newUser.id);
  persistUsersDb();
  broadcastAdminUsersUpdate();

  return res.json({
    ok: true,
    token,
    user: sanitizeUser(newUser),
    state: getStateForUser(newUser.id)
  });
});

// 3. Kiểm tra phiên đăng nhập hiện tại
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    ok: true,
    user: sanitizeUser(req.user)
  });
});

// 4. Tự đổi mật khẩu cá nhân
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword = '', newPassword = '', confirmPassword = '' } = req.body || {};
  if (!(await verifyPassword(currentPassword, req.user.passwordHash))) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
  }
  const problem = newPasswordProblem(newPassword, confirmPassword);
  if (problem) return res.status(400).json({ error: problem });

  req.user.passwordHash = await hashPassword(newPassword);
  revokeUserTokens(req.user.id, req.token);
  kickUserSockets(req.user.id, {
    type: 'password_changed_force_login',
    userId: req.user.id,
    message: 'Mật khẩu tài khoản vừa được đổi. Vui lòng đăng nhập lại.'
  }, req.token);
  persistUsersDb();

  res.json({ ok: true, message: 'Đã đổi mật khẩu thành công!' });
});

// 5. Đăng xuất
app.post('/api/auth/logout', (req, res) => {
  const token = extractToken(req);
  if (token && usersDb.tokens[token]) {
    delete usersDb.tokens[token];
    persistUsersDb();
  }
  res.json({ ok: true });
});

/* ============================================================
   API QUẢN TRỊ VIÊN (ADMIN QUẢN LÝ TÀI KHOẢN: KHOÁ, ĐỔI PASS, TẠO, XOÁ)
   ============================================================ */

// Lấy danh sách toàn bộ tài khoản
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    users: usersDb.users.map(sanitizeUser)
  });
});

// Admin tạo tài khoản mới
app.post('/api/admin/users/create', requireAdmin, async (req, res) => {
  const { username = '', password = '', confirmPassword = '', role = 'user' } = req.body || {};
  const rawName = String(username).trim();
  const cleanName = normalizeAccountName(rawName);

  const problem = usernameProblem(rawName) || newPasswordProblem(password, confirmPassword);
  if (problem) return res.status(400).json({ error: problem });

  const nameTaken = () => usersDb.users.some((u) => normalizeAccountName(u.username) === cleanName);
  if (nameTaken()) {
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại.' });
  }

  const passwordHash = await hashPassword(password);
  if (nameTaken()) {
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại.' });
  }

  const newUser = {
    id: 'u_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    username: cleanName,
    displayName: rawName,
    passwordHash,
    role: role === 'admin' ? 'admin' : 'user',
    locked: false,
    createdAt: Date.now(),
    lastLoginAt: null
  };

  usersDb.users.push(newUser);
  getStateForUser(newUser.id);
  persistAllStates(newUser.id);
  persistUsersDb();
  broadcastAdminUsersUpdate();

  res.json({
    ok: true,
    user: sanitizeUser(newUser),
    users: usersDb.users.map(sanitizeUser)
  });
});

// Admin Khoá / Mở khoá tài khoản
app.post('/api/admin/users/:id/lock', requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const { locked } = req.body || {};
  const target = usersDb.users.find((u) => u.id === targetId);
  if (!target) {
    return res.status(404).json({ error: 'Không tìm thấy tài khoản này.' });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'Bạn không thể tự khoá tài khoản Admin của chính mình.' });
  }

  target.locked = Boolean(locked);
  if (target.locked) {
    liveManager.stop(target.id);
    revokeUserTokens(target.id);
    // Đẩy thông báo khoá tài khoản tức thì tới mọi thiết bị của user đó đang mở
    kickUserSockets(target.id, {
      type: 'account_locked',
      userId: target.id,
      message: 'Tài khoản của bạn đã bị Quản trị viên khoá.'
    });
  }
  persistUsersDb();
  broadcastAdminUsersUpdate();

  res.json({
    ok: true,
    user: sanitizeUser(target),
    users: usersDb.users.map(sanitizeUser)
  });
});

// Admin Đổi mật khẩu cho bất kỳ tài khoản nào
app.post('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const targetId = req.params.id;
  const { newPassword = '', confirmPassword = '' } = req.body || {};
  const target = usersDb.users.find((u) => u.id === targetId);
  if (!target) {
    return res.status(404).json({ error: 'Không tìm thấy tài khoản này.' });
  }
  const problem = newPasswordProblem(newPassword, confirmPassword);
  if (problem) return res.status(400).json({ error: problem });

  target.passwordHash = await hashPassword(newPassword);
  const exceptToken = target.id === req.user.id ? req.token : null;
  revokeUserTokens(target.id, exceptToken);
  kickUserSockets(target.id, {
    type: 'password_changed_force_login',
    userId: target.id,
    message: 'Mật khẩu tài khoản đã được Quản trị viên thay đổi. Vui lòng đăng nhập lại.'
  }, exceptToken);
  persistUsersDb();
  broadcastAdminUsersUpdate();

  res.json({
    ok: true,
    message: `Đã đổi mật khẩu cho tài khoản ${target.displayName || target.username}!`,
    users: usersDb.users.map(sanitizeUser)
  });
});

// Admin Xoá tài khoản
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const target = usersDb.users.find((u) => u.id === targetId);
  if (!target) {
    return res.status(404).json({ error: 'Không tìm thấy tài khoản này.' });
  }
  if (target.id === req.user.id || normalizeAccountName(target.username) === 'admin') {
    return res.status(400).json({ error: 'Không thể xoá tài khoản Admin gốc.' });
  }

  liveManager.stop(target.id);
  revokeUserTokens(target.id);
  kickUserSockets(target.id, {
    type: 'account_locked',
    userId: target.id,
    message: 'Tài khoản của bạn đã bị Quản trị viên xoá khỏi hệ thống.'
  });

  usersDb.users = usersDb.users.filter((u) => u.id !== targetId);
  delete statesByUserId[targetId];
  delete savedSnaps[targetId];
  dirtyStates.delete(targetId);
  try {
    sqlite.deleteUserData(db, targetId);
  } catch (err) {
    console.warn('[db] Lỗi xoá dữ liệu user:', err.message);
  }
  persistUsersDb();
  broadcastAdminUsersUpdate();

  res.json({
    ok: true,
    users: usersDb.users.map(sanitizeUser)
  });
});

/* ============================================================
   API ĐỒNG BỘ DỮ LIỆU GIỮA WEB & APP IPA
   ============================================================ */
app.get('/api/state', requireAuth, (req, res) => {
  const userId = req.user.id;
  const userState = getStateForUser(userId);
  res.json({
    ok: true,
    rev: userState.rev,
    clientsCount: countOnlineClientsForUser(userId),
    liveStatus: getLiveStatus(userId),
    lives: liveManager.list(userId),
    state: userState
  });
});

/** Lịch sử bình luận: `before` lấy dần về quá khứ, `since` lấy phần mới hơn một mốc (app nối lại). */
app.get('/api/comments', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const rows = sqlite.listComments(db, req.user.id, {
    sessionId: req.query.sessionId ? String(req.query.sessionId) : '',
    before: Number(req.query.before) || 0,
    beforeId: req.query.beforeId ? String(req.query.beforeId) : '',
    since: Number(req.query.since) || 0,
    limit: limit + 1
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({ ok: true, hasMore, comments: req.query.format === 'native' ? page.map(nativeComment) : page });
});

/** Địa chỉ trong mạng nội bộ để nhập trên điện thoại khi chạy server ở máy tính. */
function lanAddresses() {
  if (!LAN_MODE) return [];
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vmware|virtual|vethernet|vbox|wsl|docker|loopback|hyper-v|tailscale|zerotier/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address)) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

app.get('/api/server-info', requireAuth, (req, res) => {
  res.json({ ok: true, lanUrls: lanAddresses(), account: req.user.displayName || req.user.username });
});

app.post('/api/sync', requireAuth, (req, res) => {
  const userId = req.user.id;
  const { state: incoming, action = 'update', clientId = '' } = req.body || {};
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'Dữ liệu đồng bộ không hợp lệ' });
  }
  const updated = applyIncomingStateForUser(userId, incoming, action, clientId);
  res.json({
    ok: true,
    rev: updated.rev,
    clientsCount: countOnlineClientsForUser(userId)
  });
});

app.post('/api/reset', requireAuth, (req, res) => {
  const user = req.user;
  const userId = user.id;
  const { clientId = '' } = req.body || {};
  liveManager.stop(userId);
  sqlite.clearComments(db, userId);
  statesByUserId[userId] = isDefaultAdminUser(userId)
    ? createDefaultSharedState(user?.displayName || 'Shop Hoa Hồng')
    : createEmptyUserState(user?.displayName || user?.username || 'Shop mới');
  statesByUserId[userId].rev = Date.now();
  persistAllStates(userId);
  broadcastToUser(userId, {
    type: 'state_sync',
    rev: statesByUserId[userId].rev,
    state: statesByUserId[userId],
    action: 'reset',
    clientId
  });
  res.json({ ok: true, rev: statesByUserId[userId].rev, state: statesByUserId[userId] });
});

// Endpoint in trực tiếp qua mạng LAN/WiFi tới máy in nhiệt cổng 9100
const isPrivateIPv4 = (ip) => {
  if (net.isIPv4(ip) !== true) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
};

app.post('/api/print-lan', requireAuth, (req, res) => {
  if (!LAN_MODE) {
    return res.status(403).json({
      error: 'Máy chủ trên Internet không nối được máy in trong mạng của shop. Vui lòng in qua Bluetooth hoặc USB.',
      code: 'LAN_PRINT_DISABLED'
    });
  }
  const { ip, port = 9100, bytes } = req.body || {};
  if (!ip || !Array.isArray(bytes) || bytes.length === 0) {
    return res.status(400).json({ error: 'Thiếu ip hoặc bytes in' });
  }
  if (!isPrivateIPv4(String(ip))) {
    return res.status(400).json({ error: 'IP máy in phải là địa chỉ mạng nội bộ (LAN)' });
  }

  const client = new net.Socket();
  client.setTimeout(5000);
  let done = false;
  const reply = (status, body) => {
    if (done) return;
    done = true;
    client.destroy();
    res.status(status).json(body);
  };

  client.connect(Number(port) || 9100, String(ip), () => {
    client.write(Buffer.from(bytes), (err) => {
      if (err) return reply(500, { error: 'Gửi dữ liệu in thất bại: ' + err.message });
      client.end();
      reply(200, { ok: true, sentBytes: bytes.length });
    });
  });

  client.on('error', (err) => reply(500, { error: 'Không kết nối được máy in: ' + err.message }));
  client.on('timeout', () => reply(504, { error: 'Quá thời gian chờ máy in phản hồi' }));
});

/* ============================================================
   WebSocket Real-Time Sync Hub
   ============================================================ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_MESSAGE_BYTES });

/**
 * Báo rồi ngắt các thiết bị đang nối của một tài khoản (trừ thiết bị đang dùng exceptToken):
 * token đã thu hồi thì kết nối đang mở cũng không được tiếp tục nhận dữ liệu.
 */
function kickUserSockets(userId, payload, exceptToken = null) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.userId !== userId || (exceptToken && client.token === exceptToken)) return;
    try {
      if (client.readyState === 1) client.send(msg);
      client.close(4001, 'session revoked');
    } catch {}
  });
}

function countOnlineClientsForUser(userId) {
  let cnt = 0;
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c.userId && c.userId === userId) {
      cnt++;
    }
  });
  return cnt;
}

function broadcastToUser(userId, payload, excludeWs = null) {
  const targetUid = userId;
  if (!targetUid) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === 1 && client.userId === targetUid) {
      try {
        client.send(msg);
      } catch {}
    }
  });
}

function broadcastAdminUsersUpdate() {
  const allSanitized = usersDb.users.map(sanitizeUser);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.userRole === 'admin') {
      try {
        client.send(
          JSON.stringify({
            type: 'admin_users_sync',
            users: allSanitized
          })
        );
      } catch {}
    }
  });
}

function broadcastStateUpdate(userId, payloadFull, delta, scalars, baseRev, excludeWs = null) {
  if (!userId) return;
  let fullMsg = null;
  const deltaMsg = delta
    ? JSON.stringify({
        type: 'state_delta',
        baseRev,
        rev: payloadFull.rev,
        collections: delta,
        scalars,
        action: payloadFull.action,
        clientId: payloadFull.clientId
      })
    : null;
  wss.clients.forEach((client) => {
    if (client === excludeWs || client.readyState !== 1 || client.userId !== userId || client.native) return;
    try {
      if (client.delta && deltaMsg) {
        client.send(deltaMsg);
      } else {
        fullMsg ??= JSON.stringify(payloadFull);
        client.send(fullMsg);
      }
    } catch {}
  });
}

/* App iOS nhận dữ liệu đã chuyển sang định dạng của app. */
const nativeStateTimers = new Map();

function nativeStateMessage(userId) {
  const st = getStateForUser(userId);
  return { type: 'native_state', rev: st.rev, snapshot: toNativeSnapshot(st) };
}

function sendNativeStateNow(userId) {
  let msg = null;
  wss.clients.forEach((client) => {
    if (client.readyState !== 1 || client.userId !== userId || !client.native) return;
    try {
      msg ??= JSON.stringify(nativeStateMessage(userId));
      client.send(msg);
    } catch {}
  });
}

function scheduleNativeState(userId) {
  if (nativeStateTimers.has(userId)) return;
  nativeStateTimers.set(
    userId,
    setTimeout(
      safely('native state', () => {
        nativeStateTimers.delete(userId);
        sendNativeStateNow(userId);
      }),
      150
    )
  );
}

function broadcastClientCountForUser(userId) {
  const targetUid = userId;
  if (!targetUid) return;
  const count = countOnlineClientsForUser(targetUid);
  broadcastToUser(targetUid, {
    type: 'clients_count',
    clientsCount: count
  });
  broadcastAdminUsersUpdate();
}

/** Thay đổi dữ liệu của một tài khoản rồi báo cho mọi thiết bị của tài khoản đó. */
function mutateState(userId, action, clientId, excludeWs, fn) {
  const targetState = getStateForUser(userId);
  const beforeCols = snapCollections(targetState);
  const beforeScalars = snapScalars(targetState);
  const baseRev = targetState.rev;

  fn(targetState);

  targetState.rev = (targetState.rev || 1) + 1;
  targetState.updatedAt = Date.now();
  persistAllStates(userId);

  const delta = diffCollections(beforeCols, snapCollections(targetState));
  broadcastStateUpdate(
    userId,
    {
      type: 'state_sync',
      rev: targetState.rev,
      state: targetState,
      action,
      clientId
    },
    delta,
    { ...diffScalars(beforeScalars, targetState), rev: targetState.rev, updatedAt: targetState.updatedAt },
    baseRev,
    excludeWs
  );
  scheduleNativeState(userId);
  return targetState;
}

function trimCommentWindow(st) {
  st.comments.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  if (st.comments.length > COMMENT_WINDOW) st.comments.length = COMMENT_WINDOW;
}

/**
 * Bình luận do thiết bị gửi lên chỉ được thêm hoặc đánh dấu "đã in", không bao giờ xoá:
 * trước đây mỗi thiết bị ghi đè cả danh sách nên mất bình luận của nhau.
 */
function mergeIncomingComments(userId, st, incoming) {
  if (!Array.isArray(st.comments)) st.comments = [];
  const byId = new Map(st.comments.map((c) => [String(c.id), c]));
  let added = false;
  // Lần đồng bộ đầu của app có thể gửi hàng nghìn bình luận: ghi gộp một lần cho nhanh.
  sqlite.tx(db, () => {
    for (const c of incoming) {
      if (!c || c.id == null) continue;
      const id = String(c.id);
      const known = byId.get(id);
      if (known) {
        if (c.printed && !known.printed) {
          known.printed = true;
          sqlite.updateComment(db, userId, known);
        }
        continue;
      }
      if (sqlite.insertComment(db, userId, c)) {
        st.comments.push(c);
        byId.set(id, c);
        added = true;
      } else if (c.printed) {
        sqlite.markCommentPrinted(db, userId, id);
      }
    }
  });
  if (added) trimCommentWindow(st);
}

function markCommentsPrinted(userId, st, ids) {
  for (const id of ids) {
    const known = st.comments?.find((c) => String(c.id) === String(id));
    if (known) {
      if (!known.printed) {
        known.printed = true;
        sqlite.updateComment(db, userId, known);
      }
    } else {
      sqlite.markCommentPrinted(db, userId, String(id));
    }
  }
}

function applyIncomingStateForUser(userId, rawIncoming, action = 'update', clientId = '', excludeWs = null) {
  const incoming = cleanState(rawIncoming);
  const isClean = !isDefaultAdminUser(userId);
  const demoOrderIds = new Set(initialOrders.map((o) => o.id));
  const demoCustIds = new Set(initialCustomers.map((c) => c.id));
  const demoCommentIds = new Set(initialComments.map((c) => c.id));
  const demoAccIds = new Set((DEFAULT_SETTINGS.accounts || []).map((a) => a.id));

  return mutateState(userId, action, clientId, excludeWs, (targetState) => {
    if (Array.isArray(incoming.orders)) {
      targetState.orders = isClean ? incoming.orders.filter((o) => !demoOrderIds.has(o.id)) : incoming.orders;
    }
    if (Array.isArray(incoming.customers)) {
      targetState.customers = isClean ? incoming.customers.filter((c) => !demoCustIds.has(c.id)) : incoming.customers;
    }
    if (Array.isArray(incoming.comments)) {
      mergeIncomingComments(userId, targetState, isClean ? incoming.comments.filter((c) => !demoCommentIds.has(c?.id)) : incoming.comments);
    }
    // Phiên live do server ghi. Chỉ tài khoản demo mới có phiên mẫu từ thiết bị.
    if (Array.isArray(incoming.sessions) && !isClean) {
      targetState.sessions = incoming.sessions;
    }
    if (Array.isArray(incoming.accounts)) {
      targetState.accounts = isClean ? incoming.accounts.filter((a) => !demoAccIds.has(a.id)) : incoming.accounts;
    }
    if (Array.isArray(incoming.prints)) targetState.prints = incoming.prints.slice(0, 100);
    if (incoming.settings && typeof incoming.settings === 'object') {
      // Địa chỉ server là của riêng từng thiết bị, đồng bộ đi sẽ làm thiết bị khác nối nhầm server.
      const { serverUrl: _deviceOnly, ...settings } = incoming.settings;
      targetState.settings = { ...targetState.settings, ...settings };
      if (isClean && Array.isArray(targetState.settings.accounts)) {
        targetState.settings.accounts = targetState.accounts;
      }
    }
    if (incoming.salesMetrics && typeof incoming.salesMetrics === 'object') {
      targetState.salesMetrics = { ...targetState.salesMetrics, ...incoming.salesMetrics };
    }
    if (typeof incoming.seq === 'number') targetState.seq = Math.max(targetState.seq || 0, incoming.seq);
    if (typeof incoming.selectedCustomerUniqueId === 'string') {
      targetState.selectedCustomerUniqueId = incoming.selectedCustomerUniqueId;
    }
    if (typeof incoming.activeSessionId === 'string') {
      targetState.activeSessionId = incoming.activeSessionId;
    }
    targetState.isCleanAccount = isClean;
  });
}

/** Thay đổi từ app iOS: chỉ gồm những khách vừa đổi và các món đã xoá. */
function applyNativeUpdateForUser(userId, rawUpdate, excludeWs) {
  const update = cleanNativeUpdate(rawUpdate);
  return mutateState(userId, 'native_update', '', excludeWs, (st) => {
    applyNativeUpdate(st, update);
    if (Array.isArray(update.sessions)) mergeNativeSessions(st, update.sessions);
    if (Array.isArray(update.comments)) {
      const incoming = update.comments
        .filter((c) => c && c.id != null)
        .map((c) => toServerComment(st, { ...c, comment: c.text ?? c.comment ?? '' }));
      mergeIncomingComments(userId, st, incoming);
    }
    const printed = [];
    for (const c of update.customers || []) {
      for (const it of c?.items || []) {
        const id = it?.commentId || it?.id;
        if (id && it.printed) printed.push(id);
      }
    }
    if (Array.isArray(update.printedCommentIds)) printed.push(...update.printedCommentIds);
    markCommentsPrinted(userId, st, printed);
  });
}

/** Chuẩn hoá username: bỏ @, bỏ link */
function normalizeUsername(input = '') {
  const u = String(input).trim();
  // Link phiên live: lấy phần sau dấu @.
  const inLink = u.match(/@([\w.-]+)/);
  if (inLink) return inLink[1];
  const plain = u.match(/^[^/?#&\s]+$/);
  return plain ? plain[0] : '';
}

function slugify(str = '') {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mapChat(data, kind = 'chat') {
  const user = data.user || {};
  const displayId = (user.displayId || data.displayId || user.uniqueId || data.uniqueId || '').toString().trim();
  const userId = (user.idStr || user.userId || user.id || data.userId || '').toString().trim();
  const nickname = (user.nickname || data.nickname || displayId || '').toString().trim();

  const uniqueId =
    displayId ||
    (userId ? `user_${userId.slice(-6)}` : '') ||
    (nickname ? slugify(nickname) : '') ||
    `khach_${Math.random().toString(36).slice(2, 7)}`;

  const rawTs = Number(data.common?.createTime) || 0;
  const created = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
  // Đồng hồ TikTok lệch quá xa thì dùng giờ server.
  const ts = Math.abs(Date.now() - created) < 6 * 60 * 60 * 1000 ? created : Date.now();

  const text = data.comment || data.content || '';
  const isSticker = kind === 'emote' || (!text && (data.emotes?.length || data.emoteList?.length));
  const comment = text || (isSticker ? '[Sticker]' : '');

  // Có mã tin của TikTok thì nối lại không bị trùng; không có thì dựng mã ổn định từ nội dung.
  const msgId = data.common?.msgId || data.msgId;
  const id = String(
    msgId && String(msgId) !== '0'
      ? msgId
      : crypto.createHash('sha1').update(`${userId}|${uniqueId}|${comment}|${rawTs}`).digest('hex').slice(0, 24)
  );

  return { id, userId, uniqueId, nickname: nickname || uniqueId, comment, ts };
}

function priceOptionsOf(st) {
  const s = st.settings || {};
  return { multiplier: Number(s.multiplier) || 1000, minPrice: 1, maxPrice: Number(s.maxPrice) || 1e12 };
}

/** Đủ các trường web cần để hiện bình luận. */
function toServerComment(st, c) {
  const ts = Number(c.ts) || Date.now();
  const text = c.comment || '';
  const price = parsePrice(text, priceOptionsOf(st)) || 0;
  const info = extractProductInfo(text, price);
  return {
    id: String(c.id),
    uniqueId: c.uniqueId || '',
    userId: String(c.userId || ''),
    nickname: c.nickname || c.uniqueId || '',
    comment: text,
    price,
    productName: info.productName,
    qty: info.quantity || 1,
    time: timeOf(ts),
    ts,
    tag: price ? 'Mới' : '',
    sessionId: c.sessionId || '',
    live: c.live || '',
    ...(c.printed ? { printed: true } : {})
  };
}

function friendlyError(err) {
  const name = err?.constructor?.name || err?.name || '';
  const msg = String(err?.message || err || '');
  if (name.includes('UserOffline') || /offline|not live|isn't online/i.test(msg))
    return 'Tài khoản này hiện không livestream.';
  if (name.includes('RateLimit') || /rate ?limit|429/i.test(msg))
    return 'Máy chủ ký TikTok đang giới hạn lượt kết nối, thử lại sau ít phút.';
  if (/not found|user_not_found|19881007/i.test(msg)) return 'Không tìm thấy tài khoản TikTok này.';
  return 'Không kết nối được: ' + msg.slice(0, 160);
}

/* ============================================================
   Theo dõi TikTok Live (nhiều live cùng lúc cho mỗi tài khoản)
   Server tự lưu bình luận và phiên, thiết bị nào mất mạng cũng không mất dữ liệu.
   ============================================================ */
function openSessionFor(userId, entry) {
  const st = getStateForUser(userId);
  if (entry.sessionId && st.sessions?.some((s) => s.id === entry.sessionId)) return;
  const now = Date.now();
  const key = liveKey(entry.username);
  mutateState(userId, 'session_started', '', null, (state) => {
    if (!Array.isArray(state.sessions)) state.sessions = [];
    // Vừa dừng hoặc rớt hẳn rồi quay lại: nối tiếp phiên cũ thay vì tạo phiên mới.
    const recent = state.sessions.find(
      (s) => liveKey(s.tiktok) === key && (s.isLive || (s.endTs && now - s.endTs < SESSION_RESUME_MS))
    );
    if (recent) {
      recent.isLive = true;
      recent.endTs = null;
      recent.endStr = '';
      recent.duration = '';
      entry.sessionId = recent.id;
      return;
    }
    const session = {
      id: 's_' + now.toString(36) + crypto.randomBytes(2).toString('hex'),
      tiktok: entry.username,
      name: sessionName(now),
      startTs: now,
      endTs: null,
      isLive: true,
      timeStr: timeOf(now),
      endStr: '',
      duration: '',
      commentCount: 0,
      priceCount: 0,
      lastActivityTs: now
    };
    state.sessions.unshift(session);
    entry.sessionId = session.id;
  });
}

function closeSessionFor(userId, entry) {
  if (!entry.sessionId) return;
  mutateState(userId, 'session_ended', '', null, (state) => {
    const s = state.sessions?.find((x) => x.id === entry.sessionId);
    if (!s || !s.isLive) return;
    const now = Date.now();
    const last = s.lastActivityTs || s.startTs;
    // Server tắt lâu rồi mới chạy lại: lấy mốc hoạt động cuối thay vì lúc này.
    const end = now - last > 10 * 60 * 1000 ? last : now;
    s.isLive = false;
    s.endTs = end;
    s.endStr = timeOf(end);
    s.duration = durationText(s.startTs, end);
  });
}

function recordLiveComment(userId, entry, data, kind) {
  const mapped = mapChat(data, kind);
  if (!mapped.comment) return;
  const st = getStateForUser(userId);
  if (!st.sessions?.some((s) => s.id === entry.sessionId)) {
    // Lô bình luận đầu về trước khi kết nối xong, hoặc dữ liệu vừa bị đặt lại.
    entry.sessionId = '';
    openSessionFor(userId, entry);
  }
  const comment = toServerComment(st, { ...mapped, sessionId: entry.sessionId, live: entry.username });
  // Bảng có khoá chính nên nối lại nhận lại tin cũ cũng không bị trùng.
  if (!sqlite.insertComment(db, userId, comment)) return;

  if (!Array.isArray(st.comments)) st.comments = [];
  const at = st.comments.findIndex((c) => (Number(c.ts) || 0) <= comment.ts);
  if (at < 0) st.comments.push(comment);
  else st.comments.splice(at, 0, comment);
  if (st.comments.length > COMMENT_WINDOW) st.comments.length = COMMENT_WINDOW;

  const session = st.sessions.find((s) => s.id === entry.sessionId);
  if (session) {
    session.commentCount = (session.commentCount || 0) + 1;
    if (comment.price) session.priceCount = (session.priceCount || 0) + 1;
    session.lastActivityTs = Math.max(session.lastActivityTs || 0, comment.ts);
  }
  persistAllStates(userId);
  broadcastToUser(userId, { type: 'chat', ...comment });
}

function broadcastLives(userId) {
  broadcastToUser(userId, { type: 'lives', lives: liveManager.list(userId) });
}

const liveManager = new LiveManager({
  createConnection: (username) =>
    new TikTokLiveConnection(username, {
      // Lấy cả lô bình luận TikTok gửi kèm lúc kết nối, để nối lại vẫn vớt được phần vừa bị lỡ.
      processInitialData: true,
      fetchRoomInfoOnConnect: true,
      ...(SIGN_API_KEY ? { signApiKey: SIGN_API_KEY } : {})
    }),
  events: {
    chat: WebcastEvent.CHAT,
    emote: WebcastEvent.EMOTE,
    roomUser: WebcastEvent.ROOM_USER,
    streamEnd: WebcastEvent.STREAM_END,
    disconnected: ControlEvent.DISCONNECTED,
    error: ControlEvent.ERROR,
    rawData: 'decodedData'
  },
  friendlyError,
  log: (...args) => console.warn(...args),
  onComment: safely('live comment', recordLiveComment),
  onViewers: safely('live viewers', (userId, entry) => {
    broadcastToUser(userId, { type: 'viewers', username: entry.username, count: entry.viewers });
  }),
  onSessionNeeded: safely('live session', openSessionFor),
  onChange: safely('live change', (userId, entry) => {
    broadcastToUser(userId, {
      type: 'status',
      state: entry.state,
      username: entry.username,
      message: entry.message || '',
      roomId: entry.roomId || '',
      sessionId: entry.sessionId || ''
    });
    broadcastLives(userId);
    if (entry.state === 'connected') console.log(`[live] ${userId} theo dõi @${entry.username} room=${entry.roomId}`);
  }),
  onEnded: safely('live ended', (userId, entry, reason) => {
    closeSessionFor(userId, entry);
    broadcastToUser(userId, {
      type: 'status',
      state: reason === 'stopped' ? 'idle' : reason,
      username: entry.username,
      message: entry.message || '',
      sessionId: entry.sessionId || ''
    });
    broadcastLives(userId);
  })
});

function getLiveStatus(userId) {
  const first = userId ? liveManager.list(userId)[0] : null;
  return first ? { state: first.state, username: first.username, mode: 'real' } : { state: 'idle', username: '', mode: 'idle' };
}

/** Server khởi động lại giữa phiên: nối lại những live đang theo dõi. */
function resumeLivesAfterRestart() {
  let delay = 0;
  for (const [userId, st] of Object.entries(statesByUserId)) {
    const user = usersDb.users.find((u) => u.id === userId);
    for (const s of st.sessions || []) {
      if (!s.isLive || !s.tiktok || !s.startTs) continue;
      if (!user || user.locked) {
        s.isLive = false;
        s.endTs = s.lastActivityTs || s.startTs;
        s.endStr = timeOf(s.endTs);
        s.duration = durationText(s.startTs, s.endTs);
        persistAllStates(userId);
        continue;
      }
      setTimeout(
        safely('live resume', () => {
          console.log(`[live] nối lại @${s.tiktok} của ${userId} sau khi khởi động`);
          const entry = liveManager.start(userId, s.tiktok);
          if (entry) entry.sessionId = s.id;
        }),
        delay
      ).unref?.();
      delay += 1500;
    }
  }
}

wss.on('connection', safely('ws connection', (ws, req) => {
  // Đọc token từ query string nếu có
  let initialUser = null;
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const tk = urlObj.searchParams.get('token') || '';
    initialUser = getUserByToken(tk);
    if (initialUser) ws.token = tk;
  } catch {}

  ws.userId = initialUser?.id || null;
  ws.userRole = initialUser?.role || 'user';
  ws.native = false;
  try {
    ws.native = new URL(req.url, 'http://localhost').searchParams.get('native') === '1';
  } catch {}

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  if (initialUser && initialUser.locked) {
    send({
      type: 'account_locked',
      userId: initialUser.id,
      message: 'Tài khoản của bạn đã bị Quản trị viên khoá.'
    });
    ws.close();
    return;
  }

  if (initialUser) {
    const currentUserState = getStateForUser(ws.userId);
    send({
      type: 'hello',
      server: 'susu',
      version: 4,
      rev: currentUserState.rev,
      clientsCount: countOnlineClientsForUser(ws.userId),
      liveStatus: getLiveStatus(ws.userId),
      lives: liveManager.list(ws.userId),
      ...(ws.native ? { snapshot: toNativeSnapshot(currentUserState) } : { state: currentUserState }),
      user: sanitizeUser(initialUser)
    });
    broadcastClientCountForUser(ws.userId);
  } else {
    send({ type: 'hello', server: 'susu', version: 4, liveStatus: getLiveStatus(null), lives: [], user: null });
  }

  ws.on('message', safely('ws message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isObject(msg)) return;

    if (msg.type === 'auth' && msg.token) {
      const u = getUserByToken(msg.token);
      if (!u) {
        send({ type: 'auth_error', message: 'Phiên đăng nhập không hợp lệ.' });
        return;
      }
      if (u.locked) {
        send({ type: 'account_locked', userId: u.id, message: 'Tài khoản của bạn đã bị Quản trị viên khoá.' });
        return;
      }
      const prevUid = ws.userId;
      ws.userId = u.id;
      ws.token = String(msg.token).replace(/^Bearer\s+/i, '').trim();
      ws.userRole = u.role;
      ws.delta = msg.delta === true;
      const st = getStateForUser(u.id);
      send({
        type: 'hello',
        server: 'susu',
        version: 4,
        rev: st.rev,
        clientsCount: countOnlineClientsForUser(u.id),
        liveStatus: getLiveStatus(u.id),
        lives: liveManager.list(u.id),
        ...(ws.native ? { snapshot: toNativeSnapshot(st) } : { state: st }),
        user: sanitizeUser(u)
      });
      broadcastClientCountForUser(prevUid);
      broadcastClientCountForUser(u.id);
      return;
    }

    if (!ws.userId) {
      if (msg.type === 'ping') send({ type: 'pong' });
      else send({ type: 'auth_error', message: 'Cần đăng nhập.' });
      return;
    }

    // Phiên có thể đã hết hạn, bị đăng xuất hoặc tài khoản đã bị xoá trong lúc kết nối vẫn mở.
    const activeUser = getUserByToken(ws.token);
    if (!activeUser) {
      send({ type: 'auth_error', message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
      ws.close(4001, 'session revoked');
      return;
    }
    if (activeUser.locked) {
      send({
        type: 'account_locked',
        userId: activeUser.id,
        message: 'Tài khoản của bạn đã bị Quản trị viên khoá.'
      });
      ws.close(4001, 'account locked');
      return;
    }

    if (msg.type === 'native_update') {
      applyNativeUpdateForUser(ws.userId, msg, ws);
      send({ type: 'native_ack', id: msg.id ?? null, clientsCount: countOnlineClientsForUser(ws.userId) });
    } else if (msg.type === 'sync_update' && msg.state) {
      const updated = applyIncomingStateForUser(
        ws.userId,
        msg.state,
        msg.action || 'update',
        msg.clientId || '',
        ws
      );
      send({
        type: 'sync_ack',
        rev: updated.rev,
        clientsCount: countOnlineClientsForUser(ws.userId)
      });
    } else if (msg.type === 'ui_event') {
      const st = getStateForUser(ws.userId);
      if (msg.selectedCustomerUniqueId) {
        st.selectedCustomerUniqueId = msg.selectedCustomerUniqueId;
      }
      if (msg.activeSessionId) {
        st.activeSessionId = msg.activeSessionId;
      }
      broadcastToUser(
        ws.userId,
        {
          type: 'ui_event',
          ...msg
        },
        ws
      );
    } else if (msg.type === 'connect') {
      const u = normalizeUsername(msg.username);
      if (!u) return send({ type: 'status', state: 'error', message: 'Vui lòng nhập tên TikTok.' });
      const running = liveManager.list(ws.userId);
      if (!running.some((l) => liveKey(l.username) === liveKey(u)) && running.length >= MAX_LIVES_PER_USER) {
        return send({
          type: 'status',
          state: 'error',
          username: u,
          message: `Chỉ theo dõi tối đa ${MAX_LIVES_PER_USER} live cùng lúc.`
        });
      }
      liveManager.start(ws.userId, u);
      broadcastLives(ws.userId);
    } else if (msg.type === 'disconnect') {
      // Có tên thì chỉ dừng live đó; không có tên thì dừng tất cả (app bản cũ).
      const u = normalizeUsername(msg.username || '');
      liveManager.stop(ws.userId, u);
      if (!u) broadcastToUser(ws.userId, { type: 'status', state: 'idle' });
    } else if (msg.type === 'ping') {
      const st = getStateForUser(ws.userId);
      send({
        type: 'pong',
        rev: st.rev,
        clientsCount: countOnlineClientsForUser(ws.userId)
      });
    }
  }));

  ws.on('close', () => {
    setTimeout(safely('ws close', () => broadcastClientCountForUser(ws.userId)), 50);
  });
  ws.on('error', () => {
    setTimeout(safely('ws error', () => broadcastClientCountForUser(ws.userId)), 50);
  });
}, (ws) => ws.close(1011)));

setInterval(() => {
  wss.clients.forEach((c) => {
    try {
      c.ping();
    } catch {}
  });
}, 25000);

server.listen(PORT, HOST, () => {
  console.log(`Susu Live Order đang chạy: http://${HOST || 'localhost'}:${PORT}`);
  resumeLivesAfterRestart();
});
