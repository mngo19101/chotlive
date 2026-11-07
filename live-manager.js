/**
 * Quản lý các kết nối TikTok Live của từng tài khoản ChốtLive.
 * - Mỗi tài khoản theo dõi được nhiều live cùng lúc, mỗi live một kết nối riêng.
 * - Rớt kết nối giữa phiên thì tự nối lại; live thật sự kết thúc mới đóng phiên.
 * - Kết nối mở nhưng im lặng quá lâu cũng được nối lại, tránh mất bình luận mà không ai biết.
 *
 * Không phụ thuộc thư viện TikTok trực tiếp (nhận qua `createConnection`) để test được.
 */

export const LIVE_STATES = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting'
};

/** Sau các mốc này vẫn không nối lại được thì coi như live đã dừng (tổng khoảng 10 phút). */
export const DEFAULT_RETRY_DELAYS_MS = [
  1000, 2000, 4000, 8000, 15000, 30000, 30000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000
];

/** Phòng có người xem luôn có dữ liệu đều đặn (số người xem, thả tim...). */
export const DEFAULT_STALE_AFTER_MS = 90000;
const STALE_CHECK_EVERY_MS = 30000;

export function liveKey(username = '') {
  return String(username).trim().toLowerCase();
}

function isOffline(err) {
  const name = err?.constructor?.name || err?.name || '';
  const msg = String(err?.message || err || '');
  return name.includes('UserOffline') || /offline|not live|isn't online/i.test(msg);
}

export class LiveManager {
  /**
   * @param {object} opts
   * @param {(username: string) => object} opts.createConnection Tạo kết nối TikTok mới.
   * @param {{chat: string, emote: string, roomUser: string, streamEnd: string, disconnected: string, error: string}} opts.events Tên sự kiện.
   * @param {(userId: string, entry: object, data: object, kind: string) => void} opts.onComment
   * @param {(userId: string, entry: object) => void} opts.onViewers
   * @param {(userId: string, entry: object) => void} opts.onChange Trạng thái một live vừa đổi.
   * @param {(userId: string, entry: object) => void} opts.onSessionNeeded Live vừa kết nối, cần có phiên.
   * @param {(userId: string, entry: object, reason: string) => void} opts.onEnded Live đã dừng hẳn.
   * @param {(err: unknown) => string} opts.friendlyError
   */
  constructor({
    createConnection,
    events,
    onComment,
    onViewers,
    onChange,
    onSessionNeeded,
    onEnded,
    friendlyError = (e) => String(e?.message || e),
    retryDelays = DEFAULT_RETRY_DELAYS_MS,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    now = () => Date.now(),
    log = () => {}
  }) {
    Object.assign(this, {
      createConnection,
      events,
      onComment,
      onViewers,
      onChange,
      onSessionNeeded,
      onEnded,
      friendlyError,
      retryDelays,
      staleAfterMs,
      now,
      log
    });
    this.byUser = new Map();
    this.staleTimer = null;
  }

  livesOf(userId) {
    let m = this.byUser.get(userId);
    if (!m) {
      m = new Map();
      this.byUser.set(userId, m);
    }
    return m;
  }

  /** Danh sách gửi cho client. */
  list(userId) {
    const m = this.byUser.get(userId);
    if (!m) return [];
    return [...m.values()].map((e) => ({
      username: e.username,
      state: e.state,
      message: e.message || '',
      viewers: e.viewers || 0,
      roomId: e.roomId || '',
      sessionId: e.sessionId || '',
      startedAt: e.startedAt
    }));
  }

  start(userId, username) {
    const key = liveKey(username);
    if (!key) return null;
    const lives = this.livesOf(userId);
    const existing = lives.get(key);
    // Đang theo dõi live này rồi: giữ nguyên, không tạo kết nối trùng.
    if (existing) return existing;
    const entry = {
      key,
      username,
      userId,
      state: LIVE_STATES.CONNECTING,
      message: '',
      viewers: 0,
      roomId: '',
      sessionId: '',
      startedAt: this.now(),
      lastDataAt: this.now(),
      conn: null,
      attempt: 0,
      everConnected: false,
      retryTimer: null,
      stopped: false
    };
    lives.set(key, entry);
    this.ensureStaleCheck();
    this.onChange?.(userId, entry);
    this.connect(entry);
    return entry;
  }

  /** Bỏ `username` thì dừng tất cả live của tài khoản. */
  stop(userId, username = '') {
    const lives = this.byUser.get(userId);
    if (!lives) return;
    const targets = username ? [lives.get(liveKey(username))].filter(Boolean) : [...lives.values()];
    for (const entry of targets) this.finish(entry, 'stopped', '');
  }

  isCurrent(entry) {
    return !entry.stopped && this.byUser.get(entry.userId)?.get(entry.key) === entry;
  }

  dropConnection(entry) {
    const conn = entry.conn;
    entry.conn = null;
    if (!conn) return;
    try {
      conn.removeAllListeners?.();
      const p = conn.disconnect?.();
      p?.catch?.(() => {});
    } catch {}
  }

