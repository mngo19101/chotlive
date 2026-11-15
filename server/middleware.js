/** Đọc body JSON và kiểm tra đăng nhập cho các route. */
import express from 'express';
import { SMALL_JSON_LIMIT, SYNC_JSON_LIMIT } from '../limits.js';
import { getUserByToken } from './accounts.js';

// Gói lớn chỉ nhận ở API đồng bộ và in LAN, và chỉ sau khi đã kiểm tra token (xem từng route).
// Các API khác, nhất là đăng nhập/đăng ký ai cũng gọi được, không phải đọc gói 10MB của người lạ.
export const syncJson = express.json({ limit: SYNC_JSON_LIMIT });
const smallJson = express.json({ limit: SMALL_JSON_LIMIT });
const BIG_BODY_PATHS = new Set(['/api/sync', '/api/print-lan']);

export const smallJsonExceptBigPaths = (req, res, next) => (BIG_BODY_PATHS.has(req.path) ? next() : smallJson(req, res, next));

export function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  return req.query?.token || req.body?.token || '';
}

export function requireAuth(req, res, next) {
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

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Chỉ tài khoản Admin mới có quyền thực hiện thao tác này.' });
    }
    next();
  });
}
