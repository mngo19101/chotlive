/**
 * Chuyển dữ liệu giữa server (định dạng của web: orders + customers) và app iOS
 * (mỗi khách giữ danh sách món, món cùng groupId là một đơn).
 *
 * Quy tắc đồng bộ:
 * - Server luôn gửi toàn bộ khách + phiên + ID TikTok cho app (`toNativeSnapshot`).
 * - App chỉ gửi những khách vừa đổi trên máy kèm danh sách món đã xoá (`applyNativeUpdate`),
 *   nên đơn sửa trên web ở khách khác không bị app ghi đè.
 * - Trường chỉ web mới có (mã đơn, phí ship, giảm giá...) được giữ nguyên.
 */
import crypto from 'node:crypto';

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const hmFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const dmFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit' });
const dmyFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hour12: false });
const dateKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: '2-digit', month: '2-digit', day: '2-digit' });

/** Mốc thời gian sai (quá lớn, không phải số) làm Intl báo lỗi: dùng giờ hiện tại thay thế. */
function safeDate(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export const timeOf = (ts) => hmFormat.format(safeDate(ts));
export const dayMonthOf = (ts) => dmFormat.format(safeDate(ts));

export function sessionName(ts) {
  const h = Number(hourFormat.format(safeDate(ts))) % 24;
  if (h >= 5 && h < 11) return 'Phiên sáng';
  if (h >= 11 && h < 14) return 'Phiên trưa';
  if (h >= 14 && h < 18) return 'Phiên chiều';
  return 'Phiên tối';
}

export function durationText(fromTs, toTs) {
  const mins = Math.max(Math.floor((toTs - fromTs) / 60000), 0);
  return mins >= 60 ? `${Math.floor(mins / 60)}g ${mins % 60}p` : `${mins}p`;
}

const lower = (s) => String(s ?? '').trim().toLowerCase();
/** App đọc các trường này là số nguyên; một giá trị lẻ sẽ làm hỏng cả gói dữ liệu. */
const toInt = (v) => Math.round(Number(v) || 0);

/** Cùng công thức với `Store.key` bên iOS. */
export function customerKey(uniqueId, userId, nickname = '') {
  const u = lower(uniqueId);
  if (u) return u;
  if (userId) return String(userId);
  return nickname ? `manual-${lower(nickname)}` : '';
}

const keyOfRecord = (r) => customerKey(r?.uniqueId, r?.userId, r?.nickname || r?.name);

function findCustomer(customers, key, userId) {
  return customers.find(
    (c) => keyOfRecord(c) === key || (userId && String(c.userId || '') === String(userId))
  );
}

function codeFromName(name = '') {
  const m = String(name).match(/^m[ãa]\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function nativeAddress(rec) {
  if (!rec) return null;
  const street = rec.street || rec.address || '';
  const region = [rec.ward, rec.district, rec.province].filter(Boolean).join(', ');
  const phone = rec.phone || '';
  const note = rec.deliveryNote || '';
  if (!street && !region && !phone && !note) return null;
  return { receiver: rec.receiver || rec.name || rec.nickname || '', phone, street, region, note };
}

/* ------------------------------ Server -> app ------------------------------ */

export function nativeSession(s) {
  return {
    id: String(s.id),
    tiktok: s.tiktok || '',
    start: Number(s.startTs),
    end: s.endTs ? Number(s.endTs) : null,
    commentCount: toInt(s.commentCount),
    lastActivity: s.lastActivityTs ? Number(s.lastActivityTs) : null
  };
}

export function nativeComment(c) {
  return {
    id: String(c.id),
    uniqueId: c.uniqueId || '',
    userId: String(c.userId || ''),
    nickname: c.nickname || c.uniqueId || '',
    text: c.comment || '',
    ts: Number(c.ts) || 0,
    price: toInt(c.price),
    printed: Boolean(c.printed),
    sessionId: c.sessionId || null
  };
}

function nativeAccount(a) {
  // Bản cũ có thể đã lưu nguyên link phiên live làm tên: chỉ lấy phần sau dấu @ cuối.
  const raw = String(a.handle || a.uniqueId || a.name || '').trim();
  const uniqueId = raw.slice(raw.lastIndexOf('@') + 1).split(/[/?#]/)[0];
  return { id: lower(uniqueId), uniqueId, displayName: a.name || uniqueId };
}

export function toNativeSnapshot(state) {
  const byKey = new Map();
  const ensure = (key, base) => {
    let c = byKey.get(key);
    if (!c) {
      c = {
        id: key,
        uniqueId: base.uniqueId || '',
        userId: String(base.userId || ''),
        nickname: base.nickname || base.name || base.uniqueId || '',
        items: [],
        address: null
      };
      byKey.set(key, c);
    }
    if (!c.userId && base.userId) c.userId = String(base.userId);
    return c;
  };

  for (const rec of state.customers || []) {
    const key = keyOfRecord(rec);
    if (!key) continue;
    const c = ensure(key, rec);
    c.address = nativeAddress(rec);
  }

  for (const o of state.orders || []) {
    if (o.status === 'cancelled') continue;
    const key = keyOfRecord(o);
    if (!key) continue;
    const c = ensure(key, o);
    if (!c.address) c.address = nativeAddress(o);
    const status = o.status || 'new';
    for (const it of o.items || []) {
      c.items.push({
        id: String(it.id),
        comment: it.comment || '',
        price: toInt(it.price),
        ts: Number(it.ts || o.ts) || 0,
        printed: Boolean(it.printed) || status !== 'new' || (o.printCount || 0) > 0,
        delivered: status === 'done',
        shipping: status === 'shipping',
        qty: toInt(it.qty) || 1,
        sessionId: it.sessionId || null,
        groupId: it.groupId || String(o.id),
        code: it.code || codeFromName(it.name),
        commentId: it.commentId || null
      });
    }
  }

  const accounts = (state.accounts || []).map(nativeAccount).filter((a) => a.id);
  const active = (state.accounts || []).find((a) => a.active);

  return {
    customers: [...byKey.values()],
    sessions: (state.sessions || []).filter((s) => Number(s.startTs) > 0).map(nativeSession),
    accounts,
    activeAccountId: active ? nativeAccount(active).id : null,
    printedCommentIds: (state.comments || []).filter((c) => c.printed).map((c) => String(c.id))
  };
}

/* ------------------------------ App -> server ------------------------------ */

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/** Mã đơn ổn định, gửi lại nhiều lần vẫn là một đơn. */
function stableOrderId(customerId, groupId) {
  return 'o_' + crypto.createHash('sha1').update(`${customerId}|${groupId}`).digest('hex').slice(0, 16);
}

function nextOrderCode(state, ts) {
  state.seq = (Number(state.seq) || 0) + 1;
  const [yy, mm, dd] = dateKeyFormat.format(safeDate(ts)).split('-');
  return `HD${yy}${mm}${dd}${String(state.seq).padStart(2, '0')}`;
}

function orderStatusFromItems(items, previous) {
  if (!items.length) return previous || 'new';
  if (items.every((i) => i.delivered)) return 'done';
  if (items.every((i) => i.shipping || i.delivered)) return 'shipping';
  if (items.every((i) => i.printed)) return 'printed';
  return 'new';
}

function recalcOrder(o) {
  o.items = o.items || [];
  const subtotal = o.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
  if (o.subtotal !== undefined) o.subtotal = subtotal;
  o.total = Math.max(0, subtotal + (Number(o.shippingFee) || 0) - (Number(o.discount) || 0));
}

function recalcCustomerTotals(state, rec) {
  const key = keyOfRecord(rec);
  const mine = (state.orders || []).filter((o) => o.status !== 'cancelled' && keyOfRecord(o) === key);
  rec.orderCount = mine.length;
  rec.totalSpent = mine.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const last = mine.reduce((m, o) => Math.max(m, Number(o.ts) || 0), 0);
  if (last) {
    rec.lastBuy = dayMonthOf(last);
    rec.timeDesc = timeOf(last);
  }
}

function applyAddress(target, a) {
  if (!a) return;
  if (a.receiver) target.receiver = a.receiver;
  target.phone = a.phone || '';
  target.street = a.street || '';
  const region = String(a.region || '');
  if (region !== [target.ward, target.district, target.province].filter(Boolean).join(', ')) {
    // App gom phường/quận/tỉnh vào một ô: giữ theo đúng thứ tự khi tách lại.
    const parts = region.split(',').map((s) => s.trim()).filter(Boolean);
    target.province = parts.pop() || '';
    target.district = parts.pop() || '';
    target.ward = parts.join(', ');
  }
  target.address = [target.street, region].filter(Boolean).join(', ');
  target.deliveryNote = a.note || '';
}

function mergeNativeItem(existing, it) {
  const code = it.code || null;
  return {
    ...existing,
    id: String(it.id),
    commentId: it.commentId || existing?.commentId || '',
    name: code ? `Mã ${code}` : existing?.name || it.comment || 'Sản phẩm',
    code,
    price: Number(it.price) || 0,
    qty: Number(it.qty) || 1,
    comment: it.comment || '',
    ts: Number(it.ts) || existing?.ts || Date.now(),
    timeStr: timeOf(Number(it.ts) || existing?.ts || Date.now()),
    sessionId: it.sessionId || existing?.sessionId || null,
    groupId: it.groupId || existing?.groupId || null,
    printed: Boolean(it.printed),
    delivered: Boolean(it.delivered),
    shipping: Boolean(it.shipping)
  };
}

function applyNativeCustomer(state, c) {
  const key = customerKey(c.uniqueId, c.userId, c.nickname) || String(c.id || '');
  if (!key) return null;
  state.orders = state.orders || [];
  state.customers = state.customers || [];

  let rec = findCustomer(state.customers, key, c.userId);
  if (!rec) {
    rec = {
      id: newId('c_'),
      uniqueId: c.uniqueId || '',
      userId: String(c.userId || ''),
      name: c.nickname || c.uniqueId || 'Khách mới',
      phone: '',
      totalSpent: 0,
      orderCount: 0,
      tag: 'Mới',
      lastBuy: '',
      timeDesc: '',
      avatarWarm: false
    };
    state.customers.unshift(rec);
  }
  if (c.nickname) rec.name = c.nickname;
  if (c.userId && !rec.userId) rec.userId = String(c.userId);
  if (c.uniqueId && !rec.uniqueId) rec.uniqueId = c.uniqueId;
  if (c.address) applyAddress(rec, c.address);

  const touched = new Set();
  for (const it of Array.isArray(c.items) ? c.items : []) {
    if (!it || it.id == null) continue;
    const id = String(it.id);
    const groupId = it.groupId ? String(it.groupId) : '';
    const holder = state.orders.find((o) => (o.items || []).some((x) => String(x.id) === id));
    if (holder) {
      const i = holder.items.findIndex((x) => String(x.id) === id);
      holder.items[i] = mergeNativeItem(holder.items[i], it);
      touched.add(holder);
      continue;
    }
    let order = state.orders.find(
      (o) =>
        keyOfRecord(o) === key &&
        o.status !== 'cancelled' &&
        (String(o.id) === groupId || (groupId && (o.items || []).some((x) => x.groupId === groupId)))
    );
    if (!order) {
      const ts = Number(it.ts) || Date.now();
      const nick = c.nickname || c.uniqueId || 'Khách Live';
      order = {
        id: stableOrderId(key, groupId || id),
        code: nextOrderCode(state, ts),
        uniqueId: c.uniqueId || '',
        userId: String(c.userId || ''),
        nickname: nick,
        receiver: rec.receiver || nick,
        phone: rec.phone || '',
        address: rec.address || '',
        status: 'new',
        ts,
        timeStr: timeOf(ts),
        dateStr: dayMonthOf(ts),
        createdDesc: `Tạo lúc ${timeOf(ts)} · ${dmyFormat.format(safeDate(ts))}`,
        printCount: 0,
        avatarWarm: true,
        items: [],
        total: 0
      };
      state.orders.unshift(order);
    }
    order.items.push(mergeNativeItem(null, it));
    touched.add(order);
  }

  for (const o of touched) {
    recalcOrder(o);
    const status = orderStatusFromItems(o.items, o.status);
    o.status = status;
    if (status !== 'new') o.printCount = Math.max(Number(o.printCount) || 0, 1);
    o.ts = Math.max(Number(o.ts) || 0, ...o.items.map((x) => Number(x.ts) || 0));
    o.timeStr = timeOf(o.ts);
    if (c.nickname) o.nickname = c.nickname;
    if (c.address) applyAddress(o, c.address);
  }
  if (c.address) {
    for (const o of state.orders) if (keyOfRecord(o) === key) applyAddress(o, c.address);
  }
  recalcCustomerTotals(state, rec);
  return rec;
}

function removeItems(state, ids) {
  if (!ids.size) return;
  const touchedKeys = new Set();
  state.orders = (state.orders || []).filter((o) => {
    const before = (o.items || []).length;
    o.items = (o.items || []).filter((it) => !ids.has(String(it.id)));
    if (o.items.length === before) return true;
    touchedKeys.add(keyOfRecord(o));
    recalcOrder(o);
    return o.items.length > 0;
  });
  // Khách không còn đơn và chưa có thông tin gì thì bỏ luôn, giống hành vi bên app.
  state.customers = (state.customers || []).filter((rec) => {
    if (!touchedKeys.has(keyOfRecord(rec))) return true;
    recalcCustomerTotals(state, rec);
    return rec.orderCount > 0 || rec.phone || rec.address || rec.street;
  });
}

function applyNativeAccounts(state, update) {
  const removed = new Set((update.deletedAccountIds || []).map(lower));
  state.accounts = (state.accounts || []).filter((a) => !removed.has(nativeAccount(a).id));
  for (const a of update.accounts || []) {
    const id = lower(a?.uniqueId || a?.id);
    if (!id || removed.has(id)) continue;
    const existing = state.accounts.find((x) => nativeAccount(x).id === id);
    const name = a.displayName || a.uniqueId;
    if (existing) {
      if (a.displayName) existing.name = a.displayName;
    } else {
      state.accounts.push({
        id: newId('acc_'),
        name,
        handle: `@${a.uniqueId || id}`,
        avatar: String(name).slice(0, 2).toUpperCase(),
        active: false,
        time: 'vừa thêm'
      });
    }
  }
  if (update.activeAccountId !== undefined && update.activeAccountId !== null) {
    const activeId = lower(update.activeAccountId);
    if (state.accounts.some((a) => nativeAccount(a).id === activeId)) {
      for (const a of state.accounts) a.active = nativeAccount(a).id === activeId;
    }
  }
  if (state.settings) state.settings.accounts = state.accounts;
}

/** Áp thay đổi từ app vào dữ liệu server. Bình luận và phiên do nơi gọi xử lý vì chúng có bảng riêng. */
export function applyNativeUpdate(state, update) {
  const deleted = new Set((update.deletedItemIds || []).map(String));
  for (const c of update.customers || []) {
    if (!c) continue;
    applyNativeCustomer(state, {
      ...c,
      items: (c.items || []).filter((it) => it && !deleted.has(String(it.id)))
    });
  }
  removeItems(state, deleted);
  if (update.accounts || update.deletedAccountIds || update.activeAccountId) {
    applyNativeAccounts(state, update);
  }
}

/** Phiên có sẵn trên app từ trước khi đồng bộ. Không đè phiên server đang ghi. */
export function mergeNativeSessions(state, sessions = []) {
  state.sessions = state.sessions || [];
  let changed = false;
  for (const s of sessions) {
    if (!s || !s.id || !s.start) continue;
    if (state.sessions.some((x) => String(x.id) === String(s.id))) continue;
    const start = Number(s.start);
    const end = s.end ? Number(s.end) : Number(s.lastActivity) || start;
    state.sessions.push({
      id: String(s.id),
      tiktok: s.tiktok || '',
      name: sessionName(start),
      startTs: start,
      endTs: end,
      isLive: false,
      timeStr: timeOf(start),
      endStr: timeOf(end),
      duration: durationText(start, end),
      commentCount: Number(s.commentCount) || 0,
      priceCount: 0,
      lastActivityTs: s.lastActivity ? Number(s.lastActivity) : end
    });
    changed = true;
  }
  if (changed) state.sessions.sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
  return changed;
}
