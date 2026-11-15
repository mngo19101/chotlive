/** Dữ liệu đồng bộ của từng tài khoản: nạp từ SQLite, giữ trong bộ nhớ, ghi lại khi đổi. */
import {
  DEFAULT_SETTINGS,
  initialCustomers,
  initialOrders,
  initialComments,
  initialSessions,
  initialSalesMetrics
} from '../public/js/store.js';
import * as sqlite from '../db.js';
import { snapCollections } from '../delta.js';
import { cleanState } from '../validate.js';
import { STATES_FILE } from './config.js';
import { db } from './database.js';
import { isDefaultAdminUser, usersDb } from './accounts.js';
import { archiveLegacyFile, readLegacyJson } from './util.js';

/* ============================================================
   Quản lý Trạng Thái Đồng Bộ Theo Từng Tài Khoản
   ============================================================ */
export function createDefaultSharedState(shopName = 'Shop Hoa Hồng') {
  return {
    rev: 1,
    updatedAt: Date.now(),
    isCleanAccount: false,
    settings: { ...DEFAULT_SETTINGS, shopName, voiceEnabled: false },
    seq: 5,
    orders: structuredClone(initialOrders),
    customers: structuredClone(initialCustomers),
    comments: structuredClone(initialComments),
    sessions: structuredClone(initialSessions),
    salesMetrics: structuredClone(initialSalesMetrics),
    accounts: structuredClone(DEFAULT_SETTINGS.accounts),
    prints: [],
    selectedCustomerUniqueId: 'linh.nguyen98',
    activeSessionId: 's_evening'
  };
}

export function createEmptyUserState(shopName = 'Shop mới') {
  const cleanName = String(shopName || 'Shop mới').trim();
  return {
    rev: 1,
    updatedAt: Date.now(),
    isCleanAccount: true,
    settings: {
      ...DEFAULT_SETTINGS,
      shopName: cleanName,
      shopHandle: 'Chưa liên kết TikTok',
      footer: `Cảm ơn bạn đã ủng hộ ${cleanName} ♥`,
      lastUsername: '',
      voiceEnabled: false,
      accounts: []
    },
    seq: 0,
    orders: [],
    customers: [],
    comments: [],
    sessions: [],
    salesMetrics: {
      todayRevenue: 0,
      todayGrowth: '0% so với hôm qua',
      todayCustomers: 0,
      todayNewCustomers: 0,
      monthRevenue: 0,
      monthGrowth: '0% so với tháng trước',
      chartDays: [
        { day: 'T2', amount: 0, height: 4 },
        { day: 'T3', amount: 0, height: 4 },
        { day: 'T4', amount: 0, height: 4 },
        { day: 'T5', amount: 0, height: 4 },
        { day: 'T6', amount: 0, height: 4 },
        { day: 'T7', amount: 0, height: 4 },
        { day: 'CN', amount: 0, height: 4, highlight: true, text: '0đ' }
      ]
    },
    accounts: [],
    prints: [],
    selectedCustomerUniqueId: '',
    activeSessionId: ''
  };
}

const savedSnaps = {};

function loadAllStatesByUser() {
  const fromDb = sqlite.loadStates(db);
  if (Object.keys(fromDb).length) {
    // Dữ liệu sai đã lưu từ trước không được làm sập server mỗi lần có thiết bị mở tài khoản đó.
    for (const [uid, st] of Object.entries(fromDb)) {
      savedSnaps[uid] = snapCollections(st);
      fromDb[uid] = cleanState(st);
    }
    return fromDb;
  }

  const legacy = readLegacyJson(STATES_FILE);
  if (legacy && typeof legacy === 'object' && Object.keys(legacy).length) {
    for (const [uid, st] of Object.entries(legacy)) {
      savedSnaps[uid] = sqlite.saveUserState(db, uid, st, null);
    }
    archiveLegacyFile(STATES_FILE);
    console.log(`[migrate] Đã chuyển dữ liệu của ${Object.keys(legacy).length} tài khoản sang SQLite.`);
    return legacy;
  }
  return {
    u_admin: createDefaultSharedState('Shop Hoa Hồng')
  };
}

