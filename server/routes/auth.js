/** API đăng nhập, đăng ký, đổi mật khẩu, đăng xuất. */
import crypto from 'node:crypto';
import express from 'express';
import * as sqlite from '../../db.js';
import { createLimiter, waitMessage } from '../../rate-limit.js';
import { IP_LIMIT_MESSAGE, ipKey, MAX_ACCOUNTS_PER_IP, TRIAL_MS } from '../../access.js';
import { db } from '../database.js';
import {
  createSessionToken,
  hashPassword,
  newPasswordProblem,
  normalizeAccountName,
  persistUsersDb,
  revokeUserTokens,
  usernameProblem,
  usersDb,
  verifyPassword
} from '../accounts.js';
import { getStateForUser, persistAllStates } from '../states.js';
import { broadcastAdminUsersUpdate, kickUserSockets, sanitizeUser } from '../hub.js';
import { extractToken, requireAuth } from '../middleware.js';

const router = express.Router();

// Nhiều shop có thể chung một IP (mạng di động), nên giới hạn theo IP phải rộng hơn theo từng tài khoản.
const loginFailuresByAccount = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const loginFailuresByIp = createLimiter({ max: 100, windowMs: 15 * 60 * 1000 });

setInterval(() => {
  loginFailuresByAccount.sweep();
  loginFailuresByIp.sweep();
}, 10 * 60 * 1000).unref();

// 1. Đăng nhập
router.post('/api/auth/login', async (req, res) => {
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
router.post('/api/auth/register', async (req, res) => {
  const { username = '', password = '', confirmPassword = '' } = req.body || {};
  const rawName = String(username).trim();
  const cleanName = normalizeAccountName(rawName);

  const problem = usernameProblem(rawName) || newPasswordProblem(password, confirmPassword);
  if (problem) return res.status(400).json({ error: problem });

  const nameTaken = () => usersDb.users.some((u) => normalizeAccountName(u.username) === cleanName);
  if (nameTaken()) {
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại, vui lòng chọn tên khác.' });
  }

  // Đếm và giữ chỗ không qua await: nhiều yêu cầu cùng lúc từ một IP không lọt quá giới hạn.
  const ip = ipKey(req.ip);
  if (sqlite.countIpRegistrations(db, ip) >= MAX_ACCOUNTS_PER_IP) {
    return res.status(403).json({ error: IP_LIMIT_MESSAGE, code: 'IP_ACCOUNT_LIMIT' });
  }
  const userId = 'u_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  sqlite.addIpRegistration(db, ip, userId, Date.now());

  let passwordHash;
  try {
    passwordHash = await hashPassword(password);
  } catch (err) {
    sqlite.removeIpRegistration(db, ip, userId);
    throw err;
  }
  // Hai người cùng đăng ký một tên: trong lúc chờ mã hoá mật khẩu, người kia có thể đã tạo xong.
  if (nameTaken()) {
    sqlite.removeIpRegistration(db, ip, userId);
    return res.status(409).json({ error: 'Tên tài khoản này đã tồn tại, vui lòng chọn tên khác.' });
  }

  const newUser = {
    id: userId,
    username: cleanName,
    displayName: rawName,
    passwordHash,
    role: 'user',
    locked: false,
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
    trialEndsAt: Date.now() + TRIAL_MS
  };

  usersDb.users.push(newUser);
  getStateForUser(newUser.id);
  persistAllStates(newUser.id);

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
router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    ok: true,
    user: sanitizeUser(req.user)
  });
});

// 4. Tự đổi mật khẩu cá nhân
router.post('/api/auth/change-password', requireAuth, async (req, res) => {
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
router.post('/api/auth/logout', (req, res) => {
  const token = extractToken(req);
  if (token && usersDb.tokens[token]) {
    delete usersDb.tokens[token];
    persistUsersDb();
  }
  res.json({ ok: true });
});

export default router;
