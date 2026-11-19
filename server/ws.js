/** Xử lý từng kết nối WebSocket: đăng nhập, đồng bộ, bật và tắt theo dõi live. */
import { isObject } from '../validate.js';
import { MAX_UNAUTHENTICATED_WS_BYTES, SYNC_TOO_FAST_MESSAGE } from '../limits.js';
import { accessOf } from '../access.js';
import { toNativeSnapshot } from '../native-sync.js';
import { liveKey } from '../live-manager.js';
import { MAX_LIVES_PER_USER } from './config.js';
import { getUserByToken } from './accounts.js';
import { getStateForUser } from './states.js';
import { broadcastClientCountForUser, broadcastToUser, countOnlineClientsForUser, sanitizeUser, wss } from './hub.js';
import { applyIncomingStateForUser, applyNativeUpdateForUser, saveDeviceCommentsOnly, syncAllowed } from './device-sync.js';
import { broadcastLives, getLiveStatus, liveManager, normalizeUsername } from './live.js';
import { safely } from './util.js';

const onConnection = safely('ws connection', (ws, req) => {
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
    if (!ws.userId && raw.length > MAX_UNAUTHENTICATED_WS_BYTES) {
      ws.close(1009, 'login first');
      return;
    }
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

    const isSync = msg.type === 'native_update' || (msg.type === 'sync_update' && msg.state);
    if (isSync && !syncAllowed(ws.userId, raw.length)) {
      saveDeviceCommentsOnly(ws.userId, msg);
      send({ type: 'sync_error', code: 'SYNC_TOO_FAST', id: msg.id ?? null, message: SYNC_TOO_FAST_MESSAGE });
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
      if (msg.selectedCustomerUniqueId && typeof msg.selectedCustomerUniqueId === 'string') {
        st.selectedCustomerUniqueId = msg.selectedCustomerUniqueId.slice(0, 200);
      }
      if (msg.activeSessionId && typeof msg.activeSessionId === 'string') {
        st.activeSessionId = msg.activeSessionId.slice(0, 200);
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
      const access = accessOf(activeUser);
      if (!access.canFollowLive) {
        send({ type: 'access', access });
        return send({ type: 'status', state: 'error', username: u, code: access.code, message: access.message });
      }
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
}, (ws) => ws.close(1011));

/** Bắt đầu nhận kết nối và gửi ping định kỳ để kết nối không bị cắt. Gọi một lần lúc khởi động. */
export function startWebSocket() {
  wss.on('connection', onConnection);
  setInterval(() => {
    wss.clients.forEach((c) => {
      try {
        c.ping();
      } catch {}
    });
  }, 25000);
}
