/** Theo dõi TikTok Live: nhận bình luận, mở và đóng phiên live, dừng live khi hết quyền. */
import crypto from 'node:crypto';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import * as sqlite from '../db.js';
import { LiveManager, liveKey } from '../live-manager.js';
import { accessOf } from '../access.js';
import { durationText, sessionName, timeOf } from '../native-sync.js';
import { COMMENT_WINDOW, SESSION_RESUME_MS, SIGN_API_KEY } from './config.js';
import { db } from './database.js';
import { usersDb } from './accounts.js';
import { getStateForUser, persistAllStates, statesByUserId } from './states.js';
import { broadcastToUser, mutateState } from './hub.js';
import { toServerComment } from './device-sync.js';
import { safely } from './util.js';

/** Chuẩn hoá username: bỏ @, bỏ link */
export function normalizeUsername(input = '') {
  const u = String(input).trim();
  // Link phiên live: lấy phần sau dấu @.
  const inLink = u.match(/@([\w.-]+)/);
  if (inLink) return inLink[1];
  const plain = u.match(/^[^/?#&\s]+$/);
  return plain ? plain[0] : '';
}

function slugify(str = '') {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mapChat(data, kind = 'chat') {
  const user = data.user || {};
  const displayId = (user.displayId || data.displayId || user.uniqueId || data.uniqueId || '').toString().trim();
  const userId = (user.idStr || user.userId || user.id || data.userId || '').toString().trim();
  const nickname = (user.nickname || data.nickname || displayId || '').toString().trim();

  const uniqueId =
    displayId ||
    (userId ? `user_${userId.slice(-6)}` : '') ||
    (nickname ? slugify(nickname) : '') ||
    `khach_${Math.random().toString(36).slice(2, 7)}`;

  const rawTs = Number(data.common?.createTime) || 0;
  const created = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
  // Đồng hồ TikTok lệch quá xa thì dùng giờ server.
  const ts = Math.abs(Date.now() - created) < 6 * 60 * 60 * 1000 ? created : Date.now();

  const text = data.comment || data.content || '';
  const isSticker = kind === 'emote' || (!text && (data.emotes?.length || data.emoteList?.length));
  const comment = text || (isSticker ? '[Sticker]' : '');

  // Có mã tin của TikTok thì nối lại không bị trùng; không có thì dựng mã ổn định từ nội dung và giờ gửi.
  // Thiếu cả giờ gửi thì thêm giờ máy chủ nhận: khách gõ lại đúng câu cũ (chốt thêm món) vẫn là bình luận mới.
  const msgId = data.common?.msgId || data.msgId;
  const id = String(
    msgId && String(msgId) !== '0'
      ? msgId
      : crypto.createHash('sha1').update(`${userId}|${uniqueId}|${comment}|${rawTs || `nhan_${Date.now()}`}`).digest('hex').slice(0, 24)
  );

  return { id, userId, uniqueId, nickname: nickname || uniqueId, comment, ts };
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

/* ============================================================
   Theo dõi TikTok Live (nhiều live cùng lúc cho mỗi tài khoản)
   Server tự lưu bình luận và phiên, thiết bị nào mất mạng cũng không mất dữ liệu.
   ============================================================ */
function openSessionFor(userId, entry) {
  const st = getStateForUser(userId);
  if (entry.sessionId && st.sessions?.some((s) => s.id === entry.sessionId)) return;
  const now = Date.now();
  const key = liveKey(entry.username);
  mutateState(userId, 'session_started', '', null, (state) => {
    if (!Array.isArray(state.sessions)) state.sessions = [];
    // Vừa dừng hoặc rớt hẳn rồi quay lại: nối tiếp phiên cũ thay vì tạo phiên mới.
    const recent = state.sessions.find(
      (s) => liveKey(s.tiktok) === key && (s.isLive || (s.endTs && now - s.endTs < SESSION_RESUME_MS))
    );
    if (recent) {
      recent.isLive = true;
      recent.endTs = null;
      recent.endStr = '';
      recent.duration = '';
      entry.sessionId = recent.id;
      return;
    }
    const session = {
      id: 's_' + now.toString(36) + crypto.randomBytes(2).toString('hex'),
      tiktok: entry.username,
      name: sessionName(now),
      startTs: now,
      endTs: null,
      isLive: true,
      timeStr: timeOf(now),
      endStr: '',
      duration: '',
      commentCount: 0,
      priceCount: 0,
      lastActivityTs: now
    };
    state.sessions.unshift(session);
    entry.sessionId = session.id;
  });
}

function closeSessionFor(userId, entry) {
  if (!entry.sessionId) return;
  mutateState(userId, 'session_ended', '', null, (state) => {
    const s = state.sessions?.find((x) => x.id === entry.sessionId);
    if (!s || !s.isLive) return;
    const now = Date.now();
    // Mốc hoạt động cuối: bình luận cuối, hoặc lần cuối TikTok còn gửi dữ liệu (số người xem, lượt thích…)
    // trong lần chạy này, để live vắng bình luận không bị ghi kết thúc sớm.
    const seen = entry.everConnected ? Number(entry.lastDataAt) || 0 : 0;
    const last = Math.max(s.lastActivityTs || s.startTs, seen);
    // Server tắt lâu rồi mới chạy lại: lấy mốc hoạt động cuối thay vì lúc này.
    const end = now - last > 10 * 60 * 1000 ? last : now;
    s.isLive = false;
    s.endTs = end;
    s.endStr = timeOf(end);
    s.duration = durationText(s.startTs, end);
  });
}

function recordLiveComment(userId, entry, data, kind) {
  const mapped = mapChat(data, kind);
  if (!mapped.comment) return;
  const st = getStateForUser(userId);
  if (!st.sessions?.some((s) => s.id === entry.sessionId)) {
    // Lô bình luận đầu về trước khi kết nối xong, hoặc dữ liệu vừa bị đặt lại.
    entry.sessionId = '';
    openSessionFor(userId, entry);
  }
  const comment = toServerComment(st, { ...mapped, sessionId: entry.sessionId, live: entry.username });
  // Bảng có khoá chính nên nối lại nhận lại tin cũ cũng không bị trùng.
  if (!sqlite.insertComment(db, userId, comment)) return;

  if (!Array.isArray(st.comments)) st.comments = [];
  const at = st.comments.findIndex((c) => (Number(c.ts) || 0) <= comment.ts);
  if (at < 0) st.comments.push(comment);
  else st.comments.splice(at, 0, comment);
  if (st.comments.length > COMMENT_WINDOW) st.comments.length = COMMENT_WINDOW;

  const session = st.sessions.find((s) => s.id === entry.sessionId);
  if (session) {
    session.commentCount = (session.commentCount || 0) + 1;
    if (comment.price) session.priceCount = (session.priceCount || 0) + 1;
    session.lastActivityTs = Math.max(session.lastActivityTs || 0, comment.ts);
  }
  persistAllStates(userId);
  broadcastToUser(userId, { type: 'chat', ...comment });
}

export function broadcastLives(userId) {
  broadcastToUser(userId, { type: 'lives', lives: liveManager.list(userId) });
}

export const liveManager = new LiveManager({
  createConnection: (username) =>
    new TikTokLiveConnection(username, {
      // Lấy cả lô bình luận TikTok gửi kèm lúc kết nối, để nối lại vẫn vớt được phần vừa bị lỡ.
      processInitialData: true,
      fetchRoomInfoOnConnect: true,
      ...(SIGN_API_KEY ? { signApiKey: SIGN_API_KEY } : {})
    }),
  events: {
    chat: WebcastEvent.CHAT,
    emote: WebcastEvent.EMOTE,
    roomUser: WebcastEvent.ROOM_USER,
    streamEnd: WebcastEvent.STREAM_END,
    disconnected: ControlEvent.DISCONNECTED,
    error: ControlEvent.ERROR,
    rawData: 'decodedData'
  },
  friendlyError,
  log: (...args) => console.warn(...args),
  onComment: safely('live comment', recordLiveComment),
  onViewers: safely('live viewers', (userId, entry) => {
    broadcastToUser(userId, { type: 'viewers', username: entry.username, count: entry.viewers });
  }),
  onSessionNeeded: safely('live session', openSessionFor),
  onChange: safely('live change', (userId, entry) => {
    broadcastToUser(userId, {
      type: 'status',
      state: entry.state,
      username: entry.username,
      message: entry.message || '',
      roomId: entry.roomId || '',
      sessionId: entry.sessionId || ''
    });
    broadcastLives(userId);
    if (entry.state === 'connected') console.log(`[live] ${userId} theo dõi @${entry.username} room=${entry.roomId}`);
  }),
  onEnded: safely('live ended', (userId, entry, reason) => {
    closeSessionFor(userId, entry);
    broadcastToUser(userId, {
      type: 'status',
      state: reason === 'stopped' ? 'idle' : reason,
      username: entry.username,
      message: entry.message || '',
      sessionId: entry.sessionId || ''
    });
    broadcastLives(userId);
  })
});

/** Hết quyền thì dừng mọi live của tài khoản và báo lý do cho mọi thiết bị đang mở. */
export function applyLiveAccess(user) {
  const access = accessOf(user);
  if (access.canFollowLive || !liveManager.list(user.id).length) return;
  liveManager.stop(user.id);
  broadcastToUser(user.id, { type: 'access', access });
  broadcastToUser(user.id, { type: 'status', state: 'error', username: '', code: access.code, message: access.message });
}

// Không chờ tới lần bấm kế tiếp: live đang chạy lúc hết hạn cũng phải dừng, kể cả lúc đang tự nối lại.
setInterval(
  safely('live access', () => {
    for (const userId of liveManager.activeUserIds()) {
      const user = usersDb.users.find((u) => u.id === userId);
      if (user) applyLiveAccess(user);
    }
  }),
  5000
).unref();

export function getLiveStatus(userId) {
  const first = userId ? liveManager.list(userId)[0] : null;
  return first ? { state: first.state, username: first.username, mode: 'real' } : { state: 'idle', username: '', mode: 'idle' };
}

/** Server khởi động lại giữa phiên: nối lại những live đang theo dõi. */
export function resumeLivesAfterRestart() {
  let delay = 0;
  for (const [userId, st] of Object.entries(statesByUserId)) {
    const user = usersDb.users.find((u) => u.id === userId);
    for (const s of st.sessions || []) {
      if (!s.isLive || !s.tiktok || !s.startTs) continue;
      if (!user || user.locked || !accessOf(user).canFollowLive) {
        s.isLive = false;
        s.endTs = s.lastActivityTs || s.startTs;
        s.endStr = timeOf(s.endTs);
        s.duration = durationText(s.startTs, s.endTs);
        persistAllStates(userId);
        continue;
      }
      setTimeout(
        safely('live resume', () => {
          console.log(`[live] nối lại @${s.tiktok} của ${userId} sau khi khởi động`);
          const entry = liveManager.start(userId, s.tiktok);
          if (entry) entry.sessionId = s.id;
        }),
        delay
      ).unref?.();
      delay += 1500;
    }
  }
}
