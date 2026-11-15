/**
 * Trung tâm WebSocket: gửi tin tới các thiết bị đang nối và thay đổi dữ liệu của tài khoản
 * (mutateState) rồi báo cho mọi thiết bị của tài khoản đó.
 */
import { WebSocketServer } from 'ws';
import { snapCollections, diffCollections, snapScalars, diffScalars } from '../delta.js';
import { MAX_STATE_BYTES, restoreState, stateBytes } from '../limits.js';
import { accessOf } from '../access.js';
import { toNativeSnapshot } from '../native-sync.js';
import { MAX_WS_MESSAGE_BYTES } from './config.js';
import { server } from './app.js';
import { usersDb } from './accounts.js';
import { getStateForUser, persistAllStates } from './states.js';
import { safely } from './util.js';

export const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_MESSAGE_BYTES });

export function sanitizeUser(u) {
  return {
    id: u.id,
    username: u.displayName || u.username,
    role: u.role || 'user',
    locked: Boolean(u.locked),
    createdAt: u.createdAt || Date.now(),
    lastLoginAt: u.lastLoginAt || null,
    onlineCount: countOnlineClientsForUser(u.id),
    access: accessOf(u)
  };
}

/**
 * Báo rồi ngắt các thiết bị đang nối của một tài khoản (trừ thiết bị đang dùng exceptToken):
 * token đã thu hồi thì kết nối đang mở cũng không được tiếp tục nhận dữ liệu.
 */
export function kickUserSockets(userId, payload, exceptToken = null) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.userId !== userId || (exceptToken && client.token === exceptToken)) return;
    try {
      if (client.readyState === 1) client.send(msg);
      client.close(4001, 'session revoked');
    } catch {}
  });
}

export function countOnlineClientsForUser(userId) {
  let cnt = 0;
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c.userId && c.userId === userId) {
      cnt++;
    }
  });
  return cnt;
}

export function broadcastToUser(userId, payload, excludeWs = null) {
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

export function broadcastAdminUsersUpdate() {
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

export function broadcastClientCountForUser(userId) {
  const targetUid = userId;
  if (!targetUid) return;
  const count = countOnlineClientsForUser(targetUid);
  broadcastToUser(targetUid, {
    type: 'clients_count',
    clientsCount: count
  });
  broadcastAdminUsersUpdate();
}

/**
 * Thay đổi dữ liệu của một tài khoản rồi báo cho mọi thiết bị của tài khoản đó.
 * `fromDevice`: dữ liệu do thiết bị gửi lên. Nếu làm dữ liệu vượt MAX_STATE_BYTES thì trả lại như cũ
 * và trả về null. Thay đổi làm dữ liệu nhỏ đi vẫn được nhận, để tài khoản đã quá lớn còn dọn bớt được.
 * Bình luận trong gói đã được ghi vào bảng bình luận ngay trong `fn`, nên không bị mất khi trả lại.
 */
export function mutateState(userId, action, clientId, excludeWs, fn, { fromDevice = false } = {}) {
  const targetState = getStateForUser(userId);
  const beforeCols = snapCollections(targetState);
  const beforeScalars = snapScalars(targetState);
  const baseRev = targetState.rev;

  fn(targetState);

  const afterCols = snapCollections(targetState);
  if (fromDevice) {
    const after = stateBytes(afterCols, snapScalars(targetState));
    if (after > MAX_STATE_BYTES && after > stateBytes(beforeCols, beforeScalars)) {
      restoreState(targetState, beforeCols, beforeScalars);
      console.warn(`[sync] ${userId}: từ chối thay đổi làm dữ liệu lên ${Math.round(after / 1024 / 1024)}MB`);
      return null;
    }
  }

  targetState.rev = (targetState.rev || 1) + 1;
  targetState.updatedAt = Date.now();
  persistAllStates(userId);

  const delta = diffCollections(beforeCols, afterCols);
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

export function broadcastToAdmins(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.userRole === 'admin') {
      try {
        client.send(msg);
      } catch {}
    }
  });
}
