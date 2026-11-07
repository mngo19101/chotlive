/**
 * Module Đồng Bộ Thời Gian Thực & Xác Thực Phân Quyền (Web <-> Server <-> iOS App IPA)
 * - Quản lý phiên đăng nhập (Token, User, Role Admin / User)
 * - Tự động kết nối WebSocket (/ws?token=...) + fallback REST (/api/state, /api/sync)
 * - Khi thao tác trên Web -> App IPA cập nhật tức thì
 * - Khi thao tác trên App IPA -> Web cập nhật tức thì
 * - Khi Admin khoá tài khoản hoặc đổi pass -> Thiết bị của tài khoản đó bị đẩy ra màn hình đăng nhập ngay lập tức
 */
import {
  state,
  registerSyncPushHandler,
  applyRemoteState,
  clearPendingChanges,
  getPendingOwner,
  getPendingVersion,
  markPendingSynced,
  pendingChangeCount
} from './store.js';

const SERVER_URL_KEY = 'susu_sync_server_url';
const CLIENT_ID_KEY = 'susu_sync_client_id';
const AUTH_TOKEN_KEY = 'susu_auth_token';
const AUTH_USER_KEY = 'susu_auth_user';

function getOrCreateClientId() {
  try {
    let cid = localStorage.getItem(CLIENT_ID_KEY);
    if (!cid) {
      cid = 'web_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(CLIENT_ID_KEY, cid);
    }
    return cid;
  } catch {
    return 'client_' + Math.random().toString(36).slice(2, 9);
  }
}

export const clientId = getOrCreateClientId();

export function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function getCurrentUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setAuthSession(token, user) {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
    if (user) {
      // Thay đổi chưa gửi của tài khoản khác không được lọt sang tài khoản vừa đăng nhập.
      if (getPendingOwner() && getPendingOwner() !== user.id) clearPendingChanges();
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(AUTH_USER_KEY);
    }
  } catch {}
}

export function clearAuthSession() {
  setAuthSession('', null);
}

export function getServerBaseUrl() {
  const onWeb = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  try {
    // Trên web chỉ tin địa chỉ người dùng tự nhập trên chính máy này. settings.serverUrl từng bị
    // đồng bộ qua lại giữa các thiết bị nên có thể là địa chỉ của máy khác.
    const saved = (localStorage.getItem(SERVER_URL_KEY) || (onWeb ? '' : state.settings?.serverUrl) || '').trim();
    if (saved) return saved.replace(/\/+$/, '');
  } catch {}

  if (onWeb) {
    return window.location.origin;
  }

  return 'https://susu-live-order.onrender.com';
}

export function setServerBaseUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  try {
    if (clean) {
      localStorage.setItem(SERVER_URL_KEY, clean);
    } else {
      localStorage.removeItem(SERVER_URL_KEY);
    }
  } catch {}
  if (state.settings) {
    state.settings.serverUrl = clean;
  }
  reconnectSync();
  return getServerBaseUrl();
}

export function authHeaders() {
  const tk = getAuthToken();
  return tk
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }
    : { 'Content-Type': 'application/json' };
}