export const statesByUserId = loadAllStatesByUser();

for (const [uid, st] of Object.entries(statesByUserId)) {
  if (Array.isArray(st.comments)) sqlite.insertComments(db, uid, st.comments);
}

/* Bình luận giữ tối đa 1 năm; bình luận đã chốt (đã in, có giá, hoặc nằm trong đơn) giữ vĩnh viễn. */
const COMMENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function purgeOldComments() {
  for (const [uid, st] of Object.entries(statesByUserId)) {
    try {
      const keep = new Set();
      for (const list of [st.orders, st.customers]) {
        for (const o of list || []) {
          if (o?.commentId) keep.add(String(o.commentId));
          for (const it of o?.items || []) {
            if (it?.commentId) keep.add(String(it.commentId));
            if (it?.id) keep.add(String(it.id));
          }
        }
      }
      const r = sqlite.purgeOldComments(db, uid, COMMENT_RETENTION_MS, keep);
      if (r.deleted) console.log(`[comments] Đã xóa ${r.deleted} bình luận quá 1 năm của ${uid}`);
      if (r.blocked)
        console.warn(
          `[comments] KHÔNG xóa: ${uid} sẽ mất ${r.blocked}/${r.total} bình luận một lúc, có thể đồng hồ máy hoặc dữ liệu thời gian bị lỗi`
        );
    } catch (err) {
      console.warn('[comments] Lỗi dọn bình luận cũ:', err.message);
    }
  }
}
purgeOldComments();
setInterval(purgeOldComments, 24 * 60 * 60 * 1000).unref();

export function getStateForUser(userId) {
  const key = userId || 'u_admin';
  const u = usersDb.users.find((x) => x.id === key);
  const isDefaultAdmin = isDefaultAdminUser(key);

  if (!statesByUserId[key]) {
    statesByUserId[key] = isDefaultAdmin
      ? createDefaultSharedState(u?.displayName || 'Shop Hoa Hồng')
      : createEmptyUserState(u?.displayName || u?.username || 'Shop mới');
    persistAllStates(key);
  } else if (!isDefaultAdmin && !statesByUserId[key].isCleanAccount) {
    // Chỉ đánh dấu cờ, KHÔNG xoá dữ liệu thật của người dùng (trước đây xoá nhầm dữ liệu
    // của các tài khoản được migrate từ file JSON cũ, do thiếu cờ isCleanAccount).
    statesByUserId[key].isCleanAccount = true;
    persistAllStates(key);
  }
  return statesByUserId[key];
}

let saveStateTimer = null;
const dirtyStates = new Set();
let dirtyAllStates = false;

export function persistAllStates(userId) {
  if (userId) dirtyStates.add(userId);
  else dirtyAllStates = true;
  // Hẹn giờ một lần: bình luận về liên tục không được đẩy lùi việc ghi mãi.
  if (!saveStateTimer) saveStateTimer = setTimeout(flushStates, 150);
}

export function flushStates() {
  clearTimeout(saveStateTimer);
  saveStateTimer = null;
  const ids = dirtyAllStates ? Object.keys(statesByUserId) : [...dirtyStates];
  dirtyAllStates = false;
  dirtyStates.clear();
  for (const id of ids) {
    if (!statesByUserId[id]) continue;
    try {
      savedSnaps[id] = sqlite.saveUserState(db, id, statesByUserId[id], savedSnaps[id] || null);
    } catch (err) {
      console.warn('[sync] Lỗi ghi SQLite (state):', err.message);
      dirtyStates.add(id);
    }
  }
}

/** Bỏ dữ liệu đang giữ trong bộ nhớ của một tài khoản (khi admin xoá tài khoản). */
export function forgetUserState(userId) {
  delete statesByUserId[userId];
  delete savedSnaps[userId];
  dirtyStates.delete(userId);
}
