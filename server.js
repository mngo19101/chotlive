/**
 * Susu Live Order / ChốtLive – Server, Auth, Admin & Real-Time Sync Hub (Web <-> iOS IPA App)
 * - Hệ thống Đăng nhập / Đăng ký (Chỉ cần Tên tài khoản + Mật khẩu + Xác nhận mật khẩu)
 * - Phân quyền:
 *   + Tài khoản Admin riêng (mặc định: admin / admin123) quản lý toàn bộ tài khoản:
 *     Xem danh sách, Tạo mới, Khoá / Mở khoá tài khoản (đẩy văng tức thì nếu đang online), Đổi mật khẩu, Xoá tài khoản.
 *   + Tài khoản Thành viên (user): sử dụng đầy đủ tính năng chốt đơn, in tem, đồng bộ Web <-> App IPA.
 * - Lưu trữ và đồng bộ dữ liệu thời gian thực theo từng tài khoản qua WebSocket (/ws) + REST API.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;
const TOKEN_TTL_MS = (Number(process.env.TOKEN_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STATES_FILE = path.join(DATA_DIR, 'sync-states-by-user.json');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

const db = sqlite.openDb(path.join(DATA_DIR, 'susu.db'));

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
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

function normalizeAccountName(name = '') {
  return String(name).trim().toLowerCase();
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
    passwordHash: hashPassword(getInitialAdminPassword()),
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
    passwordHash: hashPassword(getInitialAdminPassword()),
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
    for (const [uid, st] of Object.entries(fromDb)) savedSnaps[uid] = snapCollections(st);
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
    statesByUserId[key] = createEmptyUserState(u?.displayName || u?.username || 'Shop mới');
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
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(flushStates, 150);
}

function flushStates() {
  clearTimeout(saveStateTimer);
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
  flushStates();
  flushUsersDb();
  process.exit(0);
}
process.on('SIGTERM', flushAllAndExit);
process.on('SIGINT', flushAllAndExit);

/* ============================================================
   Express Server & Middleware
   ============================================================ */
const app = express();

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

// 1. Đăng nhập
app.post('/api/auth/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const cleanName = normalizeAccountName(username);
  if (!cleanName || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tên tài khoản và mật khẩu.' });
  }

  const user = usersDb.users.find((u) => normalizeAccountName(u.username) === cleanName);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Tên tài khoản hoặc mật khẩu không chính xác.' });
  }

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
app.post('/api/auth/register', (req, res) => {
  const { username = '', password = '', confirmPassword = '' } = req.body || {};
  const rawName = String(username).trim();
  const cleanName = normalizeAccountName(rawName);

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ error: 'Tên tài khoản phải có ít nhất 2 ký tự.' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 4 ký tự.' });
  }
  if (String(password) !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Mật khẩu xác nhận không khớp.' });
  }

  const exists = usersDb.users.some((u) => normalizeAccountName(u.username) === cleanName);
  if (exists) {
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại, vui lòng chọn tên khác.' });
  }

  const newUser = {
    id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username: cleanName,
    displayName: rawName,
    passwordHash: hashPassword(password),
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
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword = '', newPassword = '', confirmPassword = '' } = req.body || {};
  if (!verifyPassword(currentPassword, req.user.passwordHash)) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'Mật khẩu mới phải từ 4 ký tự trở lên.' });
  }
  if (String(newPassword) !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Xác nhận mật khẩu mới không khớp.' });
  }

  req.user.passwordHash = hashPassword(newPassword);
  revokeUserTokens(req.user.id, req.token);
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
app.post('/api/admin/users/create', requireAdmin, (req, res) => {
  const { username = '', password = '', confirmPassword = '', role = 'user' } = req.body || {};
  const rawName = String(username).trim();
  const cleanName = normalizeAccountName(rawName);

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ error: 'Tên tài khoản phải có ít nhất 2 ký tự.' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 4 ký tự.' });
  }
  if (String(password) !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Mật khẩu xác nhận không khớp.' });
  }
  if (usersDb.users.some((u) => normalizeAccountName(u.username) === cleanName)) {
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại.' });
  }

  const newUser = {
    id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username: cleanName,
    displayName: rawName,
    passwordHash: hashPassword(password),
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
    revokeUserTokens(target.id);
    // Đẩy thông báo khoá tài khoản tức thì tới mọi thiết bị của user đó đang mở
    broadcastToUser(target.id, {
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
app.post('/api/admin/users/:id/password', requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const { newPassword = '', confirmPassword = '' } = req.body || {};
  const target = usersDb.users.find((u) => u.id === targetId);
  if (!target) {
    return res.status(404).json({ error: 'Không tìm thấy tài khoản này.' });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'Mật khẩu mới phải từ 4 ký tự trở lên.' });
  }
  if (confirmPassword !== undefined && String(newPassword) !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Xác nhận mật khẩu mới không khớp.' });
  }

  target.passwordHash = hashPassword(newPassword);
  if (target.id !== req.user.id) {
    revokeUserTokens(target.id);
    broadcastToUser(target.id, {
      type: 'password_changed_force_login',
      userId: target.id,
      message: 'Mật khẩu tài khoản đã được Quản trị viên thay đổi. Vui lòng đăng nhập lại.'
    });
  } else {
    revokeUserTokens(target.id, req.token);
  }
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

  revokeUserTokens(target.id);
  broadcastToUser(target.id, {
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
    liveStatus: {
      state: activeLiveStatus.state,
      username: activeLiveStatus.username,
      mode: activeLiveStatus.mode
    },
    state: userState
  });
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

app.post('/api/print-lan', (req, res) => {
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
const wss = new WebSocketServer({ server, path: '/ws' });

function countOnlineClientsForUser(userId) {
  let cnt = 0;
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c.userId && c.userId === userId) {
      cnt++;
    }
  });
  return cnt;
}

function broadcastAll(payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === 1) {
      try {
        client.send(msg);
      } catch {}
    }
  });
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
  const fullMsg = JSON.stringify(payloadFull);
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
    if (client === excludeWs || client.readyState !== 1 || client.userId !== userId) return;
    try {
      client.send(client.delta && deltaMsg ? deltaMsg : fullMsg);
    } catch {}
  });
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

