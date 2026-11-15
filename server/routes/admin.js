/** API của Admin: xem, tạo, khoá, đổi mật khẩu, cấp gói và xoá tài khoản. */
import crypto from 'node:crypto';
import express from 'express';
import * as sqlite from '../../db.js';
import * as support from '../../support.js';
import { accessOf, extendedPlanEnd, TRIAL_MS, validPlanMonths } from '../../access.js';
import { db } from '../database.js';
import {
  flushUsersDb,
  hashPassword,
  newPasswordProblem,
  normalizeAccountName,
  persistUsersDb,
  revokeUserTokens,
  usernameProblem,
  usersDb
} from '../accounts.js';
import { forgetUserState, getStateForUser, persistAllStates } from '../states.js';
import { broadcastAdminUsersUpdate, broadcastToUser, kickUserSockets, sanitizeUser } from '../hub.js';
import { applyLiveAccess, liveManager } from '../live.js';
import { vtpStore } from '../vtp-stores.js';
import { requireAdmin } from '../middleware.js';

const router = express.Router();

/* ============================================================
   API QUẢN TRỊ VIÊN (ADMIN QUẢN LÝ TÀI KHOẢN: KHOÁ, ĐỔI PASS, TẠO, XOÁ)
   ============================================================ */

// Lấy danh sách toàn bộ tài khoản
router.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    users: usersDb.users.map(sanitizeUser)
  });
});

// Admin tạo tài khoản mới
router.post('/api/admin/users/create', requireAdmin, async (req, res) => {
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
    lastLoginAt: null,
    trialEndsAt: Date.now() + TRIAL_MS
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
router.post('/api/admin/users/:id/lock', requireAdmin, (req, res) => {
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
router.post('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
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

/** Tài khoản nhận gói phải là thành viên thường: admin vốn không bị giới hạn. Trả về null nếu đã báo lỗi. */
function findPlanTarget(req, res) {
  const target = usersDb.users.find((u) => u.id === req.params.id);
  if (!target) {
    res.status(404).json({ error: 'Không tìm thấy tài khoản này.' });
    return null;
  }
  if (target.role === 'admin') {
    res.status(400).json({ error: 'Tài khoản Admin không cần cấp gói.' });
    return null;
  }
  return target;
}

function finishPlanChange(res, target) {
  flushUsersDb();
  applyLiveAccess(target);
  broadcastToUser(target.id, { type: 'access', access: accessOf(target) });
  broadcastAdminUsersUpdate();
  res.json({
    ok: true,
    user: sanitizeUser(target),
    users: usersDb.users.map(sanitizeUser)
  });
}

// Admin cấp hoặc gia hạn gói (tính theo tháng) cho tài khoản thường
router.post('/api/admin/users/:id/plan', requireAdmin, (req, res) => {
  const target = findPlanTarget(req, res);
  if (!target) return;
  const { months } = req.body || {};
  if (!validPlanMonths(months)) {
    return res.status(400).json({ error: 'Số tháng của gói không hợp lệ.' });
  }
  target.planEndsAt = extendedPlanEnd(target.planEndsAt, months);
  finishPlanChange(res, target);
});

// Admin thu hồi gói: live đang chạy dừng ngay nếu tài khoản không còn hạn dùng thử
router.delete('/api/admin/users/:id/plan', requireAdmin, (req, res) => {
  const target = findPlanTarget(req, res);
  if (!target) return;
  delete target.planEndsAt;
  finishPlanChange(res, target);
});

// Admin Xoá tài khoản
router.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
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
  forgetUserState(targetId);
  // Bỏ luôn token Viettel Post: để lại thì webhook cũ còn gọi về sẽ dựng lại dữ liệu cho tài khoản đã xoá.
  vtpStore.remove(targetId);
  try {
    sqlite.deleteUserData(db, targetId);
    support.deleteUserSupport(db, targetId);
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

export default router;
