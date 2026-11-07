/**
 * Quản lý dữ liệu Susu ChotDon & Đồng bộ Thời gian thực (Web <-> iOS IPA App)
 * Hỗ trợ: Lưu CarID TikTok, Gom đơn theo khách hàng, Lưu danh sách từng sản phẩm đã mua,
 * và đồng bộ 2 chiều thời gian thực qua Server.
 */
import { TRACKED, countPending, emptyPending, overlayPending, recordChanges, snapshotOf } from './pending.js';

const KEY = 'susu_chotdon.v5';
const PENDING_KEY = `${KEY}.pending`;

export const DEFAULT_SETTINGS = {
  shopName: 'Shop Hoa Hồng',
  shopHandle: '@shophoahong.live',
  shopSub: 'Đơn hàng Livestream TikTok',
  paper: '80', // 80mm hoặc 58mm
  fontScale: '1',
  showNickname: true,
  showTime: true,
  multiplier: '1000',
  minPrice: 1,
  maxPrice: 50000000,
  printerMode: 'virtual',
  sound: true,
  voiceEnabled: false,
  autoMerge: true,
  dedupe: true,
  autoPrint: false,
  lastUsername: 'shophoahong.live',
  serverUrl: '', // URL máy chủ đồng bộ khi chạy trên App IPA (trống = tự nhận origin hoặc URL đã cấu hình)
  accounts: [
    { id: 'acc1', name: 'Shop Hoa Hồng', handle: '@shophoahong.live', active: true, avatar: 'SH', time: 'hôm nay 19:30' },
    { id: 'acc2', name: 'Kho Hàng Linh', handle: '@khohanglinh', active: false, avatar: 'KL', time: '23/10' }
  ]
};

// Tạo mã đơn HDyymmddxx
export function generateOrderCode(seq) {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `HD${yy}${mm}${dd}${String(seq).padStart(2, '0')}`;
}

export const initialCustomers = [
  {
    id: 'c1',
    uniqueId: 'linh.nguyen98',
    userId: '71928419201',
    name: 'Linh Nguyễn',
    phone: '0905 123 456',
    address: '25 Lê Lợi, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
    street: '25 Lê Lợi',
    ward: 'Phường Bến Nghé',
    district: 'Quận 1',
    province: 'TP. Hồ Chí Minh',
    deliveryNote: 'Giao giờ hành chính, gọi trước khi giao',
    totalSpent: 3450000,
    orderCount: 12,
    tag: 'Mua nhiều',
    lastBuy: '25/10',
    timeDesc: '20:42 nay',
    avatarWarm: true
  },
  {
    id: 'c2',
    uniqueId: 'hoatran_shop',
    userId: '72039481922',
    name: 'Hoa Trần',
    phone: '0912 345 678',
    address: '12 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh',
    street: '12 Nguyễn Trãi',
    ward: 'Phường Bến Thành',
    district: 'Quận 1',
    province: 'TP. Hồ Chí Minh',
    deliveryNote: 'Gọi trước khi giao 15 phút',
    totalSpent: 280000,
    orderCount: 1,
    tag: 'Mới',
    lastBuy: '25/10',
    timeDesc: '20:15 nay',
    avatarWarm: false
  },
  {
    id: 'c3',
    uniqueId: 'maipham.97',
    userId: '72538194012',
    name: 'Mai Phạm',
    phone: '0935 888 999',
    address: '88 Trần Hưng Đạo, Quận 1, TP. Hồ Chí Minh',
    street: '88 Trần Hưng Đạo',
    ward: 'Phường Phạm Ngũ Lão',
    district: 'Quận 1',
    province: 'TP. Hồ Chí Minh',
    totalSpent: 1920000,
    orderCount: 7,
    tag: '',
    lastBuy: '25/10',
    timeDesc: '13:20 nay',
    avatarWarm: false
  },
  {
    id: 'c4',
    uniqueId: 'thaovy.ht',
    userId: '73194820194',
    name: 'Thảo Vy',
    phone: '0977 111 222',
    address: 'Thành phố Huế',
    totalSpent: 860000,
    orderCount: 4,
    tag: '',
    lastBuy: '24/10',
    timeDesc: '21:05 hôm qua',
    avatarWarm: true
  },
  {
    id: 'c5',
    uniqueId: 'ngocanh_hue',
    userId: '74198273619',
    name: 'Ngọc Anh',
    phone: '0908 777 666',
    address: 'Thành phố Huế',
    totalSpent: 2140000,
    orderCount: 9,
    tag: '',
    lastBuy: '24/10',
    timeDesc: '20:30 hôm qua',
    avatarWarm: false
  },
  {
    id: 'c6',
    uniqueId: 'bichngoc.mua',
    userId: '75192837482',
    name: 'Bích Ngọc',
    phone: '0944 333 222',
    address: 'Thành phố Đà Nẵng',
    totalSpent: 640000,
    orderCount: 3,
    tag: '',
    lastBuy: '23/10',
    timeDesc: 'T6 23/10',
    avatarWarm: true
  },
  {
    id: 'c7',
    uniqueId: 'kimchi.shop',
    userId: '76192837401',
    name: 'Kim Chi',
    phone: '0933 555 444',
    address: 'TP. Hồ Chí Minh',
    totalSpent: 390000,
    orderCount: 1,
    tag: 'Đơn mới',
    lastBuy: '25/10',
    timeDesc: '19:58 nay',
    avatarWarm: true
  }
];

