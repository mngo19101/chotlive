/** Nhận dữ liệu do thiết bị (web, app) gửi lên và gộp vào dữ liệu của tài khoản. */
import { DEFAULT_SETTINGS, initialCustomers, initialOrders, initialComments } from '../public/js/store.js';
import * as sqlite from '../db.js';
import { parsePrice, extractProductInfo } from '../public/js/price.js';
import { createLimiter } from '../rate-limit.js';
import { applyRecordChanges, cleanChanges, cleanNativeUpdate, cleanState } from '../validate.js';
import { SYNC_BYTES_PER_MINUTE, SYNC_MESSAGES_PER_MINUTE } from '../limits.js';
import { applyNativeUpdate, mergeNativeSessions, timeOf } from '../native-sync.js';
import * as vtp from '../vtp.js';
import { COMMENT_WINDOW } from './config.js';
import { db } from './database.js';
import { isDefaultAdminUser } from './accounts.js';
import { getStateForUser } from './states.js';
import { mutateState } from './hub.js';

// Dữ liệu đồng bộ do thiết bị gửi lên, tính theo từng tài khoản (xem limits.js).
const syncMessagesByUser = createLimiter({ max: SYNC_MESSAGES_PER_MINUTE, windowMs: 60 * 1000 });
const syncBytesByUser = createLimiter({ max: SYNC_BYTES_PER_MINUTE, windowMs: 60 * 1000 });

/** Ghi nhận một gói đồng bộ; false nghĩa là tài khoản đã gửi quá nhiều trong phút này. */
export function syncAllowed(userId, bytes) {
  if (syncMessagesByUser.retryAfter(userId) > 0 || syncBytesByUser.retryAfter(userId) > 0) return false;
  syncMessagesByUser.hit(userId);
  syncBytesByUser.hit(userId, bytes);
  return true;
}

setInterval(() => {
  syncMessagesByUser.sweep();
  syncBytesByUser.sweep();
}, 10 * 60 * 1000).unref();

function trimCommentWindow(st) {
  st.comments.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  if (st.comments.length > COMMENT_WINDOW) st.comments.length = COMMENT_WINDOW;
}

/**
 * Bình luận do thiết bị gửi lên chỉ được thêm hoặc đánh dấu "đã in", không bao giờ xoá:
 * trước đây mỗi thiết bị ghi đè cả danh sách nên mất bình luận của nhau.
 */
function mergeIncomingComments(userId, st, incoming) {
  if (!Array.isArray(st.comments)) st.comments = [];
  const byId = new Map(st.comments.map((c) => [String(c.id), c]));
  let added = false;
  // Lần đồng bộ đầu của app có thể gửi hàng nghìn bình luận: ghi gộp một lần cho nhanh.
  sqlite.tx(db, () => {
    for (const c of incoming) {
      if (!c || c.id == null) continue;
      const id = String(c.id);
      const known = byId.get(id);
      if (known) {
        if (c.printed && !known.printed) {
          known.printed = true;
          sqlite.updateComment(db, userId, known);
        }
        continue;
      }
      if (sqlite.insertComment(db, userId, c)) {
        st.comments.push(c);
        byId.set(id, c);
        added = true;
      } else if (c.printed) {
        sqlite.markCommentPrinted(db, userId, id);
      }
    }
  });
  if (added) trimCommentWindow(st);
}

/** Bình luận trong gói đồng bộ, đã chuyển về dạng server lưu. */
function deviceCommentsOf(userId, msg) {
  const st = getStateForUser(userId);
  if (msg.type === 'native_update') {
    return (cleanNativeUpdate({ comments: msg.comments }).comments || [])
      .filter((c) => c.id != null)
      .map((c) => toServerComment(st, { ...c, comment: c.text ?? c.comment ?? '' }));
  }
  const demoIds = isDefaultAdminUser(userId) ? new Set() : new Set(initialComments.map((c) => c.id));
  return (cleanState({ comments: msg.state?.comments }).comments || []).filter((c) => c.id != null && !demoIds.has(c.id));
}

/**
 * Gói bị từ chối (gửi quá nhanh) vẫn phải giữ bình luận: chỉ ghi vào bảng bình luận, không đổi dữ liệu khác.
 * Bình luận đã có thì bỏ qua nhờ khoá chính, nên thiết bị gửi lại sau cũng không bị trùng.
 */
export function saveDeviceCommentsOnly(userId, msg) {
  const list = deviceCommentsOf(userId, msg);
  if (!list.length) return;
  sqlite.tx(db, () => {
    for (const c of list) sqlite.insertComment(db, userId, c);
  });
}

function markCommentsPrinted(userId, st, ids) {
  for (const id of ids) {
    const known = st.comments?.find((c) => String(c.id) === String(id));
    if (known) {
      if (!known.printed) {
        known.printed = true;
        sqlite.updateComment(db, userId, known);
      }
    } else {
      sqlite.markCommentPrinted(db, userId, String(id));
    }
  }
}

