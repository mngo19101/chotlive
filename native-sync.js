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

const SHIP_STATES = ['ask', 'hold', 'ready', 'exported'];
const numOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const moneyOrNull = (v) => (numOrNull(v) === null ? null : Math.max(0, Math.round(Number(v))));

/**
 * Thông tin giao (`order.ship` của web) gọn và đúng kiểu để app đọc, hoặc null khi đơn chưa có.
 * Cùng hàm dùng để nhận `ship` từ app, nên giá trị lạ không lọt vào dữ liệu.
 */
export function nativeShip(ship) {
  if (!ship || typeof ship !== 'object') return null;
  return {
    state: SHIP_STATES.includes(ship.state) ? ship.state : null,
    pay: ['cod', 'paid', 'shipOnly'].includes(ship.pay) ? ship.pay : null,
    payer: ship.payer === 'sender' || ship.payer === 'receiver' ? ship.payer : null,
    deposit: moneyOrNull(ship.deposit),
    shipFee: moneyOrNull(ship.shipFee),
    codOverride: moneyOrNull(ship.codOverride),
    weightG: moneyOrNull(ship.weightG),
    exportedAt: numOrNull(ship.exportedAt),
    batchId: ship.batchId ? String(ship.batchId) : null,
    // Kích thước kiện (cm), app bắt buộc nhập khi nặng từ 10kg.
    lengthCm: moneyOrNull(ship.lengthCm),
    widthCm: moneyOrNull(ship.widthCm),
    heightCm: moneyOrNull(ship.heightCm)
  };
}

const VTP_TEXT_KEYS = ['vtpCode', 'vtpOldCode', 'vtpService', 'vtpStatusName', 'vtpKind', 'vtpNote', 'vtpError'];
const VTP_NUM_KEYS = ['vtpFee', 'vtpStatus', 'vtpStatusAt', 'vtpErrorAt', 'vtpEventAt'];

/**
 * `ship` gửi xuống app: thêm mã vận đơn và trạng thái Viettel Post do máy chủ ghi.
 * Chỉ dùng chiều server -> app; chiều ngược lại vẫn qua `nativeShip`, nên app không ghi đè được các trường này.
 */