export async function apiFetch(endpoint, options = {}) {
  const base = getServerBaseUrl();
  const headers = {
    ...authHeaders(),
    ...(options.headers || {})
  };

  let res;
  try {
    res = await fetch(`${base}${endpoint}`, {
      ...options,
      headers
    });
  } catch (err) {
    // Nếu đang mở trên trình duyệt Web (http/https) mà địa chỉ Server URL lưu cũ bị sai, tự động fallback về chính origin hiện tại
    if (
      (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
      base !== window.location.origin
    ) {
      res = await fetch(`${window.location.origin}${endpoint}`, {
        ...options,
        headers
      });
    } else {
      throw err;
    }
  }

  const data = await res.json().catch(() => ({}));
  const isAuthEndpoint =
    endpoint.startsWith('/api/auth/login') || endpoint.startsWith('/api/auth/register');

  if (!res.ok && !isAuthEndpoint) {
    if (res.status === 401 || data?.code === 'ACCOUNT_LOCKED') {
      forceLogoutListeners.forEach((fn) => {
        try {
          fn(data?.error || 'Phiên đăng nhập đã kết thúc.');
        } catch {}
      });
    }
  }

  const result = {
    ...data,
    ok: res.ok && data?.ok !== false,
    status: res.status
  };
  Object.defineProperty(result, 'json', {
    value: async () => result,
    enumerable: false
  });
  return result;
}

export const syncStatus = {
  connected: false,
  clientsCount: 1,
  rev: 0,
  serverUrl: '',
  lastSyncTime: 0
};

let ws = null;
let reconnectTimer = null;
let statusListeners = [];
let uiEventListeners = [];
let liveEventListeners = [];
let forceLogoutListeners = [];
let adminUsersListeners = [];
let accessListeners = [];
let offlineListeners = [];
/** Số gói đã gửi qua WebSocket mà server chưa xác nhận. */
let unackedPushes = 0;
let httpPushBusy = false;
let httpPushAgain = false;
/** Đã báo người dùng rằng có thay đổi đang nằm chờ trên máy. */
let offlineNoticeShown = false;

/** `fn('saved' | 'synced', soThayDoi)`: thay đổi đang chờ mạng, hoặc đã gửi được lên server. */
export function onOfflineChanges(fn) {
  offlineListeners.push(fn);
}

function notifyOffline(kind, count) {
  offlineListeners.forEach((fn) => {
    try {
      fn(kind, count);
    } catch {}
  });
}

function noticeWaitingForNetwork() {
  if (offlineNoticeShown || !pendingChangeCount()) return;
  offlineNoticeShown = true;
  notifyOffline('saved', pendingChangeCount());
}

function finishSynced(version) {
  const count = pendingChangeCount();
  markPendingSynced(version);
  if (offlineNoticeShown && count && !pendingChangeCount()) {
    offlineNoticeShown = false;
    notifyOffline('synced', count);
  }
}

export function onSyncStatusChange(fn) {
  statusListeners.push(fn);
}

export function onRemoteUiEvent(fn) {
  uiEventListeners.push(fn);
}

export function onLiveStreamEvent(fn) {
  liveEventListeners.push(fn);
}

export function onForceLogout(fn) {
  forceLogoutListeners.push(fn);
}

export function onAdminUsersSync(fn) {
  adminUsersListeners.push(fn);
}

/** `fn(access)`: quyền dùng của tài khoản vừa đổi (hết dùng thử, được cấp gói...). */
export function onAccountAccess(fn) {
  accessListeners.push(fn);
}

function updateAccess(access) {
  const user = getCurrentUser();
  if (!user) return;
  setAuthSession(getAuthToken(), { ...user, access });
  accessListeners.forEach((fn) => {
    try {
      fn(access);
    } catch {}
  });
}

function notifyLives(lives) {
  if (!Array.isArray(lives)) return;
  liveEventListeners.forEach((fn) => {
    try {
      fn({ type: 'lives', lives });
    } catch {}
  });
}

function notifyStatus() {
  statusListeners.forEach((fn) => {
    try {
      fn({ ...syncStatus });
    } catch {}
  });
}

function buildWsUrl(baseUrl) {
  const tk = getAuthToken();
  try {
    const u = new URL(baseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = tk ? `?token=${encodeURIComponent(tk)}` : '';
    return u.toString();
  } catch {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = tk ? `?token=${encodeURIComponent(tk)}` : '';
    return `${proto}//${window.location.host}/ws${qs}`;
  }
}

function buildPayload(currentState) {
  // Bình luận và phiên live do server ghi. Thiết bị chỉ báo bình luận nào vừa được in;
  // gửi cả danh sách như trước sẽ ghi đè và làm mất bình luận của thiết bị khác.
  const { serverUrl: _deviceOnly, ...settings } = currentState.settings || {};
  return {
    isCleanAccount: currentState.isCleanAccount,
    orders: currentState.orders,
    customers: currentState.customers,
    comments: (currentState.comments || []).filter((c) => c.printed),
    sessions: currentState.sessions,
    accounts: currentState.accounts,
    prints: currentState.prints,
    settings,
    salesMetrics: currentState.salesMetrics,
    seq: currentState.seq,
    selectedCustomerUniqueId: currentState.selectedCustomerUniqueId,
    activeSessionId: currentState.activeSessionId
  };
}

/**
 * Không có WebSocket nên có thể đã lỡ thay đổi từ thiết bị khác: phải lấy dữ liệu mới nhất
 * ghép với phần chưa gửi của máy này rồi mới đẩy lên, nếu không sẽ ghi đè mất đơn của họ.
 * Không gửi được thì thay đổi vẫn nằm chờ trên máy, có mạng lại sẽ tự gửi.
 */
async function pushViaHttp(action) {
  if (httpPushBusy) {
    httpPushAgain = true;
    return;
  }
  httpPushBusy = true;
  try {
    do {
      httpPushAgain = false;
      const latest = await apiFetch('/api/state', { method: 'GET', cache: 'no-store' });
      if (!latest?.state) throw new Error('Không lấy được dữ liệu server');
      applyRemoteState(latest.state, 'initial_fetch');
      const version = getPendingVersion();
      const data = await apiFetch('/api/sync', {
        method: 'POST',
        body: JSON.stringify({ clientId, action, state: buildPayload(state) })
      });
      if (!data?.ok) throw new Error(data?.error || 'Server không nhận dữ liệu');
      syncStatus.rev = data.rev || syncStatus.rev;
      syncStatus.lastSyncTime = Date.now();
      finishSynced(version);
    } while (httpPushAgain);
  } catch {
    noticeWaitingForNetwork();
  } finally {
    httpPushBusy = false;
    notifyStatus();
  }
}

export async function pushStateToServer(currentState, action = 'update') {
  if (!getAuthToken()) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(
        JSON.stringify({
          type: 'sync_update',
          clientId,
          action,
          state: buildPayload(currentState)
        })
      );
      unackedPushes += 1;
      syncStatus.lastSyncTime = Date.now();
      return;
    } catch {}
  }

  await pushViaHttp(action);
}