function applyIncomingStateForUser(userId, incoming, action = 'update', clientId = '', excludeWs = null) {
  const targetState = getStateForUser(userId);
  const beforeCols = snapCollections(targetState);
  const beforeScalars = snapScalars(targetState);
  const baseRev = targetState.rev;
  const isClean = !isDefaultAdminUser(userId);
  const demoOrderIds = new Set(initialOrders.map((o) => o.id));
  const demoCustIds = new Set(initialCustomers.map((c) => c.id));
  const demoCommentIds = new Set(initialComments.map((c) => c.id));
  const demoSessionIds = new Set(initialSessions.map((s) => s.id));
  const demoAccIds = new Set((DEFAULT_SETTINGS.accounts || []).map((a) => a.id));

  if (Array.isArray(incoming.orders)) {
    targetState.orders = isClean ? incoming.orders.filter((o) => !demoOrderIds.has(o.id)) : incoming.orders;
  }
  if (Array.isArray(incoming.customers)) {
    targetState.customers = isClean ? incoming.customers.filter((c) => !demoCustIds.has(c.id)) : incoming.customers;
  }
  if (Array.isArray(incoming.comments)) {
    const cmts = isClean ? incoming.comments.filter((c) => !demoCommentIds.has(c.id)) : incoming.comments;
    targetState.comments = cmts.slice(0, 100);
  }
  if (Array.isArray(incoming.sessions)) {
    targetState.sessions = isClean ? incoming.sessions.filter((s) => !demoSessionIds.has(s.id)) : incoming.sessions;
  }
  if (Array.isArray(incoming.accounts)) {
    targetState.accounts = isClean ? incoming.accounts.filter((a) => !demoAccIds.has(a.id)) : incoming.accounts;
  }
  if (Array.isArray(incoming.prints)) targetState.prints = incoming.prints.slice(0, 100);
  if (incoming.settings && typeof incoming.settings === 'object') {
    targetState.settings = { ...targetState.settings, ...incoming.settings };
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

  return targetState;
}

/** Chuẩn hoá username: bỏ @, bỏ link */
function normalizeUsername(input = '') {
  let u = String(input).trim();
  const m = u.match(/(?:tiktok\.com\/)?@?([^/?#&]+)/i);
  if (m) u = m[1];
  return u.replace(/^@/, '').trim();
}

function slugify(str = '') {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mapChat(data) {
  const user = data.user || {};
  const pic = user.profilePicture || user.avatarThumb || user.avatarMedium || user.avatarLarge || {};
  const avatar =
    (Array.isArray(pic.url) && pic.url[0]) ||
    (Array.isArray(pic.urlList) && pic.urlList[0]) ||
    data.profilePictureUrl ||
    '';

  const displayId = (user.displayId || data.displayId || user.uniqueId || data.uniqueId || '').toString().trim();
  const userId = (user.idStr || user.id || data.userId || '').toString().trim();
  const nickname = (user.nickname || data.nickname || displayId || '').toString().trim();

  const uniqueId =
    displayId ||
    (userId ? `user_${userId.slice(-6)}` : '') ||
    (nickname ? slugify(nickname) : '') ||
    `khach_${Math.random().toString(36).slice(2, 7)}`;
  const secUid = (user.secUid || '').toString();

  return {
    id: String(data.common?.msgId || data.msgId || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    userId: userId || '',
    secUid,
    uniqueId,
    nickname: nickname || uniqueId,
    avatar,
    profileUrl: `https://www.tiktok.com/@${uniqueId}`,
    comment: data.comment || data.content || '',
    ts: Date.now()
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

let sharedLiveConn = null;
const activeLiveStatus = {
  state: 'idle',
  username: 'shophoahong.live',
  mode: 'idle'
};

function stopSharedLive() {
  if (sharedLiveConn) {
    try {
      sharedLiveConn.removeAllListeners?.();
      sharedLiveConn.disconnect();
    } catch {}
    sharedLiveConn = null;
  }
  activeLiveStatus.state = 'idle';
  activeLiveStatus.mode = 'idle';
}

async function startSharedRealLive(username) {
  stopSharedLive();
  activeLiveStatus.username = username;
  activeLiveStatus.state = 'connecting';
  activeLiveStatus.mode = 'real';

  broadcastAll({
    type: 'status',
    state: 'connecting',
    username
  });

  const conn = new TikTokLiveConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    ...(SIGN_API_KEY ? { signApiKey: SIGN_API_KEY } : {})
  });
  sharedLiveConn = conn;

  conn.on(WebcastEvent.CHAT, (data) => {
    if (sharedLiveConn !== conn) return;
    const chatObj = mapChat(data);
    broadcastAll({ type: 'chat', ...chatObj });
  });

  conn.on(WebcastEvent.ROOM_USER, (data) => {
    if (sharedLiveConn !== conn) return;
    broadcastAll({ type: 'viewers', count: Number(data.viewerCount ?? data.totalUser ?? 0) });
  });

  conn.on(WebcastEvent.STREAM_END, () => {
    if (sharedLiveConn !== conn) return;
    broadcastAll({ type: 'status', state: 'ended', username, message: 'Phiên live đã kết thúc.' });
    stopSharedLive();
  });

  conn.on(ControlEvent.DISCONNECTED, () => {
    if (sharedLiveConn !== conn) return;
    broadcastAll({ type: 'status', state: 'disconnected', username, message: 'Mất kết nối với TikTok.' });
  });

  conn.on(ControlEvent.ERROR, (err) => {
    console.warn('[live error]', username, err?.message || err);
  });

  try {
    const state = await conn.connect();
    if (sharedLiveConn !== conn) return;
    activeLiveStatus.state = 'connected';
    broadcastAll({
      type: 'status',
      state: 'connected',
      username,
      roomId: state?.roomId || ''
    });
    console.log(`[live] connected @${username} room=${state?.roomId}`);
  } catch (err) {
    if (sharedLiveConn !== conn) return;
    console.warn('[live] connect failed', username, err?.message || err);
    broadcastAll({
      type: 'status',
      state: 'error',
      username,
      message: friendlyError(err)
    });
    stopSharedLive();
  }
}

wss.on('connection', (ws, req) => {
  // Đọc token từ query string nếu có
  let initialUser = null;
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const tk = urlObj.searchParams.get('token') || '';
    initialUser = getUserByToken(tk);
  } catch {}

  ws.userId = initialUser?.id || null;
  ws.userRole = initialUser?.role || 'user';

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
      version: 3,
      rev: currentUserState.rev,
      clientsCount: countOnlineClientsForUser(ws.userId),
      liveStatus: activeLiveStatus,
      state: currentUserState,
      user: sanitizeUser(initialUser)
    });
    broadcastClientCountForUser(ws.userId);
  } else {
    send({ type: 'hello', server: 'susu', version: 3, liveStatus: activeLiveStatus, user: null });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

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
      ws.userRole = u.role;
      ws.delta = msg.delta === true;
      const st = getStateForUser(u.id);
      send({
        type: 'hello',
        server: 'susu',
        version: 3,
        rev: st.rev,
        clientsCount: countOnlineClientsForUser(u.id),
        liveStatus: activeLiveStatus,
        state: st,
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

    // Kiểm tra nếu tài khoản bị khoá giữa chừng
    const activeUser = usersDb.users.find((u) => u.id === ws.userId);
    if (activeUser && activeUser.locked) {
      send({
        type: 'account_locked',
        userId: activeUser.id,
        message: 'Tài khoản của bạn đã bị Quản trị viên khoá.'
      });
      return;
    }

    if (msg.type === 'sync_update' && msg.state) {
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
      startSharedRealLive(u);
    } else if (msg.type === 'disconnect') {
      stopSharedLive();
      broadcastAll({ type: 'status', state: 'idle' });
    } else if (msg.type === 'ping') {
      const st = getStateForUser(ws.userId);
      send({
        type: 'pong',
        rev: st.rev,
        clientsCount: countOnlineClientsForUser(ws.userId)
      });
    }
  });

  ws.on('close', () => {
    setTimeout(() => broadcastClientCountForUser(ws.userId), 50);
  });
  ws.on('error', () => {
    setTimeout(() => broadcastClientCountForUser(ws.userId), 50);
  });
});

setInterval(() => {
  wss.clients.forEach((c) => {
    try {
      c.ping();
    } catch {}
  });
}, 25000);

server.listen(PORT, () => {
  console.log(`Susu Live Order đang chạy: http://localhost:${PORT}`);
});