export const initialOrders = [
  {
    id: 'o_linh_nguyen',
    code: 'HD26102501',
    uniqueId: 'linh.nguyen98',
    userId: '71928419201',
    nickname: 'Linh Nguyễn',
    receiver: 'Linh Nguyễn',
    phone: '0905 123 456',
    status: 'new',
    ts: Date.now() - 15 * 60 * 1000,
    timeStr: '20:42',
    dateStr: '25/10',
    createdDesc: 'Tạo lúc 20:42 · CN 25/10/2026',
    street: '25 Lê Lợi',
    ward: 'Phường Bến Nghé',
    district: 'Quận 1',
    province: 'TP. Hồ Chí Minh',
    address: '25 Lê Lợi, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
    printCount: 0,
    avatarWarm: true,
    items: [
      { id: 'it_150', name: 'Mã 150', code: '150', price: 150000, qty: 1, comment: 'Mã 150 chốt nha shop ơi', timeStr: '20:36' },
      { id: 'it_120', name: 'Mã 120', code: '120', price: 120000, qty: 1, comment: 'Chốt 120 với 180 nữa ạ', timeStr: '20:40' },
      { id: 'it_180', name: 'Mã 180', code: '180', price: 180000, qty: 1, comment: 'Chốt 120 với 180 nữa ạ', timeStr: '20:40' }
    ],
    total: 450000
  },
  {
    id: 'o_hoa_tran',
    code: 'HD26102502',
    uniqueId: 'hoatran_shop',
    userId: '72039481922',
    nickname: 'Hoa Trần',
    receiver: 'Hoa Trần',
    phone: '0912 345 678',
    status: 'new',
    ts: Date.now() - 42 * 60 * 1000,
    timeStr: '20:15',
    dateStr: '25/10',
    createdDesc: 'Tạo lúc 20:15 · CN 25/10/2026',
    street: '12 Nguyễn Trãi',
    ward: 'Phường Bến Thành',
    district: 'Quận 1',
    province: 'TP. Hồ Chí Minh',
    address: '12 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh',
    printCount: 0,
    avatarWarm: false,
    items: [
      { id: 'it_280', name: 'Mã 280', code: '280', price: 280000, qty: 1, comment: 'Mã 280 chốt ạ', timeStr: '20:15' }
    ],
    total: 280000
  },
  {
    id: 'o_kim_chi',
    code: 'HD26102503',
    uniqueId: 'kimchi.shop',
    userId: '76192837401',
    nickname: 'Kim Chi',
    receiver: 'Kim Chi',
    phone: '0933 555 444',
    status: 'new',
    ts: Date.now() - 59 * 60 * 1000,
    timeStr: '19:58',
    dateStr: '25/10',
    createdDesc: 'Tạo lúc 19:58 · CN 25/10/2026',
    address: 'TP. Hồ Chí Minh',
    printCount: 0,
    avatarWarm: true,
    items: [
      { id: 'it_130', name: 'Mã 130', code: '130', price: 195000, qty: 2, comment: 'Mã 130 giá sao shop ơi', timeStr: '19:58' }
    ],
    total: 390000
  },
  {
    id: 'o_mai_pham',
    code: 'HD26102504',
    uniqueId: 'maipham.97',
    userId: '72538194012',
    nickname: 'Mai Phạm',
    receiver: 'Mai Phạm',
    phone: '0935 888 999',
    status: 'printed',
    ts: Date.now() - 7 * 3600 * 1000,
    timeStr: '13:20',
    dateStr: '25/10',
    createdDesc: 'Tạo lúc 13:20 · CN 25/10/2026',
    address: '88 Trần Hưng Đạo, Quận 1, TP. Hồ Chí Minh',
    printCount: 1,
    avatarWarm: false,
    items: [
      { id: 'it_170', name: 'Mã 170', code: '170', price: 170000, qty: 2, comment: 'Chốt 2 áo mã 170 nha shop', timeStr: '13:20' }
    ],
    total: 340000
  },
  // Lịch sử các đơn trước của Linh Nguyễn để hiển thị trong hồ sơ (Screen 9)
  {
    id: 'o_linh_prev_1',
    code: 'HD26102101',
    uniqueId: 'linh.nguyen98',
    userId: '71928419201',
    nickname: 'Linh Nguyễn',
    status: 'done',
    ts: Date.now() - 4 * 86400 * 1000,
    timeStr: '19:30',
    dateStr: '21/10',
    createdDesc: 'Tạo lúc 19:30 · T4 21/10/2026',
    items: [
      { id: 'it_p1a', name: 'Mã 150', price: 150000, qty: 1 },
      { id: 'it_p1b', name: 'Mã 160', price: 160000, qty: 1 },
      { id: 'it_p1c', name: 'Mã 150', price: 150000, qty: 1 },
      { id: 'it_p1d', name: 'Mã 160', price: 160000, qty: 1 }
    ],
    total: 620000
  },
  {
    id: 'o_linh_prev_2',
    code: 'HD26101801',
    uniqueId: 'linh.nguyen98',
    userId: '71928419201',
    nickname: 'Linh Nguyễn',
    status: 'done',
    ts: Date.now() - 7 * 86400 * 1000,
    timeStr: '20:15',
    dateStr: '18/10',
    createdDesc: 'Tạo lúc 20:15 · CN 18/10/2026',
    items: [
      { id: 'it_p2a', name: 'Mã 150', price: 150000, qty: 1 },
      { id: 'it_p2b', name: 'Mã 160', price: 160000, qty: 1 }
    ],
    total: 310000
  },
  {
    id: 'o_linh_prev_3',
    code: 'HD26101401',
    uniqueId: 'linh.nguyen98',
    userId: '71928419201',
    nickname: 'Linh Nguyễn',
    status: 'done',
    ts: Date.now() - 11 * 86400 * 1000,
    timeStr: '21:00',
    dateStr: '14/10',
    createdDesc: 'Tạo lúc 21:00 · T4 14/10/2026',
    items: [
      { id: 'it_p3a', name: 'Mã 150', price: 150000, qty: 2 },
      { id: 'it_p3b', name: 'Mã 160', price: 160000, qty: 3 }
    ],
    total: 780000
  }
];

