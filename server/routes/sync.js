/** API đồng bộ dữ liệu giữa web và app: lấy dữ liệu, lịch sử bình luận, gửi thay đổi, đặt lại. */
import express from 'express';
import * as sqlite from '../../db.js';
import { SYNC_TOO_FAST_MESSAGE } from '../../limits.js';
import { nativeComment } from '../../native-sync.js';
import { db } from '../database.js';
import { isDefaultAdminUser } from '../accounts.js';
import {
  createDefaultSharedState,
  createEmptyUserState,
  getStateForUser,
  persistAllStates,
  statesByUserId
} from '../states.js';
import { broadcastToUser, countOnlineClientsForUser } from '../hub.js';
import { applyIncomingStateForUser, saveDeviceCommentsOnly, syncAllowed } from '../device-sync.js';
import { getLiveStatus, liveManager } from '../live.js';
import { requireAuth, syncJson } from '../middleware.js';

const router = express.Router();

/* ============================================================
   API ĐỒNG BỘ DỮ LIỆU GIỮA WEB & APP IPA
   ============================================================ */
router.get('/api/state', requireAuth, (req, res) => {
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
router.get('/api/comments', requireAuth, (req, res) => {
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

router.post('/api/sync', requireAuth, syncJson, (req, res) => {
  const userId = req.user.id;
  const { state: incoming, action = 'update', clientId = '' } = req.body || {};
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'Dữ liệu đồng bộ không hợp lệ' });
  }
  const bytes = Number(req.headers['content-length']) || JSON.stringify(req.body).length;
  if (!syncAllowed(userId, bytes)) {
    saveDeviceCommentsOnly(userId, { type: 'sync_update', state: incoming });
    return res.status(429).json({ error: SYNC_TOO_FAST_MESSAGE, code: 'SYNC_TOO_FAST' });
  }
  const updated = applyIncomingStateForUser(userId, incoming, action, clientId);
  res.json({
    ok: true,
    rev: updated.rev,
    clientsCount: countOnlineClientsForUser(userId)
  });
});

router.post('/api/reset', requireAuth, (req, res) => {
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

export default router;