/** Vừa nối lại server: gửi nốt những gì đã thay đổi lúc mất mạng. */
function pushWaitingChanges() {
  if (pendingChangeCount() && unackedPushes === 0) pushStateToServer(state, 'offline_merge');
}

export function sendUiEvent(eventData = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(
        JSON.stringify({
          type: 'ui_event',
          clientId,
          ts: Date.now(),
          ...eventData
        })
      );
    } catch {}
  }
}

/** Có tên live thì chỉ tác động lên live đó, không có tên thì tác động tất cả. */
export function sendLiveCommand(type, username = '') {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type, username, clientId }));
      return true;
    } catch {}
  }
  return false;
}

export async function fetchInitialStateFromServer() {
  if (!getAuthToken()) return false;
  try {
    const data = await apiFetch('/api/state', { method: 'GET', cache: 'no-store' });
    if (data && data.state) {
      syncStatus.rev = data.rev || 1;
      syncStatus.clientsCount = data.clientsCount || 1;
      syncStatus.lastSyncTime = Date.now();
      applyRemoteState(data.state, 'initial_fetch');
      notifyLives(data.lives);
      notifyStatus();
      return true;
    }
  } catch {}
  return false;
}

export function connectSync() {
  clearTimeout(reconnectTimer);
  unackedPushes = 0;
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch {}
    ws = null;
  }

  const baseUrl = getServerBaseUrl();
  syncStatus.serverUrl = baseUrl;
  const wsUrl = buildWsUrl(baseUrl);

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    syncStatus.connected = false;
    notifyStatus();
    reconnectTimer = setTimeout(connectSync, 3500);
    return;
  }

  ws.onopen = () => {
    syncStatus.connected = true;
    syncStatus.lastSyncTime = Date.now();
    const tk = getAuthToken();
    if (tk) {
      try {
        ws.send(JSON.stringify({ type: 'auth', token: tk, delta: true }));
      } catch {}
    }
    notifyStatus();
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'account_locked' || msg.type === 'password_changed_force_login' || msg.type === 'auth_error') {
      forceLogoutListeners.forEach((fn) => {
        try {
          fn(msg.message || 'Tài khoản đã bị khoá hoặc thay đổi mật khẩu.');
        } catch {}
      });
      return;
    }

    if (msg.type === 'admin_users_sync' && Array.isArray(msg.users)) {
      adminUsersListeners.forEach((fn) => {
        try {
          fn(msg.users);
        } catch {}
      });
      return;
    }

    if (msg.type === 'access' && msg.access) {
      updateAccess(msg.access);
      return;
    }
    if (msg.type === 'hello' && msg.user?.access) updateAccess(msg.user.access);

    if (msg.type === 'hello' && msg.state) {
      syncStatus.connected = true;
      syncStatus.rev = msg.rev || 1;
      syncStatus.clientsCount = msg.clientsCount || 1;
      syncStatus.lastSyncTime = Date.now();
      applyRemoteState(msg.state, 'hello');
      notifyLives(msg.lives);
      notifyStatus();
      pushWaitingChanges();
    } else if (msg.type === 'state_sync' && msg.state) {
      if (msg.clientId && msg.clientId === clientId) return;
      syncStatus.rev = msg.rev || syncStatus.rev + 1;
      syncStatus.lastSyncTime = Date.now();
      applyRemoteState(msg.state, msg.action || 'remote_sync');
      notifyStatus();
    } else if (msg.type === 'state_delta' && msg.collections) {
      const baseOk = msg.baseRev === syncStatus.rev;
      syncStatus.rev = msg.rev || syncStatus.rev;
      syncStatus.lastSyncTime = Date.now();
      if (msg.clientId && msg.clientId === clientId) {
        notifyStatus();
        return;
      }
      if (!baseOk) {
        fetchInitialStateFromServer();
        return;
      }
      const patch = {};
      for (const [coll, c] of Object.entries(msg.collections)) {
        const cur = Array.isArray(state[coll]) ? state[coll] : [];
        const byId = new Map(cur.map((x) => [String(x.id), x]));
        for (const o of c.upsert || []) byId.set(String(o.id), o);
        if (coll === 'comments') {
          // Bình luận chỉ thêm và cập nhật, thiết bị đang giữ cái nào thì không mất cái đó.
          patch[coll] = [...byId.values()].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
          continue;
        }
        patch[coll] = c.ids
          ? c.ids.map((id) => byId.get(String(id))).filter(Boolean)
          : cur.map((x) => byId.get(String(x.id)));
      }
      const { rev: _r, updatedAt: _u, ...scalars } = msg.scalars || {};
      applyRemoteState({ ...scalars, ...patch }, msg.action || 'remote_sync');
      notifyStatus();
    } else if (msg.type === 'sync_ack') {
      syncStatus.rev = msg.rev || syncStatus.rev;
      if (typeof msg.clientsCount === 'number') syncStatus.clientsCount = msg.clientsCount;
      syncStatus.lastSyncTime = Date.now();
      unackedPushes = Math.max(0, unackedPushes - 1);
      if (unackedPushes === 0) finishSynced();
      notifyStatus();
    } else if (msg.type === 'clients_count') {
      syncStatus.clientsCount = msg.clientsCount || 1;
      notifyStatus();
    } else if (msg.type === 'ui_event') {
      if (msg.clientId && msg.clientId === clientId) return;
      uiEventListeners.forEach((fn) => {
        try {
          fn(msg);
        } catch {}
      });
    } else if (msg.type === 'chat' || msg.type === 'status' || msg.type === 'viewers' || msg.type === 'lives') {
      liveEventListeners.forEach((fn) => {
        try {
          fn(msg);
        } catch {}
      });
    }
  };

  ws.onclose = () => {
    syncStatus.connected = false;
    unackedPushes = 0;
    noticeWaitingForNetwork();
    notifyStatus();
    reconnectTimer = setTimeout(connectSync, 3000);
  };

  ws.onerror = () => {};
}

export function reconnectSync() {
  connectSync();
}

registerSyncPushHandler(
  (currentState, action) => {
    pushStateToServer(currentState, action);
  },
  () => (getAuthToken() ? getCurrentUser()?.id || '' : '')
);