export const initialComments = [
  { id: 'c_live_1', uniqueId: 'kimchi.shop', nickname: 'Kim Chi', comment: 'Mã 130 giá sao shop ơi', time: '19:58', price: 0, tag: '' },
  { id: 'c_live_2', uniqueId: 'hoatran_shop', nickname: 'Hoa Trần', comment: 'Mã 280 chốt ạ', time: '20:15', price: 280000, productName: 'Mã 280', tag: 'Mới' },
  { id: 'c_live_3', uniqueId: 'linh.nguyen98', nickname: 'Linh Nguyễn', comment: 'Mã 150 chốt nha shop ơi', time: '20:36', price: 150000, productName: 'Mã 150', tag: 'Mua nhiều' },
  { id: 'c_live_4', uniqueId: 'thaovy.ht', nickname: 'Thảo Vy', comment: 'Shop ship Huế mấy ngày vậy ạ', time: '20:38', price: 0, tag: '' },
  { id: 'c_live_5', uniqueId: 'linh.nguyen98', nickname: 'Linh Nguyễn', comment: 'Chốt 120 với 180 nữa ạ', time: '20:40', price: 300000, productName: 'Mã 120, Mã 180', tag: 'Mua nhiều' },
  { id: 'c_live_6', uniqueId: 'ngocanh_hue', nickname: 'Ngọc Anh', comment: 'Xinh quá shop ơi', time: '20:42', price: 0, tag: '' }
];

export const initialSessions = [
  {
    id: 's_evening',
    name: 'Phiên tối',
    isLive: true,
    timeStr: '19:30',
    duration: '1g 25p',
    commentsCount: 214,
    guestsCount: 22,
    ordersCount: 31,
    handle: '@shophoahong.live'
  },
  {
    id: 's_noon',
    name: 'Phiên trưa',
    isLive: false,
    timeStr: '12:00',
    endStr: '13:40',
    duration: '1g 40p',
    commentsCount: 96,
    guestsCount: 15,
    ordersCount: 19,
    handle: '@shophoahong.live'
  }
];

export const initialSalesMetrics = {
  todayRevenue: 4860000,
  todayGrowth: '+18% so với hôm qua',
  todayCustomers: 37,
  todayNewCustomers: 9,
  monthRevenue: 68450000,
  monthGrowth: '+12% so với tháng 9',
  chartDays: [
    { day: 'T2', amount: 2.1, height: 42 },
    { day: 'T3', amount: 3.2, height: 55 },
    { day: 'T4', amount: 1.8, height: 32 },
    { day: 'T5', amount: 4.5, height: 74 },
    { day: 'T6', amount: 3.4, height: 52 },
    { day: 'T7', amount: 5.6, height: 88 },
    { day: 'CN', amount: 4.86, height: 72, highlight: true, text: '4,86tr' }
  ]
};