export function nativeShipOut(ship) {
  const out = nativeShip(ship);
  if (!out) return null;
  for (const k of VTP_TEXT_KEYS) if (ship[k]) out[k] = String(ship[k]).slice(0, 300);
  for (const k of VTP_NUM_KEYS) {
    const n = numOrNull(ship[k]);
    if (n !== null) out[k] = Math.round(n);
  }
  return out;
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
        commentId: it.commentId || null,
        // Duyệt đơn / Viettel Post: app giữ `ship` của đơn trên từng món, cùng JSON với web.
        ship: nativeShipOut(o.ship),
        orderCode: o.code || null
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
    // Địa chỉ mới chỉ còn "Phường, Tỉnh": phần trước tỉnh là phường, không phải quận.
    const parts = region.split(',').map((s) => s.trim()).filter(Boolean);
    target.province = parts.pop() || '';
    target.district = parts.length >= 2 ? parts.pop() : '';
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

/** Đơn đã gửi đi, không còn nhận thêm món (cùng quy tắc với `isOpenOrder` của web). */
const isSentOrder = (o) =>
  o.status === 'shipping' || o.status === 'done' || o.ship?.state === 'exported' || Boolean(o.ship?.vtpCode);

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
  const oldName = rec.name;
  if (c.nickname) rec.name = c.nickname;
  if (c.userId && !rec.userId) rec.userId = String(c.userId);
  if (c.uniqueId && !rec.uniqueId) rec.uniqueId = c.uniqueId;
  // App đổi tên khách mà ô "Họ tên" của địa chỉ vẫn mang tên cũ: coi như đổi luôn tên người nhận,
  // để vận đơn không in tên cũ. Người nhận đặt khác tên khách (ví dụ "Mẹ Lan") thì giữ nguyên.
  const renamed = c.nickname && oldName && c.nickname !== oldName;
  const address =
    renamed && c.address && c.address.receiver && c.address.receiver === oldName ? { ...c.address, receiver: c.nickname } : c.address;
  if (address) applyAddress(rec, address);
  else if (renamed && rec.receiver === oldName) rec.receiver = c.nickname;

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
    const sameGroup = state.orders.filter(
      (o) =>
        keyOfRecord(o) === key &&
        o.status !== 'cancelled' &&
        (String(o.id) === groupId ||
          // Đơn web tạo trong cùng phiên live (món chưa có nhóm, chỉ có mã phiên) cũng là đơn của phiên đó.
          (groupId &&
            (o.splitFrom === groupId ||
              (o.items || []).some((x) => x.groupId === groupId || (!x.groupId && x.sessionId === groupId)))))
    );
    // Đơn đã gửi đi (đang giao, đã giao, đã xuất, đã có vận đơn) thì gói hàng và tiền thu hộ đã chốt:
    // món chốt thêm phải sang đơn mới, không thì món đó không được gửi và không được thu tiền.
    let order = sameGroup.find((o) => !isSentOrder(o));
    const split = !order && sameGroup.length > 0;
    if (!order) {
      const ts = Number(it.ts) || Date.now();
      const nick = c.nickname || c.uniqueId || 'Khách Live';
      order = {
        id: stableOrderId(key, split ? `${groupId}|${id}` : groupId || id),
        ...(split ? { splitFrom: groupId } : {}),
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
    const added = mergeNativeItem(null, it);
    // Đơn tách ra: món mang mã nhóm của chính đơn mới, để app không gộp lại vào đơn đã gửi.
    if (order.splitFrom) added.groupId = String(order.id);
    order.items.push(added);
    touched.add(order);
  }

  for (const o of touched) {
    // App gửi `ship` trên từng món của đơn (các món cùng đơn giống nhau): món nào có thì ghi vào đơn.
    // App bản cũ không gửi thì giữ nguyên `ship` đang có trên server.
    const fromApp = [...(Array.isArray(c.items) ? c.items : [])]
      .reverse()
      .find((it) => it && it.ship && typeof it.ship === 'object' && (o.items || []).some((x) => String(x.id) === String(it.id)));
    const prev = o.ship || {};
    const prevStatus = o.status;
    // Trạng thái máy chủ giữ nguyên dù app gửi gì: null = theo app.
    let keepStatus = null;
    if (fromApp) {
      const ship = nativeShip(fromApp.ship);
      for (const k of Object.keys(ship)) if (ship[k] === null) delete ship[k];
      // Mã vận đơn / trạng thái Viettel Post do máy chủ ghi, app không gửi lên: giữ lại.
      const vtpKeep = Object.fromEntries(Object.entries(prev).filter(([k]) => k.startsWith('vtp')));
      o.ship = { ...vtpKeep, ...ship };
      const appCode = String(fromApp.ship.vtpCode || '');
      if (prev.vtpCode) {
        // Đơn đã có vận đơn: app (chưa kịp nhận bản mới) không được kéo đơn về Chờ gửi.
        o.ship.state = 'exported';
        if (prev.exportedAt) o.ship.exportedAt = prev.exportedAt;
        if (prev.batchId) o.ship.batchId = prev.batchId;
        keepStatus = ['shipping', 'done'].includes(prevStatus) ? prevStatus : 'shipping';
      } else if (prev.vtpOldCode && appCode && appCode === prev.vtpOldCode) {
        // Vận đơn vừa bị huỷ mà app còn giữ bản cũ: giữ đơn ở Chờ gửi như máy chủ.
        o.ship.state = prev.state || 'ready';
        delete o.ship.exportedAt;
        delete o.ship.batchId;
        keepStatus = prevStatus;
      }
    }
    recalcOrder(o);
    let status = orderStatusFromItems(o.items, o.status);
    if (keepStatus && prev.vtpCode) {
      // Đang giao ↔ Đã giao bấm tay trên app vẫn được nhận; về Chờ gửi thì không.
      if (!['shipping', 'done'].includes(status)) status = keepStatus;
    } else if (keepStatus) {
      status = keepStatus;
    }
    o.status = status;
    if (status !== 'new') o.printCount = Math.max(Number(o.printCount) || 0, 1);
    o.ts = Math.max(Number(o.ts) || 0, ...o.items.map((x) => Number(x.ts) || 0));
    o.timeStr = timeOf(o.ts);
    if (c.nickname) {
      if (renamed && o.receiver === oldName) o.receiver = c.nickname;
      o.nickname = c.nickname;
    }
    if (address) applyAddress(o, address);
  }
  if (address || renamed) {
    for (const o of state.orders) {
      if (keyOfRecord(o) !== key) continue;
      if (renamed && o.receiver === oldName) o.receiver = c.nickname;
      if (address) applyAddress(o, address);
    }
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
