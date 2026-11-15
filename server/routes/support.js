/** API chat hỗ trợ giữa khách và Admin, kèm cầu nối Telegram. */
import express from 'express';
import * as support from '../../support.js';
import { createLimiter } from '../../rate-limit.js';
import { createTelegramBridge } from '../../telegram.js';
import { db } from '../database.js';
import { usernameOf } from '../accounts.js';
import { broadcastToAdmins, broadcastToUser } from '../hub.js';
import { requireAdmin, requireAuth } from '../middleware.js';

const router = express.Router();

/* ============================================================
   CHAT HỖ TRỢ (khách <-> Admin): phiên đóng sau 24 giờ, giữ tin 30 ngày
   ============================================================ */
const supportPostLimiter = createLimiter({ max: 30, windowMs: 60 * 1000 });
setInterval(() => supportPostLimiter.sweep(), 10 * 60 * 1000).unref();

function pushSupportMessage(userId, result) {
  const { message, session } = result;
  broadcastToUser(userId, {
    type: 'support_message',
    message,
    session,
    unread: support.unreadCount(db, userId, 'user')
  });
  broadcastToAdmins({
    type: 'support_message',
    message,
    session,
    username: usernameOf(userId),
    unread: support.unreadCount(db, userId, 'admin', { forAllUsers: true })
  });
}

// Bot Telegram: tin của khách báo về Admin, Admin bấm Trả lời trên Telegram thì chuyển đúng khách.
export const telegram = createTelegramBridge({
  token: process.env.TELEGRAM_BOT_TOKEN,
  adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID,
  db,
  onReply: async ({ userId, sessionId, text }) => {
    const result = support.postMessage(db, { userId, sender: 'admin', text, sessionId });
    if (!result) return { ok: false, error: 'phiên đã đóng (khách chưa nhắn lại sau 24 giờ).' };
    pushSupportMessage(userId, result);
    return { ok: true };
  }
});

router.get('/api/support/sessions', requireAuth, (req, res) => {
  let sessions = support.listSessions(db, req.user.id);
  if (req.query.full) sessions = sessions.map((s) => ({ ...s, messages: support.listMessages(db, s.id) }));
  res.json({ ok: true, sessions, unread: support.unreadCount(db, req.user.id, 'user') });
});

// Không truyền sessionId thì lấy phiên mới nhất.
router.get('/api/support/messages', requireAuth, (req, res) => {
  const id = String(req.query.sessionId || '');
  const session = id ? support.getSession(db, id) : support.latestSession(db, req.user.id);
  if (!session || session.userId !== req.user.id) return res.json({ ok: true, session: null, messages: [] });
  res.json({ ok: true, session, messages: support.listMessages(db, session.id) });
});

router.post('/api/support/messages', requireAuth, (req, res) => {
  const wait = supportPostLimiter.retryAfter(req.user.id);
  if (wait > 0) return res.status(429).json({ error: 'Bạn nhắn quá nhanh, vui lòng thử lại sau ít phút.' });
  supportPostLimiter.hit(req.user.id);
  const result = support.postMessage(db, { userId: req.user.id, sender: 'user', text: req.body?.text });
  if (!result) return res.status(400).json({ error: 'Vui lòng nhập nội dung tin nhắn.' });
  pushSupportMessage(req.user.id, result);
  telegram?.notifyUserMessage({ userId: req.user.id, username: usernameOf(req.user.id), ...result });
  res.json({ ok: true, ...result });
});

router.post('/api/support/end', requireAuth, (req, res) => {
  res.json({ ok: true, ended: support.endSession(db, req.user.id) });
});

router.post('/api/support/read', requireAuth, (req, res) => {
  support.markRead(db, req.user.id, 'user');
  res.json({ ok: true, unread: 0 });
});

router.get('/api/admin/support/sessions', requireAdmin, (_req, res) => {
  const sessions = support.listSessionsForAdmin(db).map((s) => ({ ...s, username: usernameOf(s.userId) }));
  res.json({ ok: true, sessions, unread: support.unreadCount(db, '', 'admin', { forAllUsers: true }) });
});

// Lịch sử các phiên của một khách (kèm tin nhắn), mới nhất trước.
router.get('/api/admin/support/history', requireAdmin, (req, res) => {
  const userId = String(req.query.userId || '');
  const sessions = support.listSessions(db, userId).map((s) => ({ ...s, messages: support.listMessages(db, s.id) }));
  res.json({ ok: true, username: usernameOf(userId), sessions });
});

router.post('/api/admin/support/reply', requireAdmin, (req, res) => {
  const session = support.getSession(db, String(req.body?.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên chat này.' });
  const result = support.postMessage(db, {
    userId: session.userId,
    sender: 'admin',
    text: req.body?.text,
    sessionId: session.id
  });
  if (!result) {
    return res.status(400).json({ error: session.open ? 'Vui lòng nhập nội dung tin nhắn.' : 'Phiên chat đã đóng (quá 24 giờ).' });
  }
  pushSupportMessage(session.userId, result);
  res.json({ ok: true, ...result });
});

router.post('/api/admin/support/read', requireAdmin, (req, res) => {
  support.markRead(db, String(req.body?.userId || ''), 'admin');
  res.json({ ok: true, unread: support.unreadCount(db, '', 'admin', { forAllUsers: true }) });
});

export default router;