const initialTags = ['VIP', 'Khách quen', 'Khách sỉ', 'Mua nhiều', 'Mới', 'Bom hàng'];

function load() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && Array.isArray(raw.orders)) {
        const res = {
          isCleanAccount: Boolean(raw.isCleanAccount),
          settings: { ...DEFAULT_SETTINGS, ...raw.settings },
          seq: typeof raw.seq === 'number' ? raw.seq : 5,
          orders: Array.isArray(raw.orders) ? raw.orders : initialOrders,
          customers: Array.isArray(raw.customers) ? raw.customers : initialCustomers,
          comments: Array.isArray(raw.comments) ? raw.comments : [...initialComments],
          sessions: Array.isArray(raw.sessions) ? raw.sessions : [...initialSessions],
          salesMetrics: raw.salesMetrics || { ...initialSalesMetrics },
          tags: raw.tags || initialTags,
          prints: raw.prints || [],
          accounts: Array.isArray(raw.accounts) ? raw.accounts : DEFAULT_SETTINGS.accounts,
          selectedCustomerUniqueId:
            typeof raw.selectedCustomerUniqueId === 'string' ? raw.selectedCustomerUniqueId : 'linh.nguyen98',
          activeSessionId: typeof raw.activeSessionId === 'string' ? raw.activeSessionId : 's_evening'
        };
        res.settings.voiceEnabled = false;
        return res;
      }
    }
  } catch {}
  return {
    isCleanAccount: false,
    settings: { ...DEFAULT_SETTINGS, voiceEnabled: false },
    seq: 5,
    orders: [...initialOrders],
    customers: [...initialCustomers],
    comments: [...initialComments],
    sessions: [...initialSessions],
    salesMetrics: { ...initialSalesMetrics },
    tags: [...initialTags],
    prints: [],
    accounts: [...DEFAULT_SETTINGS.accounts],
    selectedCustomerUniqueId: 'linh.nguyen98',
    activeSessionId: 's_evening'
  };
}

export const state = load();

/* ============================================================
   Hooks Đồng Bộ Thời Gian Thực (Web <-> Server <-> App IPA)
   ============================================================ */
let syncPushHandler = null;
let remoteChangeListeners = [];
let isApplyingRemote = false;
let ownerOf = () => '';

/* ------- Thay đổi trên máy mà server chưa xác nhận đã nhận ------- */
function loadPending() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
      if (raw && raw.changes && typeof raw.changes === 'object') return raw;
    }
  } catch {}
  return emptyPending();
}

let pending = loadPending();
let pendingVersion = 0;
let baseSnapshot = snapshotOf(state);

function persistPending() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (countPending(pending)) localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else localStorage.removeItem(PENDING_KEY);
  } catch {}
}

function recordLocalChanges() {
  const owner = ownerOf();
  const next = snapshotOf(state);
  if (owner) {
    if (pending.owner !== owner) pending = emptyPending(owner);
    if (recordChanges(pending, baseSnapshot, next)) {
      pendingVersion += 1;
      persistPending();
    }
  }
  baseSnapshot = next;
}

export const pendingChangeCount = () => countPending(pending);
export const getPendingVersion = () => pendingVersion;
export const getPendingOwner = () => pending.owner;

export function clearPendingChanges() {
  pending = emptyPending(pending.owner);
  pendingVersion += 1;
  persistPending();
}

/** Server đã nhận. Có `version` thì chỉ xoá nếu từ lúc gửi tới giờ không phát sinh thêm thay đổi. */
export function markPendingSynced(version = pendingVersion) {
  if (version === pendingVersion) clearPendingChanges();
}

/** `owner` cho biết thay đổi đang thuộc tài khoản nào; chưa đăng nhập thì không ghi nhận. */
export function registerSyncPushHandler(fn, owner) {
  syncPushHandler = fn;
  if (owner) ownerOf = owner;
}

export function onRemoteStateApplied(fn) {
  remoteChangeListeners.push(fn);
}