export function applyIncomingStateForUser(userId, rawIncoming, action = 'update', clientId = '', excludeWs = null) {
  const incoming = cleanState(rawIncoming);
  const isClean = !isDefaultAdminUser(userId);
  const demoOrderIds = new Set(initialOrders.map((o) => o.id));
  const demoCustIds = new Set(initialCustomers.map((c) => c.id));
  const demoCommentIds = new Set(initialComments.map((c) => c.id));
  const demoAccIds = new Set((DEFAULT_SETTINGS.accounts || []).map((a) => a.id));

  // Web bản mới chỉ gửi bản ghi vừa đổi (`changes`); bản cũ gửi cả danh sách thì vẫn nhận như trước.
  const changes = cleanChanges(rawIncoming?.changes);
  const withoutDemo = (change, demoIds) =>
    isClean ? { ...change, upsert: change.upsert.filter((r) => !demoIds.has(r.id)) } : change;

  return mutateState(userId, action, clientId, excludeWs, (targetState) => {
    if (Array.isArray(incoming.orders)) {
      const orders = isClean ? incoming.orders.filter((o) => !demoOrderIds.has(o.id)) : incoming.orders;
      // Web gửi cả danh sách đơn: phần vận đơn Viettel Post do máy chủ ghi thì giữ bản của máy chủ.
      targetState.orders = vtp.keepServerVtp(targetState.orders, orders);
    } else if (changes.orders) {
      // Chỉ đơn web vừa đổi mới bị thay; đơn app vừa thêm mà web chưa thấy thì còn nguyên.
      const orders = applyRecordChanges(targetState.orders, withoutDemo(changes.orders, demoOrderIds));
      targetState.orders = vtp.keepServerVtp(targetState.orders, orders);
    }
    if (Array.isArray(incoming.customers)) {
      targetState.customers = isClean ? incoming.customers.filter((c) => !demoCustIds.has(c.id)) : incoming.customers;
    } else if (changes.customers) {
      targetState.customers = applyRecordChanges(targetState.customers, withoutDemo(changes.customers, demoCustIds));
    }
    if (Array.isArray(incoming.comments)) {
      mergeIncomingComments(userId, targetState, isClean ? incoming.comments.filter((c) => !demoCommentIds.has(c?.id)) : incoming.comments);
    }
    // Phiên live do server ghi. Chỉ tài khoản demo mới có phiên mẫu từ thiết bị.
    if (Array.isArray(incoming.sessions) && !isClean) {
      targetState.sessions = incoming.sessions;
    }
    if (Array.isArray(incoming.accounts)) {
      targetState.accounts = isClean ? incoming.accounts.filter((a) => !demoAccIds.has(a.id)) : incoming.accounts;
    } else if (changes.accounts) {
      targetState.accounts = applyRecordChanges(targetState.accounts, withoutDemo(changes.accounts, demoAccIds), { append: true });
    }
    if (Array.isArray(incoming.prints)) targetState.prints = incoming.prints.slice(0, 100);
    if (incoming.settings && typeof incoming.settings === 'object') {
      // Địa chỉ server là của riêng từng thiết bị, đồng bộ đi sẽ làm thiết bị khác nối nhầm server.
      const { serverUrl: _deviceOnly, ...settings } = incoming.settings;
      targetState.settings = { ...targetState.settings, ...settings };
      if (isClean && Array.isArray(targetState.settings.accounts)) {
        targetState.settings.accounts = targetState.accounts;
      }
    }
    if (incoming.salesMetrics && typeof incoming.salesMetrics === 'object') {
      targetState.salesMetrics = { ...targetState.salesMetrics, ...incoming.salesMetrics };
    }
    if (typeof incoming.seq === 'number') targetState.seq = Math.max(targetState.seq || 0, incoming.seq);
    if (typeof incoming.selectedCustomerUniqueId === 'string') {
      targetState.selectedCustomerUniqueId = incoming.selectedCustomerUniqueId;
    }
    if (typeof incoming.activeSessionId === 'string') {
      targetState.activeSessionId = incoming.activeSessionId;
    }
    targetState.isCleanAccount = isClean;
  }, { fromDevice: true });
}

/** Thay đổi từ app iOS: chỉ gồm những khách vừa đổi và các món đã xoá. */
export function applyNativeUpdateForUser(userId, rawUpdate, excludeWs) {
  const update = cleanNativeUpdate(rawUpdate);
  return mutateState(userId, 'native_update', '', excludeWs, (st) => {
    applyNativeUpdate(st, update);
    if (Array.isArray(update.sessions)) mergeNativeSessions(st, update.sessions);
    if (Array.isArray(update.comments)) {
      const incoming = update.comments
        .filter((c) => c && c.id != null)
        .map((c) => toServerComment(st, { ...c, comment: c.text ?? c.comment ?? '' }));
      mergeIncomingComments(userId, st, incoming);
    }
    const printed = [];
    for (const c of update.customers || []) {
      for (const it of c?.items || []) {
        const id = it?.commentId || it?.id;
        if (id && it.printed) printed.push(id);
      }
    }
    if (Array.isArray(update.printedCommentIds)) printed.push(...update.printedCommentIds);
    markCommentsPrinted(userId, st, printed);
  }, { fromDevice: true });
}

function priceOptionsOf(st) {
  const s = st.settings || {};
  return { multiplier: Number(s.multiplier) || 1000, minPrice: 1, maxPrice: Number(s.maxPrice) || 1e12 };
}

/** Đủ các trường web cần để hiện bình luận. */
export function toServerComment(st, c) {
  const ts = Number(c.ts) || Date.now();
  const text = c.comment || '';
  const price = parsePrice(text, priceOptionsOf(st)) || 0;
  const info = extractProductInfo(text, price);
  return {
    id: String(c.id),
    uniqueId: c.uniqueId || '',
    userId: String(c.userId || ''),
    nickname: c.nickname || c.uniqueId || '',
    comment: text,
    price,
    productName: info.productName,
    qty: info.quantity || 1,
    time: timeOf(ts),
    ts,
    tag: price ? 'Mới' : '',
    sessionId: c.sessionId || '',
    live: c.live || '',
    ...(c.printed ? { printed: true } : {})
  };
}