  async connect(entry) {
    this.dropConnection(entry);
    let conn;
    try {
      conn = this.createConnection(entry.username);
    } catch (err) {
      this.finish(entry, 'error', this.friendlyError(err));
      return;
    }
    entry.conn = conn;
    const { events } = this;
    const live = () => this.isCurrent(entry) && entry.conn === conn;
    const touch = () => {
      entry.lastDataAt = this.now();
    };

    conn.on(events.chat, (data) => {
      if (!live()) return;
      touch();
      this.onComment?.(entry.userId, entry, data, 'chat');
    });
    if (events.emote) {
      conn.on(events.emote, (data) => {
        if (!live()) return;
        touch();
        this.onComment?.(entry.userId, entry, data, 'emote');
      });
    }
    conn.on(events.roomUser, (data) => {
      if (!live()) return;
      touch();
      entry.viewers = Number(data?.viewerCount ?? data?.totalUser ?? 0);
      this.onViewers?.(entry.userId, entry);
    });
    if (events.rawData) conn.on(events.rawData, () => live() && touch());
    conn.on(events.streamEnd, () => {
      if (!live()) return;
      this.finish(entry, 'ended', 'Phiên live đã kết thúc.');
    });
    conn.on(events.disconnected, () => {
      if (!live()) return;
      this.log(`[live] @${entry.username} rớt kết nối, đang nối lại`);
      this.scheduleReconnect(entry, null);
    });
    conn.on(events.error, (err) => {
      this.log(`[live error] @${entry.username}`, err?.info || err?.message || err);
    });

    try {
      const res = await conn.connect();
      if (!live()) {
        this.dropConnection({ conn });
        return;
      }
      entry.roomId = res?.roomId || entry.roomId;
      entry.state = LIVE_STATES.CONNECTED;
      entry.message = '';
      entry.attempt = 0;
      entry.everConnected = true;
      entry.lastDataAt = this.now();
      this.onSessionNeeded?.(entry.userId, entry);
      this.onChange?.(entry.userId, entry);
    } catch (err) {
      if (!live()) return;
      if (!entry.everConnected) {
        // Lần đầu không vào được (sai tên, không live, giới hạn lượt ký...): báo ngay cho người dùng.
        this.finish(entry, 'error', this.friendlyError(err));
      } else if (isOffline(err)) {
        this.finish(entry, 'ended', 'Phiên live đã kết thúc.');
      } else {
        this.scheduleReconnect(entry, err);
      }
    }
  }

  scheduleReconnect(entry, err) {
    if (!this.isCurrent(entry) || entry.retryTimer) return;
    const delay = this.retryDelays[entry.attempt];
    if (delay === undefined) {
      this.finish(entry, 'error', err ? this.friendlyError(err) : 'Mất kết nối với TikTok quá lâu.');
      return;
    }
    entry.attempt += 1;
    entry.state = LIVE_STATES.RECONNECTING;
    entry.message = 'Mất kết nối với TikTok, đang nối lại...';
    this.onChange?.(entry.userId, entry);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (this.isCurrent(entry)) this.connect(entry);
    }, delay);
    entry.retryTimer.unref?.();
  }

  /** Dừng hẳn một live và báo cho nơi lưu phiên. */
  finish(entry, reason, message) {
    if (entry.stopped) return;
    entry.stopped = true;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    this.dropConnection(entry);
    const lives = this.byUser.get(entry.userId);
    if (lives?.get(entry.key) === entry) lives.delete(entry.key);
    if (lives && lives.size === 0) this.byUser.delete(entry.userId);
    entry.state = reason;
    entry.message = message;
    this.onEnded?.(entry.userId, entry, reason);
  }

  /** Nối lại những kết nối còn mở nhưng đã im lặng quá lâu. */
  checkStale(at = this.now()) {
    for (const lives of this.byUser.values()) {
      for (const entry of lives.values()) {
        if (entry.state !== LIVE_STATES.CONNECTED) continue;
        if (at - entry.lastDataAt < this.staleAfterMs) continue;
        this.log(`[live] @${entry.username} im lặng quá lâu, nối lại`);
        this.dropConnection(entry);
        this.scheduleReconnect(entry, null);
      }
    }
  }

  ensureStaleCheck() {
    if (this.staleTimer) return;
    this.staleTimer = setInterval(() => this.checkStale(), STALE_CHECK_EVERY_MS);
    this.staleTimer.unref?.();
  }

  stopAll() {
    clearInterval(this.staleTimer);
    this.staleTimer = null;
    for (const lives of [...this.byUser.values()]) {
      for (const entry of [...lives.values()]) {
        // Giữ phiên ở trạng thái đang live để lần chạy sau nối tiếp.
        entry.stopped = true;
        clearTimeout(entry.retryTimer);
        this.dropConnection(entry);
      }
    }
    this.byUser.clear();
  }
}