export function applyRemoteState(remote, action = 'remote') {
  if (!remote || typeof remote !== 'object') return;
  // Thay đổi vừa bấm mà chưa tới lượt ghi cũng phải được giữ lại trước khi nhận dữ liệu mới.
  if (saveTimer) recordLocalChanges();
  if (action === 'reset') clearPendingChanges();
  const hadPending = countPending(pending) > 0;
  isApplyingRemote = true;
  try {
    if (typeof remote.isCleanAccount === 'boolean') state.isCleanAccount = remote.isCleanAccount;
    for (const coll of TRACKED) {
      if (Array.isArray(remote[coll])) state[coll] = overlayPending(coll, remote[coll], state[coll], pending);
    }
    if (Array.isArray(remote.comments)) {
      const printedHere = hadPending
        ? new Set((state.comments || []).filter((c) => c.printed).map((c) => String(c.id)))
        : null;
      state.comments = printedHere
        ? remote.comments.map((c) => (printedHere.has(String(c.id)) && !c.printed ? { ...c, printed: true } : c))
        : remote.comments;
    }
    if (Array.isArray(remote.sessions)) state.sessions = remote.sessions;
    if (Array.isArray(remote.prints)) state.prints = remote.prints;
    if (remote.settings && typeof remote.settings === 'object') {
      // Địa chỉ server là của riêng thiết bị này.
      const keepServerUrl = state.settings?.serverUrl || '';
      state.settings = { ...state.settings, ...remote.settings, serverUrl: keepServerUrl };
    }
    if (Array.isArray(remote.accounts) && state.settings) {
      state.settings.accounts = state.accounts;
    }
    if (remote.salesMetrics && typeof remote.salesMetrics === 'object') {
      state.salesMetrics = { ...state.salesMetrics, ...remote.salesMetrics };
    }
    if (typeof remote.seq === 'number') state.seq = hadPending ? Math.max(state.seq || 0, remote.seq) : remote.seq;
    if (typeof remote.selectedCustomerUniqueId === 'string') {
      state.selectedCustomerUniqueId = remote.selectedCustomerUniqueId;
    }
    if (typeof remote.activeSessionId === 'string') {
      state.activeSessionId = remote.activeSessionId;
    }
    baseSnapshot = snapshotOf(state);

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {}
    }

    remoteChangeListeners.forEach((cb) => {
      try {
        cb(state, action);
      } catch (e) {
        console.warn('[sync listener err]', e);
      }
    });
  } finally {
    isApplyingRemote = false;
  }
}

let saveTimer = null;
export function save(action = 'update') {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        state.prints = state.prints.slice(0, 50);
        try {
          localStorage.setItem(KEY, JSON.stringify(state));
        } catch {}
      }
    }
    if (!isApplyingRemote && typeof syncPushHandler === 'function') {
      recordLocalChanges();
      try {
        syncPushHandler(state, action);
      } catch (e) {
        console.warn('[sync push err]', e);
      }
    }
  }, 60);
}

export function nextOrderCode() {
  state.seq += 1;
  const code = generateOrderCode(state.seq);
  save('next_code');
  return code;
}

export function normalizeNick(s = '') {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Kiểm tra xem 2 đối tượng (đơn hàng hoặc bình luận) có cùng là một khách hàng không.
 */
export function areSameCustomer(a, b) {
  if (!a || !b) return false;

  // 1. So khớp theo TikTok CarID / userId
  const aUserId = (a.userId || '').toString().trim();
  const bUserId = (b.userId || '').toString().trim();
  const isRealUserA = /^\d{8,}$/.test(aUserId);
  const isRealUserB = /^\d{8,}$/.test(bUserId);
  if (isRealUserA && isRealUserB && aUserId === bUserId) {
    return true;
  }

  // 2. So khớp theo username TikTok (uniqueId)
  const aUid = (a.uniqueId || '').toLowerCase().trim();
  const bUid = (b.uniqueId || '').toLowerCase().trim();
  const isValidUidA = aUid && aUid !== 'unknown' && !aUid.startsWith('khach_');
  const isValidUidB = bUid && bUid !== 'unknown' && !bUid.startsWith('khach_');
  if (isValidUidA && isValidUidB && aUid === bUid) {
    return true;
  }

  // 3. So khớp theo Tên hiển thị (Nickname)
  const aNick = normalizeNick(a.nickname || a.name || '');
  const bNick = normalizeNick(b.nickname || b.name || '');
  if (aNick && bNick && aNick.length >= 2 && aNick === bNick) {
    if (isValidUidA && isValidUidB && aUid !== bUid) {
      return false;
    }
    return true;
  }

  // 4. So khớp nếu username một bên trùng tên bên kia
  if (isValidUidA && bNick && aUid === bNick) return true;
  if (isValidUidB && aNick && bUid === aNick) return true;

  // 5. So khớp theo Số điện thoại nếu có
  const aPhone = (a.phone || '').replace(/\D/g, '');
  const bPhone = (b.phone || '').replace(/\D/g, '');
  if (aPhone.length >= 9 && bPhone.length >= 9 && aPhone === bPhone) {
    return true;
  }

  return false;
}

export function findMatchingOrder(orders, person) {
  if (!orders || !person) return null;
  return (
    orders.find(
      (o) => o.status !== 'cancelled' && o.status !== 'done' && areSameCustomer(o, person)
    ) || null
  );
}

export function mergeDuplicateOrders() {
  const list = state.orders || [];
  const merged = [];
  let mergedCount = 0;

  for (const ord of list) {
    if (!ord.items) ord.items = [];

    if (ord.status === 'cancelled' || ord.status === 'done') {
      merged.push(ord);
      continue;
    }

    const existing = merged.find(
      (m) => m.status !== 'cancelled' && m.status !== 'done' && areSameCustomer(m, ord)
    );

    if (existing) {
      mergedCount += 1;
      for (const item of ord.items) {
        const isDup = item.commentId && existing.items.some((it) => it.commentId === item.commentId);
        if (!isDup) {
          existing.items.push(item);
        }
      }

      if (!existing.userId && ord.userId) existing.userId = ord.userId;
      if ((!existing.uniqueId || existing.uniqueId === 'unknown') && ord.uniqueId && ord.uniqueId !== 'unknown') {
        existing.uniqueId = ord.uniqueId;
      }
      if ((!existing.nickname || existing.nickname === 'unknown' || existing.nickname === existing.uniqueId) && ord.nickname) {
        existing.nickname = ord.nickname;
      }
      if (!existing.phone && ord.phone) existing.phone = ord.phone;

      existing.total = existing.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
      existing.ts = Math.max(existing.ts || 0, ord.ts || 0);
      existing.printCount = Math.max(existing.printCount || 0, ord.printCount || 0);
    } else {
      merged.push(ord);
    }
  }

  if (mergedCount > 0) {
    state.orders = merged;
    save('merge_orders');
  }
  return mergedCount;
}

export function mergeDuplicateCustomers() {
  const list = state.customers || [];
  const result = [];
  let count = 0;
  const isBadUid = (u) => !u || u === 'unknown' || String(u).startsWith('khach_');

  for (const c of list) {
    const target = result.find((r) => areSameCustomer(r, c));
    if (!target) {
      result.push(c);
      continue;
    }
    count += 1;
    target.totalSpent = (target.totalSpent || 0) + (c.totalSpent || 0);
    target.orderCount = (target.orderCount || 0) + (c.orderCount || 0);
    if (isBadUid(target.uniqueId) && !isBadUid(c.uniqueId)) target.uniqueId = c.uniqueId;
    if (!target.userId && c.userId) target.userId = c.userId;
    if (!target.phone && c.phone) target.phone = c.phone;
    if (!target.name && c.name) target.name = c.name;
    if ((!target.tag || target.tag === 'Khách mới') && c.tag && c.tag !== 'Khách mới') target.tag = c.tag;
  }

  if (count > 0) {
    state.customers = result;
    save('merge_customers');
  }
  return count;
}

// Không tự gộp đơn ở đây: các đơn riêng của cùng một khách (app iOS tách theo nhóm) phải được giữ
// nguyên, cùng phí ship và giảm giá của từng đơn. Bình luận mới vẫn được gom vào đơn đang mở.
try {
  mergeDuplicateCustomers();
} catch {}

export function addOrMergeOrder(data) {
  const {
    uniqueId = '',
    userId = '',
    nickname = '',
    phone = '',
    address = '',
    productName = 'Sản phẩm livestream',
    price = 0,
    qty = 1,
    comment = '',
    commentId = '',
    sessionId = ''
  } = data;

  const d = new Date();
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

  const person = { uniqueId, userId, nickname, phone };
  const existingOrder = findMatchingOrder(state.orders, person);

  if (existingOrder) {
    if (commentId && existingOrder.items?.some((it) => it.commentId === commentId)) {
      return { order: existingOrder, isMerged: false, isDuplicate: true, newItem: null };
    }

    const newItem = {
      id: 'it_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      commentId: commentId || '',
      sessionId: sessionId || null,
      name: productName,
      price: Number(price) || 0,
      qty: Number(qty) || 1,
      comment,
      timeStr,
      ts: Date.now()
    };

    existingOrder.items = existingOrder.items || [];
    existingOrder.items.push(newItem);
    existingOrder.total = existingOrder.items.reduce(
      (s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1),
      0
    );

    if (phone && !existingOrder.phone) existingOrder.phone = phone;
    if (address && !existingOrder.address) existingOrder.address = address;
    const isRealUserId = /^\d{8,}$/.test(String(userId));
    if (isRealUserId && (!existingOrder.userId || !/^\d{8,}$/.test(String(existingOrder.userId)))) {
      existingOrder.userId = String(userId);
    }
    const isValidUid = uniqueId && uniqueId !== 'unknown' && !uniqueId.startsWith('khach_');
    if (
      isValidUid &&
      (!existingOrder.uniqueId || existingOrder.uniqueId === 'unknown' || existingOrder.uniqueId.startsWith('khach_'))
    ) {
      existingOrder.uniqueId = uniqueId;
    }
    if (
      nickname &&
      (!existingOrder.nickname || existingOrder.nickname === 'unknown' || existingOrder.nickname === existingOrder.uniqueId)
    ) {
      existingOrder.nickname = nickname;
    }
    existingOrder.ts = Date.now();
    existingOrder.timeStr = timeStr;

    upsertCustomer(
      existingOrder.uniqueId,
      existingOrder.userId,
      existingOrder.nickname,
      existingOrder.phone,
      newItem.price * newItem.qty
    );
    save('order_merged');
    return { order: existingOrder, isMerged: true, isDuplicate: false, newItem };
  } else {
    const newItem = {
      id: 'it_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      commentId: commentId || '',
      sessionId: sessionId || null,
      name: productName,
      price: Number(price) || 0,
      qty: Number(qty) || 1,
      comment,
      timeStr,
      ts: Date.now()
    };
    const code = nextOrderCode();
    const newOrder = {
      id: 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      code,
      uniqueId: uniqueId || '',
      userId: userId || '',
      nickname: nickname || uniqueId || 'Khách Live',
      receiver: nickname || uniqueId || 'Khách Live',
      phone: phone || '',
      address: address || state.customers.find((c) => areSameCustomer(c, person))?.address || '',
      status: 'new',
      ts: Date.now(),
      timeStr,
      dateStr,
      createdDesc: `Tạo lúc ${timeStr} · CN ${dateStr}/2026`,
      printCount: 0,
      avatarWarm: true,
      items: [newItem],
      total: newItem.price * newItem.qty
    };

    state.orders.unshift(newOrder);
    upsertCustomer(newOrder.uniqueId, newOrder.userId, newOrder.nickname, newOrder.phone, newOrder.total);
    save('order_created');
    return { order: newOrder, isMerged: false, isDuplicate: false, newItem };
  }
}

export function upsertCustomer(uniqueId, userId, nickname, phone, spent = 0) {
  const person = { uniqueId, userId, nickname, phone };
  let cust = state.customers.find((c) => areSameCustomer(c, person));
  const d = new Date();
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (cust) {
    if (spent) {
      cust.totalSpent = (cust.totalSpent || 0) + spent;
      cust.orderCount = (cust.orderCount || 0) + 1;
    }
    if (nickname && (!cust.name || cust.name === cust.uniqueId)) cust.name = nickname;
    if (phone && !cust.phone) cust.phone = phone;
    if (userId && !cust.userId) cust.userId = userId;
    if (uniqueId && uniqueId !== 'unknown' && (!cust.uniqueId || cust.uniqueId === 'unknown')) cust.uniqueId = uniqueId;
    cust.timeDesc = `${timeStr} nay`;
    if (spent) cust.lastBuy = dateStr;
  } else {
    cust = {
      id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      uniqueId: uniqueId || '',
      userId: userId || '',
      name: nickname || uniqueId || 'Khách mới',
      phone: phone || '',
      totalSpent: spent || 0,
      orderCount: spent ? 1 : 0,
      tag: 'Mới',
      lastBuy: dateStr,
      timeDesc: `${timeStr} nay`,
      avatarWarm: false
    };
    state.customers.unshift(cust);
  }
  save('customer_upserted');
  return cust;
}

export function updateOrderStatus(orderId, newStatus) {
  const ord = state.orders.find((o) => o.id === orderId);
  if (ord) {
    ord.status = newStatus;
    save('order_status');
  }
  return ord;
}

export function removeOrder(id) {
  state.orders = state.orders.filter((o) => o.id !== id);
  save('order_deleted');
}

export function addPrint(p) {
  state.prints.unshift({
    id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(),
    ...p
  });
  if (state.prints.length > 200) state.prints.length = 200;
  save('order_printed');
}

export function updateOrder(id, fields = {}) {
  const ord = state.orders.find((o) => o.id === id);
  if (!ord) return null;
  Object.assign(ord, fields);
  if (ord.items) {
    ord.subtotal = ord.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
    ord.total = Math.max(0, ord.subtotal + (Number(ord.shippingFee) || 0) - (Number(ord.discount) || 0));
  }
  save('order_updated');
  return ord;
}

export function updateOrderItem(orderId, itemId, fields = {}) {
  const ord = state.orders.find((o) => o.id === orderId);
  if (!ord || !ord.items) return null;
  const it = ord.items.find((i) => i.id === itemId);
  if (!it) return null;
  Object.assign(it, fields);
  ord.subtotal = ord.items.reduce((s, x) => s + (Number(x.price) || 0) * (Number(x.qty) || 1), 0);
  ord.total = Math.max(0, ord.subtotal + (Number(ord.shippingFee) || 0) - (Number(ord.discount) || 0));
  save('order_item_updated');
  return ord;
}

export function removeOrderItem(orderId, itemId) {
  const ord = state.orders.find((o) => o.id === orderId);
  if (!ord || !ord.items) return null;
  ord.items = ord.items.filter((i) => i.id !== itemId);
  if (ord.items.length === 0) {
    removeOrder(orderId);
    return null;
  }
  ord.subtotal = ord.items.reduce((s, x) => s + (Number(x.price) || 0) * (Number(x.qty) || 1), 0);
  ord.total = Math.max(0, ord.subtotal + (Number(ord.shippingFee) || 0) - (Number(ord.discount) || 0));
  save('order_item_removed');
  return ord;
}

export function setCustomerTag(uniqueId, tag) {
  const uid = (uniqueId || '').toLowerCase();
  const c = state.customers.find((x) => (x.uniqueId || '').toLowerCase() === uid);
  if (c) {
    c.tag = tag;
    save('customer_tag');
  }
  return c;
}

export function updateCustomerInfo(uniqueIdOrObj, fields = {}) {
  let uid = '';
  let data = fields;
  if (uniqueIdOrObj && typeof uniqueIdOrObj === 'object') {
    uid = (uniqueIdOrObj.uniqueId || '').toLowerCase();
    data = uniqueIdOrObj;
  } else {
    uid = String(uniqueIdOrObj || '').toLowerCase();
  }
  if (!uid) return null;

  const c = state.customers.find((x) => (x.uniqueId || '').toLowerCase() === uid);
  if (c) {
    Object.assign(c, data);
  }
  state.orders.forEach((o) => {
    if ((o.uniqueId || '').toLowerCase() === uid) {
      // Có gửi trường nào thì ghi trường đó, kể cả khi người dùng xoá trống để sửa thông tin sai.
      if ('phone' in data) o.phone = data.phone;
      if (data.name) {
        o.receiver = data.name;
        o.nickname = data.name;
      }
      if (data.receiver) {
        o.receiver = data.receiver;
        o.nickname = data.receiver;
      }
      for (const field of ['address', 'street', 'ward', 'district', 'province', 'deliveryNote']) {
        if (field in data) o[field] = data[field];
      }
    }
  });
  save('customer_updated');
  return c;
}

export function getActiveAccount() {
  const accs = Array.isArray(state.accounts)
    ? state.accounts
    : state.isCleanAccount
    ? []
    : DEFAULT_SETTINGS.accounts;
  if (accs.length === 0) {
    const shopName = state.settings?.shopName || 'Chưa có Shop';
    const shopHandle = state.settings?.shopHandle || 'Chưa liên kết TikTok';
    const p = String(shopName).trim().split(/\s+/);
    const avatar =
      p.length === 1
        ? p[0].slice(0, 2).toUpperCase()
        : ((p[0]?.[0] || 'S') + (p[p.length - 1]?.[0] || 'H')).toUpperCase();
    return { id: '', name: shopName, handle: shopHandle, avatar, isEmpty: true };
  }
  return accs.find((a) => a.active) || accs[0];
}

export function switchActiveAccount(accId) {
  if (!Array.isArray(state.accounts)) state.accounts = [];
  state.accounts.forEach((a) => {
    a.active = a.id === accId;
  });
  const act = state.accounts.find((a) => a.active) || state.accounts[0];
  if (act) {
    state.settings.shopName = act.name;
    state.settings.shopHandle = act.handle;
  }
  save('account_switched');
  return act || getActiveAccount();
}

export function addNewAccount({ name, handle, avatar = 'TT' }) {
  if (!Array.isArray(state.accounts)) state.accounts = [];
  const shouldActivate = state.accounts.length === 0 || !state.accounts.some((a) => a.active);
  const formattedHandle = handle.startsWith('@') ? handle : '@' + handle;
  const newAcc = {
    id: 'acc_' + Date.now().toString(36),
    name: name || 'Tài khoản TikTok',
    handle: formattedHandle,
    avatar: avatar || 'TT',
    active: shouldActivate,
    time: 'vừa thêm'
  };
  state.accounts.push(newAcc);
  if (shouldActivate) {
    state.settings.shopName = newAcc.name;
    state.settings.shopHandle = newAcc.handle;
  }
  if (state.settings) {
    state.settings.accounts = state.accounts;
  }
  save('account_added');
  return newAcc;
}

export function resetAll() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(KEY);
  }
  if (typeof location !== 'undefined') {
    location.reload();
  }
}
