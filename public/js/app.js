import {
  state,
  save,
  addOrMergeOrder,
  updateOrderStatus,
  removeOrder,
  addPrint,
  areSameCustomer,
  updateCustomerInfo,
  getActiveAccount,
  switchActiveAccount,
  addNewAccount,
  initialComments,
  initialSalesMetrics,
  applyRemoteState,
  onRemoteStateApplied,
  pendingChangeCount
} from './store.js';
import {
  connectSync,
  fetchInitialStateFromServer,
  onSyncStatusChange,
  onRemoteUiEvent,
  onLiveStreamEvent,
  sendUiEvent,
  sendLiveCommand,
  getServerBaseUrl,
  setServerBaseUrl,
  syncStatus,
  getAuthToken,
  getCurrentUser,
  setAuthSession,
  clearAuthSession,
  apiFetch,
  onForceLogout,
  onAdminUsersSync,
  onAccountAccess,
  onOfflineChanges
} from './sync.js?v=2';
import { countdownClock, countdownText, remainingText } from './countdown.js';
import {
  parsePrice,
  parsePriceInput,
  formatVND,
  formatPhone,
  extractProductInfo
} from './price.js';
import { renderTicket, ensureFonts } from './ticket.js';
import { canvasToEscPos } from './escpos.js';
import {
  connectBluetooth,
  connectSerial,
  printHardwareEscPos,
  printerState,
  printViaSystemDriver
} from './bluetooth-printer.js';
import {
  playCashChime,
  playPrinterSound,
  speakOrder
} from './speech.js';
import { startSession, saveComment } from './history.js';
import { fakeLiveComment } from './demo.js';
import { exportOrdersToCSV } from './export.js';
import { computeSales } from './sales.js';

/* ============================================================
   Helper & DOM Utilities
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
const S = () => state.settings;
const priceOpts = () => ({
  multiplier: Number(S().multiplier) || 1000,
  minPrice: 1, // mọi mức giá đều tính (5k, 2k...)
  maxPrice: Number(S().maxPrice) || 1e12
});

function formatVNDHtml(amount) {
  const num = Math.round(Number(amount) || 0).toLocaleString('vi-VN');
  return `${num} <span class="vnd-underline">đ</span>`;
}

function toast(msg, icon = '✓', ms = 2400) {
  const box = $('#web-toast-box');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'all 0.2s ease';
    setTimeout(() => el.remove(), 200);
  }, ms);
}

/** Chỉ nói "đồng bộ" khi đang nối server; mất mạng thì thay đổi mới nằm trên máy. */
const syncedWord = () => (syncStatus.connected ? ' & đồng bộ' : '');

/* ============================================================
   Micro-interaction helpers
   ============================================================ */

/** Thêm hiệu ứng phản hồi nút bấm (bounce feedback) trên touch devices */
function addBtnFeedback(el, cls = 'btn-feedback-flash') {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // force reflow để restart animation
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/** Thêm hiệu ứng success pulse sau khi bấm In / Giao hàng */
function addSuccessPulse(el) {
  addBtnFeedback(el, 'btn-success-pulse');
}

/** Animate số đếm thay đổi (tick up/down) */
function animateNumber(el, newValue, formatter) {
  if (!el) return;
  const oldText = el.textContent.trim();
  const newText = formatter ? formatter(newValue) : String(newValue);
  if (oldText === newText) return;
  const direction = Number(String(newValue).replace(/[^0-9.-]/g, '')) >= Number(oldText.replace(/[^0-9.-]/g, '')) ? 'tick-up' : 'tick-down';
  el.classList.remove('tick-up', 'tick-down');
  void el.offsetWidth;
  if (formatter) {
    el.innerHTML = formatter(newValue);
  } else {
    el.textContent = newText;
  }
  el.classList.add('num-animate', direction);
  el.addEventListener('animationend', () => el.classList.remove(direction), { once: true });
}

/** Chuyển đổi subview với hiệu ứng slide (forward / back) */
function transitionSubview(hideEl, showEl, direction = 'forward') {
  if (!hideEl || !showEl) {
    if (hideEl) hideEl.style.display = 'none';
    if (showEl) {
      showEl.style.display = 'block';
      showEl.classList.add(direction === 'forward' ? 'subview-enter' : 'subview-back-enter');
      showEl.addEventListener('animationend', () => {
        showEl.classList.remove('subview-enter', 'subview-back-enter');
      }, { once: true });
    }
    return;
  }
  hideEl.classList.add('subview-exit');
  hideEl.addEventListener('animationend', () => {
    hideEl.classList.remove('subview-exit');
    hideEl.style.display = 'none';
    showEl.style.display = 'block';
    showEl.classList.add(direction === 'forward' ? 'subview-enter' : 'subview-back-enter');
    showEl.addEventListener('animationend', () => {
      showEl.classList.remove('subview-enter', 'subview-back-enter');
    }, { once: true });
  }, { once: true });
}

/** Đóng dialog với hiệu ứng fade-out, sau đó mới thật sự close */
function closeDialogAnimated(dialog) {
  if (!dialog || !dialog.open) return;
  dialog.classList.add('closing');
  const onEnd = () => {
    dialog.classList.remove('closing');
    dialog.close();
    dialog.removeEventListener('animationend', onEnd);
  };
  dialog.addEventListener('animationend', onEnd);
  // fallback nếu animation không trigger (vd: dialog bị ẩn)
  setTimeout(() => {
    if (dialog.open) {
      dialog.classList.remove('closing');
      dialog.close();
    }
  }, 350);
}

function avatarInitial(name) {
  const p = String(name || '?').trim().split(/\s+/);
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return ((p[0]?.[0] || '?') + (p[p.length - 1]?.[0] || '')).toUpperCase();
}

function isWarmAvatar(person) {
  if (typeof person?.avatarWarm === 'boolean') return person.avatarWarm;
  const uid = String(person?.uniqueId || person?.nickname || person?.name || '').toLowerCase();
  return uid.includes('linh') || uid.includes('thao') || uid.includes('bich') || uid.includes('kim');
}

/* ============================================================
   Điều hướng Tabs & Quản lý Views (Sidebar Web & Bottom Nav Mobile)
   ============================================================ */
let activeTab = 'live';
let currentProfileUniqueId = null;
let currentDetailOrderId = null;

function switchTab(tabName, broadcast = false) {
  activeTab = tabName;
  $$('.nav-item-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  $$('.bottom-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  $$('.view-section').forEach((s) => s.classList.toggle('active', s.id === 'view-' + tabName));

  if (tabName === 'live') renderLiveView();
  if (tabName === 'customers') {
    $('#subview-customers-list').style.display = 'block';
    $('#subview-customer-profile').style.display = 'none';
    currentProfileUniqueId = null;
    renderCustomersView();
  }
  if (tabName === 'orders') {
    $('#subview-orders-list').style.display = 'block';
    $('#subview-order-detail').style.display = 'none';
    currentDetailOrderId = null;
    renderOrdersView();
  }
  if (tabName === 'sales') renderSalesView();
  if (tabName === 'settings') renderSettingsView();

  updateSidebarShopUI();

  if (broadcast) {
    sendUiEvent({ action: 'switch_tab', tabName });
  }
}

$$('.nav-item-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab, false));
});

$$('.bottom-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab, false));
});

function isDemoAccount() {
  if (state.isCleanAccount) return false;
  const u = getCurrentUser();
  if (!u) return false;
  return String(u.username || '').toLowerCase() === 'admin' || u.id === 'u_admin';
}

function updatePrinterStatusUI() {
  const isConnected = Boolean(printerState.connected) || isDemoAccount();
  const lbl = $('#lbl-printer-conn-state');
  const quickName = $('#quick-printer-name');
  const quickLed = $('#quick-printer-led');
  const headerLed = $('#header-printer-led');

  if (isConnected) {
    if (lbl) {
      lbl.textContent = 'Đã kết nối';
      lbl.style.color = '';
      lbl.style.background = '';
    }
    if (quickName) quickName.textContent = printerState.deviceName || 'Xprinter 80mm';
    if (quickLed) quickLed.style.background = '#16a34a';
    if (headerLed) headerLed.style.background = '#16a34a';
  } else {
    if (lbl) {
      lbl.textContent = 'Chưa kết nối';
      lbl.style.color = '#6b7280';
      lbl.style.background = '#f3f4f6';
    }
    if (quickName) quickName.textContent = 'Chưa kết nối máy in';
    if (quickLed) quickLed.style.background = '#9ca3af';
    if (headerLed) headerLed.style.background = '#9ca3af';
  }
}

function updateSidebarShopUI() {
  const act = getActiveAccount();
  if ($('#sidebar-shop-name')) $('#sidebar-shop-name').textContent = act.name;
  if ($('#sidebar-shop-handle')) $('#sidebar-shop-handle').textContent = act.handle;
  if ($('#sidebar-shop-avatar')) $('#sidebar-shop-avatar').textContent = act.avatar || avatarInitial(act.name);
  updatePrinterStatusUI();
}

/* ============================================================
   1. TAB BÌNH LUẬN & TIMELINE 24H (SCREEN 2)
   ============================================================ */
let liveFilter = 'all';
/** Đang xem bình luận của phiên nào. Rỗng = tất cả. */
let commentScopeSessionId = '';
/** Các live server đang theo dõi. */
let activeLives = [];
/** Bình luận cũ tải thêm từ server (ngoài 500 bình luận mới nhất đã có sẵn). */
const olderComments = new Map();
const COMMENT_PAGE = 200;
let commentRenderLimit = COMMENT_PAGE;
let olderExhausted = false;
let sessionDayFilter = 'Hôm nay';
/** Những bình luận đã vẽ, để chỉ dòng mới có hiệu ứng xuất hiện. */
const renderedCommentIds = new Set();

/** Đọc tên tài khoản từ chữ nhập vào hoặc link phiên live. */
function parseLiveId(raw = '') {
  const s = String(raw).trim();
  const inLink = s.match(/@([\w.-]+)/);
  if (inLink) return inLink[1];
  return /^[^/?#&\s]+$/.test(s) ? s : '';
}

function getLiveComments() {
  if (!Array.isArray(state.comments)) {
    state.comments = isDemoAccount() ? [...initialComments] : [];
  } else if (state.comments.length === 0 && isDemoAccount()) {
    state.comments = [...initialComments];
  }
  return state.comments;
}

function getSelectedCustomerUid() {
  if (state.selectedCustomerUniqueId) return state.selectedCustomerUniqueId;
  return isDemoAccount() ? 'linh.nguyen98' : state.customers?.[0]?.uniqueId || '';
}

function setSelectedCustomerUid(uid, shouldSync = true) {
  state.selectedCustomerUniqueId = uid;
  if (shouldSync) {
    save('select_customer');
    sendUiEvent({ action: 'select_customer', selectedCustomerUniqueId: uid });
  }
}

function renderSessionsOverview() {
  const isDemo = isDemoAccount();
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const comments = getLiveComments();
  const guests = Array.isArray(state.customers) ? state.customers : [];
  const orders = Array.isArray(state.orders) ? state.orders : [];

  if (isDemo) {
    if ($('#overview-cnt-sessions')) $('#overview-cnt-sessions').textContent = '2';
    if ($('#overview-cnt-comments')) $('#overview-cnt-comments').textContent = '310';
    if ($('#overview-cnt-guests')) $('#overview-cnt-guests').textContent = '37';
    if ($('#overview-cnt-orders')) $('#overview-cnt-orders').textContent = '50';
    if ($('#overview-sessions-sub')) $('#overview-sessions-sub').textContent = '2 phiên';
    $$('.timeline-live-chunk').forEach((el) => {
      el.style.display = 'block';
    });
    const listBox = $('#sessions-list-container');
    if (listBox) {
      listBox.innerHTML = `
        <div class="session-row-card" data-select-session="s_evening">
          <div class="session-time-col">
            <span class="session-time-main">19:30</span>
            <span class="session-time-stem"></span>
            <span class="session-time-status">Đang<br/>live</span>
          </div>
          <div class="session-info-bubble active-live-bubble">
            <div class="session-bubble-left">
              <div class="session-bubble-title-line">
                <span class="session-bubble-title">Phiên tối</span>
                <span class="badge-live-tag"><span class="live-red-dot"></span>Live</span>
                <span class="session-bubble-duration">1g 25p</span>
              </div>
              <div class="session-bubble-stats-row">
                <span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                  <b id="s-evening-cmts">214</b>
                </span>
                <span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                  <b id="s-evening-guests">22</b>
                </span>
                <span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>
                  <b id="s-evening-orders">31</b>
                </span>
              </div>
            </div>
            <span class="session-chevron">›</span>
          </div>
        </div>
        <div class="session-row-card" data-select-session="s_noon">
          <div class="session-time-col">
            <span class="session-time-main">12:00</span>
            <span class="session-time-stem"></span>
            <span class="session-time-end">13:40</span>
          </div>
          <div class="session-info-bubble">
            <div class="session-bubble-left">
              <div class="session-bubble-title-line">
                <span class="session-bubble-title">Phiên trưa</span>
                <span class="session-bubble-duration">1g 40p</span>
              </div>
              <div class="session-bubble-stats-row">
                <span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                  <b>96</b>
                </span>
                <span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                  <b>15</b>
                </span>
                <span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>
                  <b>19</b>
                </span>
              </div>
            </div>
            <span class="session-chevron">›</span>
          </div>
        </div>
      `;
    }
    return;
  }

  const inDay = (ts) => isInSessionDayFilter(ts);
  const shownSessions = sessions
    .filter((s) => s.isLive || inDay(s.startTs || 0))
    .sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
  const shownOrders = orders.filter((o) => inDay(Number(o.ts) || 0));
  const shownGuests = new Set(shownOrders.map((o) => (o.uniqueId || o.nickname || '').toLowerCase()));
  const totalComments = shownSessions.reduce((n, s) => n + (Number(s.commentCount) || 0), 0);

  if ($('#overview-cnt-sessions')) $('#overview-cnt-sessions').textContent = String(shownSessions.length);
  if ($('#overview-cnt-comments')) $('#overview-cnt-comments').textContent = String(totalComments);
  if ($('#overview-cnt-guests')) $('#overview-cnt-guests').textContent = String(shownGuests.size);
  if ($('#overview-cnt-orders')) $('#overview-cnt-orders').textContent = String(shownOrders.length);
  if ($('#overview-sessions-sub')) $('#overview-sessions-sub').textContent = `${shownSessions.length} phiên`;
  if ($('.sessions-section-heading h3')) $('.sessions-section-heading h3').textContent = `Các phiên · ${sessionDayFilter}`;
  if (sessionDayFilter === 'Hôm nay' && $('#lbl-current-nav-date')) {
    const now = new Date();
    const wd = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][now.getDay()];
    $('#lbl-current-nav-date').textContent = `Hôm nay · ${wd} ${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}`;
  }
  renderTimelineChunks(sessions);

  const listBox = $('#sessions-list-container');
  if (listBox) {
    if (shownSessions.length === 0) {
      listBox.innerHTML = `
        <div style="padding:32px 16px;text-align:center;color:var(--text-sub);background:#fff;border-radius:16px;border:1px solid var(--border-light)">
          <div style="font-weight:700;font-size:15px;color:var(--text-main);margin-bottom:6px">Chưa có phiên live nào</div>
          <div style="font-size:13px">Bấm nút <b>+ Live mới</b> ở góc trên bên phải để theo dõi TikTok Live.</div>
        </div>
      `;
    } else {
      listBox.innerHTML = shownSessions
        .map((s) => {
          const sessOrders = orders.filter((o) => (o.items || []).some((it) => it.sessionId === s.id));
          const sessGuests = new Set(sessOrders.map((o) => (o.uniqueId || o.nickname || '').toLowerCase()));
          return `
          <div class="session-row-card" data-select-session="${esc(s.id)}">
            <div class="session-time-col">
              <span class="session-time-main">${esc(s.timeStr || 'Live')}</span>
              <span class="session-time-stem"></span>
              <span class="session-time-status">${s.isLive ? 'Đang<br/>live' : esc(s.endStr || 'Xong')}</span>
            </div>
            <div class="session-info-bubble ${s.isLive ? 'active-live-bubble' : ''}">
              <div class="session-bubble-left">
                <div class="session-bubble-title-line">
                  <span class="session-bubble-title">${esc(s.name || 'Phiên Live')}</span>
                  ${s.isLive ? '<span class="badge-live-tag"><span class="live-red-dot"></span>Live</span>' : ''}
                  <span class="session-bubble-duration">${esc(s.isLive ? liveDuration(s.startTs) : s.duration || '')}</span>
                </div>
                <div style="font-size:12px;color:var(--text-sub);margin-bottom:4px">${s.tiktok ? '@' + esc(s.tiktok) : ''}</div>
                <div class="session-bubble-stats-row">
                  <span><b>${Number(s.commentCount) || 0}</b> bình luận</span>
                  <span><b>${sessGuests.size}</b> khách</span>
                  <span><b>${sessOrders.length}</b> đơn</span>
                </div>
              </div>
              <span class="session-chevron">›</span>
            </div>
          </div>
        `;
        })
        .join('');
    }
  }

  renderCommentScopeHeader();
}

const pad2 = (n) => String(n).padStart(2, '0');

function liveDuration(startTs) {
  const mins = Math.max(Math.floor((Date.now() - (Number(startTs) || Date.now())) / 60000), 0);
  return mins >= 60 ? `${Math.floor(mins / 60)}g ${mins % 60}p` : `${mins}p`;
}

function isInSessionDayFilter(ts) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const DAY = 86400000;
  if (sessionDayFilter === 'Hôm qua') return ts >= t0 - DAY && ts < t0;
  if (sessionDayFilter === '7 ngày') return ts >= t0 - 6 * DAY;
  if (sessionDayFilter === 'Tháng này') {
    const first = new Date(startOfToday);
    first.setDate(1);
    return ts >= first.getTime();
  }
  return ts >= t0;
}

/** Vẽ các đoạn phiên trên thanh 24 giờ theo dữ liệu thật của hôm nay. */
function renderTimelineChunks(sessions) {
  const bar = $('.timeline-track-bar');
  if (!bar) return;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const DAY = 86400000;
  const now = Date.now();
  const pct = (t) => Math.min(Math.max(((t - t0) / DAY) * 100, 0), 100);
  const chunks = sessions
    .filter((s) => s.startTs && (s.isLive || (s.endTs || s.startTs) >= t0))
    .map((s) => {
      const left = pct(s.startTs);
      const width = Math.max(pct(s.isLive ? now : s.endTs || s.startTs) - left, 0.6);
      return `<div class="timeline-live-chunk ${s.isLive ? 'active-chunk' : ''}" style="left:${left}%;width:${width}%"></div>`;
    })
    .join('');
  bar.innerHTML = `${chunks}<div class="timeline-cursor-line" style="left:${pct(now)}%"></div>`;
}

function renderCommentScopeHeader() {
  const session = (state.sessions || []).find((s) => s.id === commentScopeSessionId);
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const stats = session ? [session] : sessions;
  const total = stats.reduce((n, s) => n + (Number(s.commentCount) || 0), 0);
  const guests = state.customers?.length || 0;
  const orders = state.orders?.length || 0;
  if ($('#session-title-text')) $('#session-title-text').textContent = session ? session.name || 'Phiên live' : 'Tất cả bình luận';
  if ($('#session-live-tag')) {
    $('#session-live-tag').style.display = (session ? session.isLive : sessions.some((s) => s.isLive)) ? 'inline-flex' : 'none';
  }
  if ($('#session-subtitle-text')) {
    $('#session-subtitle-text').textContent = session
      ? `Từ ${session.timeStr || ''}${session.tiktok ? ' · @' + session.tiktok : ''}`
      : activeLives.length
      ? `Đang theo dõi ${activeLives.map((l) => '@' + l.username).join(', ')}`
      : 'Chưa theo dõi live nào';
  }
  if ($('#session-stats-counter')) {
    if (session) {
      const sessOrders = (state.orders || []).filter((o) => (o.items || []).some((it) => it.sessionId === session.id));
      const sessGuests = new Set(sessOrders.map((o) => (o.uniqueId || o.nickname || '').toLowerCase()));
      $('#session-stats-counter').textContent = `${total} bình luận · ${sessGuests.size} khách · ${sessOrders.length} đơn`;
    } else {
      $('#session-stats-counter').textContent = `${total} bình luận · ${guests} khách · ${orders} đơn`;
    }
  }
}

/** Thanh các live đang theo dõi: bấm để xem riêng từng live, nút × để dừng đúng live đó. */
function renderActiveLives() {
  const box = $('#active-lives-strip');
  if (!box) return;
  if (activeLives.length === 0) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'flex';
  const counts = new Map((state.sessions || []).map((s) => [s.id, Number(s.commentCount) || 0]));
  const label = { connecting: 'đang nối', reconnecting: 'đang nối lại' };
  const allChip =
    activeLives.length > 1
      ? `<button type="button" class="live-chip all ${commentScopeSessionId ? '' : 'active'}" data-live-scope="">Tất cả ${activeLives.length} live</button>`
      : '';
  box.innerHTML =
    allChip +
    activeLives
      .map((l) => {
        const meta = label[l.state]
          ? label[l.state]
          : `${counts.get(l.sessionId) || 0} bình luận · ${l.viewers || 0} xem`;
        const isActive = l.sessionId && l.sessionId === commentScopeSessionId;
        return `
        <div class="live-chip ${isActive ? 'active' : ''}" data-live-scope="${esc(l.sessionId)}" role="button" tabindex="0">
          <span class="live-chip-dot ${esc(l.state)}"></span>
          <span>@${esc(l.username)}</span>
          <span class="live-chip-meta">${esc(meta)}</span>
          <button type="button" class="live-chip-stop" data-stop-live="${esc(l.username)}" aria-label="Dừng theo dõi @${esc(l.username)}">×</button>
        </div>`;
      })
      .join('');
}

function setCommentScope(sessionId) {
  if (commentScopeSessionId !== sessionId) {
    commentRenderLimit = COMMENT_PAGE;
    olderExhausted = false;
    // Phần đã tải chỉ liền mạch trong phạm vi cũ; giữ lại thì trang sau sẽ nhảy qua bình luận của live khác.
    olderComments.clear();
  }
  commentScopeSessionId = sessionId;
  renderActiveLives();
  renderCommentScopeHeader();
  renderCommentStream();
}

$('#active-lives-strip')?.addEventListener('click', (e) => {
  const stop = e.target.closest('[data-stop-live]');
  if (stop) {
    e.stopPropagation();
    const username = stop.dataset.stopLive;
    if (!window.confirm(`Dừng theo dõi live @${username}?`)) return;
    if (!sendLiveCommand('disconnect', username)) toast('Chưa nối được server, thử lại sau', '⚠️');
    return;
  }
  const chip = e.target.closest('[data-live-scope]');
  if (chip) {
    setCommentScope(chip.dataset.liveScope);
    setLiveViewSegment('live');
  }
});

function renderLiveView() {
  renderSessionsOverview();
  renderCommentStream();
  renderClosedOrderPanel(getSelectedCustomerUid());
}

function formatCommentText(rawText) {
  let text = esc(rawText);
  text = text.replace(/(Mã\s+\d+)/gi, '<b>$1</b>');
  text = text.replace(/(\b\d{2,4}\b(?=\s+với|\s+nữa|\s+ạ|\s+nha|\s+chốt))/gi, '<b>$1</b>');
  return text;
}

function renderCommentStream() {
  const container = $('#comment-stream-container');
  if (!container) return;

  const selectedUid = getSelectedCustomerUid();
  const isDemo = isDemoAccount();
  const liveComments = commentsInScope();

  const filtered = liveComments.filter((c) => {
    if (liveFilter === 'deals') return c.price > 0;
    if (liveFilter === 'new') return c.tag === 'Mới';
    return true;
  });

  const scopeSessions = (state.sessions || []).filter((s) => !commentScopeSessionId || s.id === commentScopeSessionId);
  const countAll = isDemo
    ? liveComments.length >= 6
      ? 208 + liveComments.length
      : liveComments.length
    : Math.max(scopeSessions.reduce((n, s) => n + (Number(s.commentCount) || 0), 0), liveComments.length);
  const loadedDeals = liveComments.filter((c) => c.price > 0).length;
  const countDeals = isDemo
    ? 28 + loadedDeals
    : Math.max(scopeSessions.reduce((n, s) => n + (Number(s.priceCount) || 0), 0), loadedDeals);
  const countNew = isDemo ? 9 : Math.max(countDeals, liveComments.filter((c) => c.tag === 'Mới').length);
  if ($('#chip-live-all')) $('#chip-live-all').textContent = `Tất cả ${countAll}`;
  if ($('#chip-live-deals')) $('#chip-live-deals').textContent = `Chốt đơn ${countDeals}`;
  if ($('#chip-live-new')) $('#chip-live-new').textContent = `Khách mới ${countNew}`;

  // Chỉ dựng số dòng vừa đủ để trang không chậm dần; phần còn lại mở bằng nút "Xem thêm".
  const shownRows = filtered.slice(0, commentRenderLimit);
  const moreBtn = $('#btn-load-older-comments');
  if (moreBtn) {
    const canLoadMore = !isDemo && !olderExhausted && countAll > liveComments.length;
    moreBtn.style.display = filtered.length > shownRows.length || canLoadMore ? 'block' : 'none';
    moreBtn.disabled = false;
    moreBtn.textContent = 'Xem thêm bình luận cũ hơn';
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="padding:32px 16px;text-align:center;color:var(--text-sub);font-size:13.5px">
        ${
          activeLives.length
            ? 'Đang chờ bình luận từ live đang theo dõi...'
            : 'Chưa có bình luận nào. Bấm <b>+ Live mới</b> để theo dõi phiên live TikTok.'
        }
      </div>
    `;
    return;
  }

  const showLiveTag = !commentScopeSessionId && new Set(liveComments.slice(0, 200).map((c) => c.live || '')).size > 1;
  const prevHeight = container.scrollHeight;
  const prevTop = container.scrollTop;
  const isFirstPaint = renderedCommentIds.size === 0;

  container.innerHTML = shownRows
    .map((c) => {
      const isSelected = c.uniqueId === selectedUid;
      const tagBadge =
        c.tag === 'Mới'
          ? '<span class="badge-pill-tag badge-tag-new">Mới</span>'
          : c.tag === 'Mua nhiều'
          ? '<span class="badge-pill-tag badge-tag-loyal">Mua nhiều</span>'
          : '';

      const hasOrder = c.price > 0;
      const isPrinted = Boolean(c.printed);

      const printBtnHtml = hasOrder
        ? `
        <button class="btn-cmt-quick-print ${isPrinted ? 'printed' : ''}" data-cmt-print-id="${esc(c.id)}" data-cmt-print-user="${esc(c.uniqueId)}">
          <span>🖨</span>
          <span>${isPrinted ? 'Đã in' : 'In đơn'}</span>
        </button>
      `
        : '';

      const warmClass = isWarmAvatar(c) ? 'warm' : '';
      const isNewRow = !isFirstPaint && !renderedCommentIds.has(String(c.id));
      renderedCommentIds.add(String(c.id));

      return `
        <div class="comment-row-item ${isSelected ? 'selected' : ''} ${isNewRow ? 'is-new' : ''}" data-comment-user="${esc(c.uniqueId)}">
          <div class="comment-left">
            <div class="user-circle-avatar ${warmClass}">${avatarInitial(c.nickname || c.uniqueId)}</div>
            <div class="comment-content-wrap">
              <div class="comment-user-row">
                <span class="comment-user-name">${esc(c.nickname || c.uniqueId)}</span>
                ${tagBadge}
                ${showLiveTag && c.live ? `<span class="comment-live-tag">· @${esc(c.live)}</span>` : ''}
              </div>
              <div class="comment-body-text">${formatCommentText(c.comment)}</div>
            </div>
          </div>
          <div class="comment-right-col">
            <div class="comment-time-right">${esc(c.time || (c.ts ? `${pad2(new Date(c.ts).getHours())}:${pad2(new Date(c.ts).getMinutes())}` : ''))}</div>
            ${printBtnHtml}
          </div>
        </div>
      `;
    })
    .join('');

  // Đang đọc ở dưới thì giữ nguyên chỗ đọc khi bình luận mới chen vào phía trên.
  if (prevTop > 40) container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
}

/** Bình luận thuộc phạm vi đang xem, mới nhất trước. */
function commentsInScope() {
  const merged = new Map();
  for (const c of getLiveComments()) merged.set(String(c.id), c);
  for (const c of olderComments.values()) if (!merged.has(String(c.id))) merged.set(String(c.id), c);
  const list = [...merged.values()].filter((c) => !commentScopeSessionId || c.sessionId === commentScopeSessionId);
  return list.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
}

$('#btn-load-older-comments')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const filteredCount = commentsInScope().filter((c) => {
    if (liveFilter === 'deals') return c.price > 0;
    if (liveFilter === 'new') return c.tag === 'Mới';
    return true;
  }).length;
  if (commentRenderLimit < filteredCount) {
    commentRenderLimit += COMMENT_PAGE;
    renderCommentStream();
    return;
  }
  const loaded = commentsInScope();
  // Nhiều bình luận có thể trùng thời gian: lấy đúng bình luận cuối theo thứ tự của server (thời gian rồi id).
  const oldest = loaded.reduce((min, c) => {
    if (!min) return c;
    const diff = Number(c.ts) - Number(min.ts);
    return diff < 0 || (diff === 0 && String(c.id) < String(min.id)) ? c : min;
  }, null);
  btn.disabled = true;
  btn.textContent = 'Đang tải...';
  const params = new URLSearchParams({ limit: String(COMMENT_PAGE) });
  if (oldest?.ts) {
    params.set('before', String(oldest.ts));
    params.set('beforeId', String(oldest.id));
  }
  if (commentScopeSessionId) params.set('sessionId', commentScopeSessionId);
  try {
    const data = await apiFetch(`/api/comments?${params}`, { method: 'GET', cache: 'no-store' });
    if (!data.ok) throw new Error(data.error || 'Không tải được');
    for (const c of data.comments || []) olderComments.set(String(c.id), c);
    if (!data.hasMore) olderExhausted = true;
    commentRenderLimit += COMMENT_PAGE;
  } catch {
    toast('Không tải được bình luận cũ, thử lại sau', '⚠️');
  }
  renderCommentStream();
});

$('#comment-stream-container')?.addEventListener('click', (e) => {
  const btnPrint = e.target.closest('[data-cmt-print-user]');
  if (btnPrint) {
    e.stopPropagation();
    const uid = btnPrint.dataset.cmtPrintUser;
    setSelectedCustomerUid(uid);
    printSingleComment(btnPrint.dataset.cmtPrintId);
    return;
  }

  const item = e.target.closest('.comment-row-item');
  if (item) {
    setSelectedCustomerUid(item.dataset.commentUser);
    renderLiveView();
  }
});

function renderClosedOrderPanel(uniqueId) {
  const cust =
    state.customers.find((c) => (c.uniqueId || '').toLowerCase() === (uniqueId || '').toLowerCase()) ||
    state.customers[0];

  if (!cust) {
    if ($('#closed-panel-sub')) $('#closed-panel-sub').textContent = 'Chưa có đơn chốt';
    if ($('#closed-cust-avatar')) {
      $('#closed-cust-avatar').textContent = '--';
      $('#closed-cust-avatar').className = 'user-circle-avatar';
    }
    if ($('#closed-cust-name')) $('#closed-cust-name').textContent = 'Chưa có khách chốt đơn';
    if ($('#closed-cust-handle')) $('#closed-cust-handle').textContent = '@---';
    if ($('#closed-cust-cmt-badge')) $('#closed-cust-cmt-badge').textContent = '0 bình luận';
    if ($('#closed-metric-session')) $('#closed-metric-session').textContent = 'Chưa có phiên';
    if ($('#closed-metric-amount')) $('#closed-metric-amount').textContent = '0 sản phẩm · 0 ₫';
    if ($('#closed-comments-groups')) {
      $('#closed-comments-groups').innerHTML = `
        <div class="closed-cmt-group">
          <div class="closed-item-pill">
            <span>Chưa có món hàng chốt nào</span>
          </div>
        </div>
      `;
    }
    if ($('#mobile-sticky-order-bar')) $('#mobile-sticky-order-bar').style.display = 'none';
    return;
  }

  const orders = state.orders.filter((o) => areSameCustomer(o, cust));
  const activeOrder = orders.find((o) => o.status === 'new') || orders[0];

  if ($('#closed-panel-sub')) {
    $('#closed-panel-sub').textContent = `Đơn của ${cust.name} · ${activeOrder?.timeStr || '20:42'}`;
  }
  if ($('#closed-cust-avatar')) {
    $('#closed-cust-avatar').textContent = avatarInitial(cust.name);
    $('#closed-cust-avatar').className = `user-circle-avatar ${isWarmAvatar(cust) ? 'warm' : ''}`;
  }
  if ($('#closed-cust-name')) $('#closed-cust-name').textContent = cust.name;
  if ($('#closed-cust-handle')) $('#closed-cust-handle').textContent = '@' + cust.uniqueId;

  const liveComments = getLiveComments();
  const custComments = liveComments.filter((c) => areSameCustomer(c, cust) && c.price > 0);
  const commentCount = custComments.length || (activeOrder?.items?.length ? activeOrder.items.length : 2);
  if ($('#closed-cust-cmt-badge')) $('#closed-cust-cmt-badge').textContent = `${commentCount} bình luận`;

  const totalItems = activeOrder?.items?.reduce((s, x) => s + (x.qty || 1), 0) || 3;
  const totalAmount = activeOrder?.total || 450000;

  if ($('#closed-metric-session')) $('#closed-metric-session').textContent = 'Phiên tối · 19:30';
  if ($('#closed-metric-amount')) {
    $('#closed-metric-amount').textContent = `${totalItems} sản phẩm · ${formatVND(totalAmount)}`;
  }

  const groupsContainer = $('#closed-comments-groups');
  if (groupsContainer) {
    if (activeOrder && activeOrder.items && activeOrder.items.length) {
      groupsContainer.innerHTML = activeOrder.items
        .map(
          (it) => `
          <div class="closed-cmt-group">
            <div class="closed-cmt-title-row">
              <span class="closed-cmt-msg">${formatCommentText(it.comment || `${it.name} chốt ạ`)}</span>
              <span class="closed-cmt-time">${esc(it.timeStr || activeOrder.timeStr || '20:40')}</span>
            </div>
            <div class="closed-item-pill">
              <span>${esc(it.name)} · ${it.qty || 1} × ${formatVND(it.price || 0)}</span>
            </div>
          </div>
        `
        )
        .join('');
    } else {
      groupsContainer.innerHTML = `
        <div class="closed-cmt-group">
          <div class="closed-item-pill">
            <span>Chưa có món hàng chốt nào</span>
          </div>
        </div>
      `;
    }
  }

  const btnPrint = $('#btn-closed-print-order');
  if (btnPrint) {
    const isPrinted = activeOrder ? activeOrder.status === 'printed' || activeOrder.printCount > 0 : false;
    btnPrint.innerHTML = isPrinted ? '<span>🖨 In lại đơn</span>' : '<span>🖨 In đơn ngay</span>';
    btnPrint.onclick = () => {
      if (activeOrder) {
        handlePrintOrder(activeOrder);
        renderLiveView();
      } else {
        toast(`Chưa có đơn hàng nào của ${cust.name}`, '⚠️');
      }
    };
  }

  const btnView = $('#btn-closed-view-order');
  if (btnView) {
    btnView.onclick = () => {
      if (activeOrder) {
        switchTab('orders');
        openOrderDetailView(activeOrder.id);
      } else {
        switchTab('orders');
      }
    };
  }

  const stickyBar = $('#mobile-sticky-order-bar');
  const detailsLayout = $('#live-stream-details-layout');
  const isShowingDetails = detailsLayout && detailsLayout.style.display !== 'none';
  if (stickyBar) {
    if (activeOrder && isShowingDetails) {
      stickyBar.style.display = 'flex';
      if ($('#sticky-bar-avatar')) $('#sticky-bar-avatar').textContent = avatarInitial(cust.name);
      if ($('#sticky-bar-name')) $('#sticky-bar-name').textContent = cust.name;
      if ($('#sticky-bar-summary')) {
        $('#sticky-bar-summary').textContent = `${totalItems} sản phẩm · ${formatVND(totalAmount)}`;
      }
      const stickyPrint = $('#btn-sticky-print-order');
      if (stickyPrint) {
        const isPrinted = activeOrder.status === 'printed' || activeOrder.printCount > 0;
        stickyPrint.textContent = isPrinted ? '🖨 In lại' : '🖨 In ngay';
        stickyPrint.onclick = () => {
          handlePrintOrder(activeOrder);
          renderLiveView();
        };
      }
      const stickyView = $('#btn-sticky-view-order');
      if (stickyView) {
        stickyView.onclick = () => {
          switchTab('orders');
          openOrderDetailView(activeOrder.id);
        };
      }
    } else {
      stickyBar.style.display = 'none';
    }
  }
}

$$('[data-livefilter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-livefilter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    liveFilter = btn.dataset.livefilter;
    renderCommentStream();
  });
});

/* Chuyển đổi giữa xem Tổng quan các phiên 24h (Screen 2) và Chi tiết luồng bình luận */
function setLiveViewSegment(seg) {
  const overview = $('#sessions-timeline-overview');
  const details = $('#live-stream-details-layout');
  const btnLive = $('#btn-seg-live-stream');
  const btnTimeline = $('#btn-seg-timeline');
  const stickyBar = $('#mobile-sticky-order-bar');

  if (seg === 'timeline') {
    if (overview) overview.style.display = 'block';
    if (details) details.style.display = 'none';
    if (btnTimeline) btnTimeline.classList.add('active');
    if (btnLive) btnLive.classList.remove('active');
    if (stickyBar) stickyBar.style.display = 'none';
  } else {
    if (overview) overview.style.display = 'none';
    if (details) details.style.display = 'grid';
    if (btnLive) btnLive.classList.add('active');
    if (btnTimeline) btnTimeline.classList.remove('active');
    renderLiveView();
  }
}

$('#btn-seg-live-stream')?.addEventListener('click', () => setLiveViewSegment('live'));
$('#btn-seg-timeline')?.addEventListener('click', () => setLiveViewSegment('timeline'));
$('#btn-back-to-sessions-timeline')?.addEventListener('click', () => setLiveViewSegment('timeline'));

$('#sessions-timeline-overview')?.addEventListener('click', (e) => {
  const row = e.target.closest('[data-select-session]');
  if (row) {
    const sId = row.dataset.selectSession;
    state.activeSessionId = sId;
    if (!isDemoAccount()) {
      setCommentScope(sId);
      setLiveViewSegment('live');
      sendUiEvent({ action: 'select_session', activeSessionId: sId });
      return;
    }
    if (sId === 's_noon') {
      $('#session-title-text').textContent = 'Phiên trưa';
      if ($('#session-live-tag')) $('#session-live-tag').style.display = 'none';
      $('#session-subtitle-text').textContent = 'Từ 12:00 - 13:40 · 1g 40p · @shophoahong.live';
      $('#session-stats-counter').textContent = '96 bình luận · 15 khách · 19 đơn';
    } else {
      $('#session-title-text').textContent = 'Phiên tối';
      if ($('#session-live-tag')) $('#session-live-tag').style.display = 'inline-flex';
      $('#session-subtitle-text').textContent = 'Từ 19:30 · 1g 25p · @shophoahong.live';
      $('#session-stats-counter').textContent = '214 bình luận · 22 khách · 31 đơn';
    }
    setLiveViewSegment('live');
    sendUiEvent({ action: 'select_session', activeSessionId: sId });
  }
});

// Chip lọc ngày nhanh trong Screen 2
$$('[data-day-chip]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-day-chip]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const lbl = btn.dataset.dayChip;
    sessionDayFilter = lbl;
    if ($('#lbl-current-nav-date')) {
      $('#lbl-current-nav-date').textContent =
        lbl === 'Hôm nay' ? 'Hôm nay · CN 25/10' : lbl === 'Hôm qua' ? 'Hôm qua · T7 24/10' : lbl;
    }
    renderSessionsOverview();
  });
});

$('#btn-date-picker-trigger')?.addEventListener('click', () => {
  $('#modal-filter-time')?.showModal();
});

let currentNavDateOffset = 0;
const dateLabels = ['Hôm nay · CN 25/10', 'Hôm qua · T7 24/10', 'T6 23/10', 'T5 22/10'];

$('#btn-prev-day-nav')?.addEventListener('click', () => {
  if (currentNavDateOffset < dateLabels.length - 1) {
    currentNavDateOffset++;
    if ($('#lbl-current-nav-date')) $('#lbl-current-nav-date').textContent = dateLabels[currentNavDateOffset];
    toast(`Xem lại phiên live: ${dateLabels[currentNavDateOffset]}`, '🗓');
  }
});

$('#btn-next-day-nav')?.addEventListener('click', () => {
  if (currentNavDateOffset > 0) {
    currentNavDateOffset--;
    if ($('#lbl-current-nav-date')) $('#lbl-current-nav-date').textContent = dateLabels[currentNavDateOffset];
    toast(`Xem lại phiên live: ${dateLabels[currentNavDateOffset]}`, '🗓');
  }
});

$('#cal-grid-tbody')?.addEventListener('click', (e) => {
  const td = e.target.closest('td[data-cal-day]');
  if (td && !td.classList.contains('muted')) {
    $$('#cal-grid-tbody td').forEach((cell) => cell.classList.remove('active'));
    td.classList.add('active');
    const day = td.dataset.calDay;
    if ($('#lbl-current-nav-date')) {
      $('#lbl-current-nav-date').textContent =
        day === '25' ? 'Hôm nay · CN 25/10' : `Ngày ${day}/10/2026`;
    }
  }
});

$('#btn-open-live-modal')?.addEventListener('click', () => {
  // Chỉ để báo sớm: server mới là nơi chặn, kể cả khi trang này chưa biết tài khoản đã hết hạn.
  const access = getCurrentUser()?.access;
  if (access?.status === 'expired') return showAccessExpired(access.message);
  renderSavedLiveIds();
  $('#modal-new-live')?.showModal();
});

function renderSavedLiveIds() {
  const container = $('#saved-live-ids-container');
  if (!container) return;

  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  if (accounts.length === 0) {
    container.innerHTML = `
      <div style="padding:14px;text-align:center;color:var(--text-sub);font-size:13px;background:#fbf9f6;border-radius:10px;border:1px dashed var(--border-light)">
        Chưa có ID TikTok nào được lưu. Hãy nhập ID TikTok Live bên dưới.
      </div>
    `;
    return;
  }

  const following = new Set(activeLives.map((l) => l.username.toLowerCase()));
  const handleOf = (acc) => String(acc.handle || '').replace(/^@/, '').toLowerCase();

  container.innerHTML = accounts
    .map(
      (acc) => `
      <div class="saved-live-item">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="user-circle-avatar warm" style="width:38px;height:38px;font-size:13px">${esc(acc.avatar || 'SH')}</div>
          <div>
            <div style="font-weight:700;font-size:14px">${esc(acc.name)}</div>
            <div style="font-size:12px;color:var(--text-sub)">${esc(acc.handle)} · ${esc(acc.time || 'hôm nay')}</div>
          </div>
        </div>
        ${
          following.has(handleOf(acc))
            ? '<span class="saved-live-following">Đang theo dõi</span>'
            : `<button class="${acc.active ? 'btn-orange-pill' : 'btn-outline-pill'}" style="padding:7px 16px;font-size:13px" data-start-saved-live="${acc.id}">
          Bắt đầu
        </button>`
        }
      </div>
    `
    )
    .join('');
}

$('#saved-live-ids-container')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-start-saved-live]');
  if (btn) {
    const accId = btn.dataset.startSavedLive;
    // Đang theo dõi live khác thì giữ nguyên shop đang chọn, chỉ thêm live này.
    const act = activeLives.length
      ? state.accounts.find((a) => a.id === accId)
      : switchActiveAccount(accId);
    $('#modal-new-live')?.close();
    updateSidebarShopUI();
    toast(`Đang kết nối live ${act.handle}...`, '🔴');
    setLiveViewSegment('live');
    startSimulatedOrRealLive(act.handle);
  }
});

$('#btn-confirm-start-live')?.addEventListener('click', () => {
  const input = $('#input-new-live-id');
  const val = parseLiveId(input.value);
  if (!val) return toast('Vui lòng nhập ID TikTok Live hoặc dán link phiên live', '⚠️');

  if ($('#chk-remember-live-id')?.checked) {
    addNewAccount({ name: val, handle: '@' + val, avatar: val.slice(0, 2).toUpperCase() });
  }

  $('#modal-new-live')?.close();
  input.value = '';
  toast(`Đang kết nối phiên live @${val}...`, '🔴');
  setLiveViewSegment('live');
  startSimulatedOrRealLive(val);
});

$('#btn-paste-live-id')?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $('#input-new-live-id').value = text.trim();
  } catch {}
});

$('#btn-open-time-filter')?.addEventListener('click', () => {
  $('#modal-filter-time')?.showModal();
});

$$('[data-time-chip]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-time-chip]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

$('#btn-apply-time-filter')?.addEventListener('click', () => {
  $('#modal-filter-time')?.close();
  toast('Đã áp dụng bộ lọc thời điểm', '✓');
});

// Luồng Live thật từ Server hoặc mô phỏng đồng bộ giữa Web & App
let liveTimer = null;
let liveRenderTimer = null;

/** Bình luận về dồn dập: gom lại vẽ tối đa 4 lần mỗi giây. */
function scheduleLiveRender() {
  if (liveRenderTimer) return;
  liveRenderTimer = setTimeout(() => {
    liveRenderTimer = null;
    renderActiveLives();
    if (activeTab === 'live') renderLiveView();
  }, 250);
}

/** Bình luận thật: server đã lưu sẵn, máy này chỉ hiển thị, không gửi ngược lên. */
function receiveServerComment(msg) {
  const { type: _type, ...comment } = msg;
  const comments = getLiveComments();
  if (!comments.some((c) => c.id === comment.id)) {
    const at = comments.findIndex((c) => (Number(c.ts) || 0) <= comment.ts);
    if (at < 0) comments.push(comment);
    else comments.splice(at, 0, comment);
    if (comments.length > 500) comments.length = 500;
    const session = state.sessions?.find((s) => s.id === comment.sessionId);
    if (session) {
      session.commentCount = (session.commentCount || 0) + 1;
      if (comment.price) session.priceCount = (session.priceCount || 0) + 1;
      session.lastActivityTs = Math.max(session.lastActivityTs || 0, comment.ts);
    }
    saveComment(comment);
    if (comment.price) playCashChime();
    scheduleLiveRender();
  }
}

/** Bình luận mô phỏng của tài khoản demo. */
function processIncomingComment({ uniqueId, nickname, comment, userId = '', id = '' }) {
  const price = parsePrice(comment, priceOpts());
  const info = extractProductInfo(comment, price);
  const d = new Date();
  const timeStr = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  const newCmt = {
    id: id || 'c_' + Date.now() + Math.random().toString(36).slice(2, 5),
    uniqueId,
    userId,
    nickname,
    comment,
    price: price || 0,
    productName: info.productName,
    qty: info.quantity || 1,
    time: timeStr,
    ts: Date.now(),
    tag: price ? 'Mới' : ''
  };

  const comments = getLiveComments();
  if (!comments.some((c) => c.id === newCmt.id)) {
    comments.unshift(newCmt);
    if (comments.length > 500) comments.pop();
  }

  saveComment(newCmt);
  if (price) playCashChime();
  scheduleLiveRender();
}

function startSimulatedOrRealLive(username = 'shophoahong.live') {
  const cleanUser = String(username).replace(/^@/, '').trim();
  if (!sendLiveCommand('connect', cleanUser)) {
    toast('Chưa nối được server, thử lại sau ít giây', '⚠️');
  }

  if (isDemoAccount()) {
    startSession(cleanUser);
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      const fake = fakeLiveComment();
      processIncomingComment(fake);
    }, 5000);
  }
}

// Lắng nghe dữ liệu thật từ TikTok Live do Server đẩy về
onLiveStreamEvent((msg) => {
  if (msg.type === 'chat') {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    receiveServerComment(msg);
  } else if (msg.type === 'lives') {
    activeLives = Array.isArray(msg.lives) ? msg.lives : [];
    renderActiveLives();
    renderCommentScopeHeader();
    if ($('#modal-new-live')?.open) renderSavedLiveIds();
  } else if (msg.type === 'viewers') {
    const live = activeLives.find((l) => l.username === msg.username);
    if (live) {
      live.viewers = msg.count;
      scheduleLiveRender();
    }
  } else if (msg.type === 'status') {
    if (msg.state === 'connected') {
      if (liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
      toast(`Đã kết nối TikTok Live @${msg.username}!`, '🔴');
    } else if (msg.state === 'error') {
      if (msg.code === 'TRIAL_EXPIRED' || msg.code === 'PLAN_EXPIRED') showAccessExpired(msg.message);
      else toast(msg.message || `Không theo dõi được @${msg.username}`, '⚠️', 5000);
    } else if (msg.state === 'ended') {
      toast(`@${msg.username}: ${msg.message || 'Phiên live đã kết thúc.'}`, 'ℹ️', 4000);
    }
  }
});

/* ============================================================
   2. TAB KHÁCH HÀNG (SCREEN 4 & SCREEN 9)
   ============================================================ */
let customerSearchQuery = '';
let customerFilter = 'all';

function renderCustomersView() {
  const container = $('#customers-list-container');
  if (!container) return;

  const list = state.customers || [];
  const q = customerSearchQuery.toLowerCase();

  const filtered = list.filter((c) => {
    if (customerFilter === 'today' && !c.lastBuy?.includes('25/10') && !c.timeDesc?.includes('nay')) return false;
    if (customerFilter === 'loyal' && c.tag !== 'Mua nhiều' && (c.orderCount || 0) < 3) return false;
    if (q) {
      const match = `${c.name} ${c.uniqueId} ${c.phone || ''}`.toLowerCase();
      if (!match.includes(q)) return false;
    }
    return true;
  });

  if ($('#customers-sub-count')) {
    if (isDemoAccount()) {
      const totalCount = Math.max(128, list.length);
      $('#customers-sub-count').textContent = `${totalCount} khách · 9 khách mới hôm nay`;
    } else {
      const newToday = list.filter((c) => c.tag === 'Mới').length;
      $('#customers-sub-count').textContent = `${list.length} khách · ${newToday} khách mới hôm nay`;
    }
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="padding:32px 16px;text-align:center;color:var(--text-sub);background:#fff;border-radius:16px;border:1px solid var(--border-light)">
        Chưa có khách hàng nào. Khách hàng sẽ tự động được lưu khi chốt đơn trên Live hoặc tạo đơn mới.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((c) => {
      const tagBadge =
        c.tag === 'Mới'
          ? '<span class="badge-pill-tag badge-tag-new">Mới</span>'
          : c.tag === 'Mua nhiều'
          ? '<span class="badge-pill-tag badge-tag-loyal">Mua nhiều</span>'
          : '';

      const warmClass = isWarmAvatar(c) ? 'warm' : '';

      return `
        <div class="customer-row-item" data-view-profile="${esc(c.uniqueId)}">
          <div class="cust-row-left">
            <div class="user-circle-avatar ${warmClass}">${avatarInitial(c.name || c.uniqueId)}</div>
            <div class="cust-row-info">
              <div class="cust-row-title-line">
                <span class="cust-name">${esc(c.name || c.uniqueId)}</span>
                ${tagBadge}
              </div>
              <div class="cust-handle-time">@${esc(c.uniqueId)}${c.timeDesc ? ` · ${esc(c.timeDesc)}` : ''}</div>
            </div>
          </div>
          <div class="cust-row-right">
            <span class="cust-total-spent">${formatVNDHtml(c.totalSpent || 0)}</span>
            <span class="cust-orders-count">${Number(c.orderCount) || 0} đơn</span>
          </div>
        </div>
      `;
    })
    .join('');
}

$('#customers-list-container')?.addEventListener('click', (e) => {
  const row = e.target.closest('[data-view-profile]');
  if (row) {
    openCustomerProfileView(row.dataset.viewProfile);
  }
});

const findCustomerByUid = (uniqueId) =>
  state.customers.find((c) => (c.uniqueId || '').toLowerCase() === (uniqueId || '').toLowerCase());

const joinRegion = ({ ward, district, province } = {}) => [ward, district, province].filter(Boolean).join(', ');

function openCustomerProfileView(uniqueId) {
  currentProfileUniqueId = uniqueId;
  const cust = findCustomerByUid(uniqueId);
  if (!cust) return;

  $('#subview-customers-list').style.display = 'none';
  $('#subview-customer-profile').style.display = 'block';

  if ($('#prof-cust-avatar')) {
    $('#prof-cust-avatar').textContent = avatarInitial(cust.name);
    $('#prof-cust-avatar').className = `user-circle-avatar ${isWarmAvatar(cust) ? 'warm' : ''}`;
  }
  $('#prof-cust-name').textContent = cust.name;
  $('#prof-cust-handle').textContent = '@' + cust.uniqueId;

  const tagEl = $('#prof-cust-tag');
  if (tagEl) {
    tagEl.textContent = cust.tag || 'Mua nhiều';
    tagEl.className = `badge-pill-tag ${cust.tag === 'Mới' ? 'badge-tag-new' : 'badge-tag-loyal'}`;
    tagEl.style.display = cust.tag ? 'inline-flex' : 'none';
  }

  const custOrders = state.orders.filter((o) => areSameCustomer(o, cust));

  $('#prof-total-spent').innerHTML = formatVNDHtml(cust.totalSpent || 0);
  $('#prof-order-count').textContent = cust.orderCount || custOrders.length;
  $('#prof-last-buy').textContent = cust.lastBuy || '—';

  // Thiếu thông tin thì nói thiếu, không hiện dữ liệu mẫu trông như thật.
  const region = joinRegion(cust);
  $('#prof-addr-receiver').textContent = cust.name;
  $('#prof-addr-phone').textContent = cust.phone ? formatPhone(cust.phone) : 'Chưa có số điện thoại';
  $('#prof-addr-street').textContent = cust.street || (region ? '' : cust.address) || 'Chưa có địa chỉ';
  $('#prof-addr-region').textContent = region;
  if ($('#prof-addr-note')) {
    $('#prof-addr-note').textContent = cust.deliveryNote || 'Không có ghi chú';
  }

  $('#prof-hist-count').textContent = `${cust.orderCount || custOrders.length} đơn`;

  const histContainer = $('#prof-history-orders-list');
  if (histContainer) {
    histContainer.innerHTML = custOrders
      .map((o) => {
        const isDone = o.status === 'done';
        const itemCount = o.items?.reduce((s, it) => s + (Number(it.qty) || 1), 0) || o.items?.length || 1;
        return `
          <div class="history-order-row" data-order-click="${o.id}" style="cursor:pointer">
            <div class="hist-order-date">
              <span class="hist-date-main">${esc(o.dateStr || '25/10')}</span>
              <span class="hist-time-sub">${esc(o.timeStr || '20:42')}</span>
            </div>
            <span class="hist-items-count">${itemCount} sản phẩm</span>
            <div class="hist-right-stack">
              <span class="hist-amount">${formatVNDHtml(o.total || 0)}</span>
              <span class="badge-order-status ${isDone ? 'status-done-badge' : 'status-new-badge'}">
                ${isDone ? 'Đã giao' : 'Đơn mới'}
              </span>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

$('#prof-history-orders-list')?.addEventListener('click', (e) => {
  const row = e.target.closest('[data-order-click]');
  if (row) {
    const oId = row.dataset.orderClick;
    switchTab('orders');
    openOrderDetailView(oId);
  }
});

$('#btn-back-to-customers')?.addEventListener('click', () => {
  currentProfileUniqueId = null;
  $('#subview-customer-profile').style.display = 'none';
  $('#subview-customers-list').style.display = 'block';
  renderCustomersView();
});

$$('[data-cust-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-cust-filter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    customerFilter = btn.dataset.custFilter;
    renderCustomersView();
  });
});

$('#input-search-customers')?.addEventListener('input', (e) => {
  customerSearchQuery = e.target.value.trim();
  renderCustomersView();
});

/** Khu vực đang sửa trong form địa chỉ; chỉ ghi vào khách khi bấm Lưu. */
let editingArea = { ward: '', district: '', province: '' };

function showEditingArea() {
  $('#edit-addr-display-area').textContent = joinRegion(editingArea) || 'Chọn khu vực';
}

function readAreaInputs() {
  return {
    ward: $('#area-input-ward').value.trim(),
    district: $('#area-input-district').value.trim(),
    province: $('#area-input-province').value.trim()
  };
}

$('#btn-open-edit-address')?.addEventListener('click', () => {
  const cust = findCustomerByUid(currentProfileUniqueId);
  if (!cust) return;

  editingArea = { ward: cust.ward || '', district: cust.district || '', province: cust.province || '' };
  $('#edit-addr-subtitle').textContent = `${cust.name} · @${cust.uniqueId}`;
  $('#edit-addr-input-phone').value = cust.phone || '';
  $('#edit-addr-input-name').value = cust.name || '';
  // Địa chỉ cũ chỉ có một dòng, chưa tách khu vực: đưa cả dòng vào ô địa chỉ để không mất.
  $('#edit-addr-input-street').value = cust.street || (joinRegion(editingArea) ? '' : cust.address || '');
  if ($('#edit-addr-input-note')) {
    $('#edit-addr-input-note').value = cust.deliveryNote || '';
  }
  showEditingArea();

  $('#modal-edit-address')?.showModal();
});

$('#edit-addr-trigger-area')?.addEventListener('click', () => {
  $('#area-input-province').value = editingArea.province;
  $('#area-input-district').value = editingArea.district;
  $('#area-input-ward').value = editingArea.ward;
  $('#area-summary-text').textContent = joinRegion(editingArea) || 'Chưa nhập';
  $('#modal-select-area')?.showModal();
});

$$('#area-input-province, #area-input-district, #area-input-ward').forEach((input) => {
  input.addEventListener('input', () => {
    $('#area-summary-text').textContent = joinRegion(readAreaInputs()) || 'Chưa nhập';
  });
});

$('#btn-confirm-area')?.addEventListener('click', () => {
  editingArea = readAreaInputs();
  showEditingArea();
  $('#modal-select-area')?.close();
});

$('#btn-save-address-changes')?.addEventListener('click', () => {
  const name = $('#edit-addr-input-name').value.trim();
  const phone = $('#edit-addr-input-phone').value.trim();
  const street = $('#edit-addr-input-street').value.trim();
  const note = $('#edit-addr-input-note')?.value.trim() || '';
  if (!name) return toast('Vui lòng nhập họ tên người nhận', '⚠️');

  if (currentProfileUniqueId) {
    updateCustomerInfo(currentProfileUniqueId, {
      name,
      phone,
      street,
      ward: editingArea.ward,
      district: editingArea.district,
      province: editingArea.province,
      deliveryNote: note,
      address: [street, joinRegion(editingArea)].filter(Boolean).join(', ')
    });
    openCustomerProfileView(currentProfileUniqueId);
  }
  $('#modal-edit-address')?.close();
  toast(`Đã lưu${syncedWord()} địa chỉ khách hàng!`, '✓');
});

/* ============================================================
   3. TAB ĐƠN HÀNG (SCREEN 5, SCREEN 7, SCREEN 8)
   ============================================================ */
let orderSearchQuery = '';
let orderFilter = 'all';

function renderOrdersView() {
  const container = $('#orders-list-container');
  if (!container) return;

  // Chỉ hiển thị các đơn hàng hiện tại (không hiển thị các đơn lịch sử cũ từ tuần trước trong danh sách hôm nay)
  const allOrders = (state.orders || []).filter((o) => !String(o.id).startsWith('o_linh_prev_'));
  const q = orderSearchQuery.toLowerCase();

  const newCnt = allOrders.filter((o) => o.status === 'new').length;
  const printedCnt = allOrders.filter((o) => o.status === 'printed').length;
  const shippingCnt = allOrders.filter((o) => o.status === 'shipping').length;

  const isDemo = isDemoAccount();
  // Hiển thị số đếm chuẩn Screen 5 (Admin cộng số nền demo; tài khoản mới hiển thị đúng số thực tế)
  const displayTotal = isDemo ? 46 + allOrders.length : allOrders.length;
  const displayNew = isDemo ? 9 + newCnt : newCnt;
  const displayPrinted = isDemo ? 30 + printedCnt : printedCnt;
  const displayShipping = isDemo ? 7 + shippingCnt : shippingCnt;

  if ($('#orders-sub-count')) {
    $('#orders-sub-count').textContent = `${displayTotal} đơn hôm nay · CN 25/10`;
  }
  if ($('#chip-ord-all')) $('#chip-ord-all').textContent = `Tất cả · ${displayTotal}`;
  if ($('#chip-ord-new')) $('#chip-ord-new').textContent = `Đơn mới · ${displayNew}`;
  if ($('#chip-ord-printed')) $('#chip-ord-printed').textContent = `Đã in · ${displayPrinted}`;
  if ($('#chip-ord-shipping')) $('#chip-ord-shipping').textContent = `Đang giao · ${displayShipping}`;

  const filtered = allOrders.filter((o) => {
    if (orderFilter === 'new' && o.status !== 'new') return false;
    if (orderFilter === 'printed' && o.status !== 'printed' && !o.printCount) return false;
    if (orderFilter === 'shipping' && o.status !== 'shipping') return false;
    if (q) {
      const match = `${o.code} ${o.nickname} ${o.uniqueId} ${o.phone || ''}`.toLowerCase();
      if (!match.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="padding:32px 16px;text-align:center;color:var(--text-sub);background:#fff;border-radius:16px;border:1px solid var(--border-light)">
        Chưa có đơn hàng nào. Bấm <b>+ Tạo đơn</b> hoặc kết nối Live để chốt đơn tự động.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((o) => {
      const isNew = o.status === 'new';
      const isPrinted = o.status === 'printed';
      const isShipping = o.status === 'shipping';
      const badgeText = isNew ? 'Đơn mới' : isPrinted ? 'Đã in' : isShipping ? 'Đang giao' : 'Đã giao';
      const badgeClass = isNew
        ? 'status-new-badge'
        : isPrinted
        ? 'status-printed-badge'
        : 'status-done-badge';

      const warmClass = isWarmAvatar(o) ? 'warm' : '';
      const itemCount = o.items?.reduce((s, it) => s + (Number(it.qty) || 1), 0) || o.items?.length || 1;

      return `
        <div class="order-card-item" data-order-row="${o.id}">
          <div class="order-card-top">
            <div class="order-card-user">
              <div class="user-circle-avatar ${warmClass}">${avatarInitial(o.nickname || o.uniqueId)}</div>
              <div class="order-card-user-info">
                <div class="order-cust-name">${esc(o.nickname || o.uniqueId)}</div>
                <div class="order-meta-sub">@${esc(o.uniqueId)} · ${itemCount} sản phẩm · ${esc(o.timeStr || '20:42')}</div>
              </div>
            </div>
            <div class="order-card-price-col">
              <span class="order-total-price">${formatVNDHtml(o.total || 0)}</span>
              <span class="badge-order-status ${badgeClass}">${badgeText}</span>
            </div>
          </div>

          <div class="order-card-actions-row">
            <button class="btn-ord-card-print ${isNew ? 'is-new' : 'is-printed'}" data-act-print="${o.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
              <span>In đơn</span>
            </button>
            <button class="btn-ord-card-ship" data-act-ship="${o.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
              <span>${isShipping ? 'Đang giao' : 'Giao hàng'}</span>
            </button>
            <button class="btn-ord-card-more" data-act-more="${o.id}" title="Thao tác khác">•••</button>
          </div>
        </div>
      `;
    })
    .join('');
}

$('#orders-list-container')?.addEventListener('click', (e) => {
  const btnPrint = e.target.closest('[data-act-print]');
  if (btnPrint) {
    e.stopPropagation();
    const oid = btnPrint.dataset.actPrint;
    const ord = state.orders.find((x) => x.id === oid);
    if (ord) handlePrintOrder(ord);
    return;
  }

  const btnShip = e.target.closest('[data-act-ship]');
  if (btnShip) {
    e.stopPropagation();
    const oid = btnShip.dataset.actShip;
    updateOrderStatus(oid, 'shipping');
    renderOrdersView();
    toast('Đã chuyển trạng thái đơn sang Đang giao!', '🚚');
    return;
  }

  const btnMore = e.target.closest('[data-act-more]');
  if (btnMore) {
    e.stopPropagation();
    const oid = btnMore.dataset.actMore;
    const ord = state.orders.find((x) => x.id === oid);
    if (ord) openOrderMenuModal(ord);
    return;
  }

  const row = e.target.closest('.order-card-item');
  if (row) {
    openOrderDetailView(row.dataset.orderRow);
  }
});

// Mở Modal 3 chấm đơn hàng (Screen 7)
let currentSheetOrder = null;
function openOrderMenuModal(ord) {
  currentSheetOrder = ord;
  const itemCount = ord.items?.reduce((s, it) => s + (Number(it.qty) || 1), 0) || ord.items?.length || 1;
  if ($('#sheet-order-avatar')) {
    $('#sheet-order-avatar').textContent = avatarInitial(ord.nickname || ord.uniqueId);
    $('#sheet-order-avatar').className = `user-circle-avatar ${isWarmAvatar(ord) ? 'warm' : ''}`;
  }
  $('#sheet-order-name').textContent = ord.nickname || ord.uniqueId;
  $('#sheet-order-meta').textContent = `${itemCount} sản phẩm · ${ord.timeStr || '20:42'}`;
  $('#sheet-order-price').innerHTML = formatVNDHtml(ord.total || 0);
  $('#sheet-title-items').textContent = `Sản phẩm (${ord.items?.length || 1})`;

  $('#modal-order-menu')?.showModal();
}

$('#sheet-act-products')?.addEventListener('click', () => {
  $('#modal-order-menu')?.close();
  if (currentSheetOrder) openOrderDetailView(currentSheetOrder.id);
});

$('#sheet-act-comments')?.addEventListener('click', () => {
  $('#modal-order-menu')?.close();
  if (currentSheetOrder) setSelectedCustomerUid(currentSheetOrder.uniqueId);
  switchTab('live');
  setLiveViewSegment('live');
});

$('#sheet-act-delete')?.addEventListener('click', () => {
  $('#modal-order-menu')?.close();
  if (currentSheetOrder) {
    if (confirm(`Bạn có chắc muốn xoá đơn ${currentSheetOrder.code} của ${currentSheetOrder.nickname}?`)) {
      removeOrder(currentSheetOrder.id);
      renderOrdersView();
      toast('Đã xoá đơn hàng!', '🗑');
    }
  }
});

// View Chi tiết đơn hàng (Screen 8)
function openOrderDetailView(orderId) {
  currentDetailOrderId = orderId;
  const ord = state.orders.find((o) => o.id === orderId);
  if (!ord) return;

  $('#subview-orders-list').style.display = 'none';
  $('#subview-order-detail').style.display = 'block';

  const badgeEl = $('#detail-order-badge');
  if (badgeEl) {
    const isNew = ord.status === 'new';
    const isPrinted = ord.status === 'printed';
    const isShipping = ord.status === 'shipping';
    badgeEl.textContent = isNew ? 'Đơn mới' : isPrinted ? 'Đã in' : isShipping ? 'Đang giao' : 'Đã giao';
    badgeEl.className = `badge-order-status ${
      isNew ? 'status-new-badge' : isPrinted ? 'status-printed-badge' : 'status-done-badge'
    }`;
  }

  if ($('#detail-cust-avatar')) {
    $('#detail-cust-avatar').textContent = avatarInitial(ord.nickname || ord.uniqueId);
    $('#detail-cust-avatar').className = `user-circle-avatar ${isWarmAvatar(ord) ? 'warm' : ''}`;
  }
  $('#detail-cust-name').textContent = ord.nickname || ord.uniqueId;

  const cust = state.customers.find((c) => areSameCustomer(c, ord));
  const orderCount = cust?.orderCount || state.orders.filter((o) => areSameCustomer(o, ord)).length;
  $('#detail-cust-meta').textContent = `@${ord.uniqueId} · ${orderCount} đơn`;

  const tagEl = $('#detail-cust-tag');
  if (tagEl) {
    const tag = cust?.tag || (orderCount >= 3 ? 'Mua nhiều' : '');
    tagEl.textContent = tag || 'Mua nhiều';
    tagEl.style.display = tag ? 'inline-flex' : 'none';
  }

  if ($('#detail-created-text')) {
    $('#detail-created-text').textContent = ord.createdDesc || `Tạo lúc ${ord.timeStr || '20:42'} · CN ${ord.dateStr || '25/10'}/2026`;
  }

  const gotoCustBtn = $('#btn-detail-goto-customer');
  if (gotoCustBtn) {
    gotoCustBtn.onclick = () => {
      switchTab('customers');
      openCustomerProfileView(ord.uniqueId);
    };
  }

  const items = ord.items || [];
  $('#detail-items-count-title').textContent = `Sản phẩm (${items.length})`;

  const linesContainer = $('#detail-product-lines');
  if (linesContainer) {
    linesContainer.innerHTML = items
      .map(
        (it, idx) => `
        <div class="product-line-row">
          <div class="prod-left-group">
            <span class="prod-idx-badge">${idx + 1}</span>
            <span class="prod-name">${esc(it.name)}</span>
            <span class="prod-calc">${it.qty || 1} × ${formatVNDHtml(it.price || 0)}</span>
          </div>
          <span class="prod-total">${formatVNDHtml((it.price || 0) * (it.qty || 1))}</span>
        </div>
      `
      )
      .join('');
  }

  $('#detail-total-sum').innerHTML = formatVNDHtml(ord.total || 0);
}

$('#btn-back-to-orders')?.addEventListener('click', () => {
  currentDetailOrderId = null;
  $('#subview-order-detail').style.display = 'none';
  $('#subview-orders-list').style.display = 'block';
  renderOrdersView();
});

$('#btn-detail-print-order')?.addEventListener('click', () => {
  const ord = state.orders.find((o) => o.id === currentDetailOrderId);
  if (ord) {
    handlePrintOrder(ord);
    openOrderDetailView(currentDetailOrderId);
  }
});

$('#btn-detail-ship-order')?.addEventListener('click', () => {
  if (currentDetailOrderId) {
    updateOrderStatus(currentDetailOrderId, 'shipping');
    toast('Đã cập nhật trạng thái Giao hàng!', '🚚');
    openOrderDetailView(currentDetailOrderId);
  }
});

// CHỈNH SỬA SẢN PHẨM TRONG ĐƠN (SCREEN 8)
let editingOrderItemsCopy = [];

$('#btn-detail-edit-order')?.addEventListener('click', () => {
  const ord = state.orders.find((o) => o.id === currentDetailOrderId);
  if (!ord) return;

  if ($('#edit-items-order-subtitle')) {
    $('#edit-items-order-subtitle').textContent = `Đơn ${ord.code} · ${ord.nickname}`;
  }
  editingOrderItemsCopy = JSON.parse(JSON.stringify(ord.items || []));
  renderEditOrderItemsModal();
  $('#modal-edit-order-items')?.showModal();
});

function renderEditOrderItemsModal() {
  const container = $('#edit-items-container');
  if (!container) return;

  if (editingOrderItemsCopy.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text-sub);text-align:center;padding:12px">Chưa có sản phẩm nào trong đơn</p>';
  } else {
    container.innerHTML = editingOrderItemsCopy
      .map(
        (it, idx) => `
        <div class="edit-item-row" data-item-idx="${idx}">
          <input type="text" class="form-field-input item-edit-name" value="${esc(it.name)}" placeholder="Tên / Mã sản phẩm" />
          <div style="display:flex;align-items:center;gap:4px">
            <label style="font-size:12px;color:var(--text-sub)">SL:</label>
            <input type="number" min="1" class="form-field-input item-edit-qty" value="${it.qty || 1}" style="width:65px;text-align:center" />
          </div>
          <div style="display:flex;align-items:center;gap:4px">
            <input type="text" class="form-field-input item-edit-price" value="${formatVND(it.price || 0)}" placeholder="Giá tiền" />
          </div>
          <button type="button" class="btn-remove-item-row" data-remove-item-idx="${idx}" title="Xoá món này">×</button>
        </div>
      `
      )
      .join('');
  }

  const total = editingOrderItemsCopy.reduce((s, x) => s + (x.price || 0) * (x.qty || 1), 0);
  if ($('#edit-items-total-preview')) {
    $('#edit-items-total-preview').textContent = formatVND(total);
  }
}

$('#btn-add-item-to-order')?.addEventListener('click', () => {
  editingOrderItemsCopy.push({
    id: 'it_' + Date.now().toString(36),
    name: 'Mã ' + (Math.floor(Math.random() * 80) + 100),
    price: 150000,
    qty: 1
  });
  renderEditOrderItemsModal();
});

$('#edit-items-container')?.addEventListener('input', (e) => {
  const row = e.target.closest('.edit-item-row');
  if (!row) return;
  const idx = Number(row.dataset.itemIdx);
  const it = editingOrderItemsCopy[idx];
  if (!it) return;

  if (e.target.classList.contains('item-edit-name')) {
    it.name = e.target.value;
  } else if (e.target.classList.contains('item-edit-qty')) {
    it.qty = Math.max(1, parseInt(e.target.value) || 1);
  } else if (e.target.classList.contains('item-edit-price')) {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    if (raw) it.price = parseInt(raw);
  }

  const total = editingOrderItemsCopy.reduce((s, x) => s + (x.price || 0) * (x.qty || 1), 0);
  if ($('#edit-items-total-preview')) {
    $('#edit-items-total-preview').textContent = formatVND(total);
  }
});

$('#edit-items-container')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-item-idx]');
  if (btn) {
    const idx = Number(btn.dataset.removeItemIdx);
    editingOrderItemsCopy.splice(idx, 1);
    renderEditOrderItemsModal();
  }
});

$('#btn-save-order-items')?.addEventListener('click', () => {
  const ord = state.orders.find((o) => o.id === currentDetailOrderId);
  if (ord) {
    ord.items = editingOrderItemsCopy;
    ord.total = ord.items.reduce((s, x) => s + (x.price || 0) * (x.qty || 1), 0);
    save('order_items_edited');
    openOrderDetailView(currentDetailOrderId);
    $('#modal-edit-order-items')?.close();
    toast(`Đã cập nhật${syncedWord()} sản phẩm trong đơn!`, '✓');
  }
});

$('#btn-detail-delete-order')?.addEventListener('click', () => {
  if (confirm('Bạn có chắc chắn muốn xoá đơn này không thể khôi phục?')) {
    removeOrder(currentDetailOrderId);
    currentDetailOrderId = null;
    $('#subview-order-detail').style.display = 'none';
    $('#subview-orders-list').style.display = 'block';
    renderOrdersView();
    toast('Đã xoá đơn hàng!', '🗑');
  }
});

// TẠO ĐƠN HÀNG MỚI
$('#btn-create-order-pill')?.addEventListener('click', () => {
  if ($('#new-ord-name')) $('#new-ord-name').value = '';
  if ($('#new-ord-handle')) $('#new-ord-handle').value = '';
  if ($('#new-ord-phone')) $('#new-ord-phone').value = '';
  if ($('#new-ord-address')) $('#new-ord-address').value = '';
  if ($('#new-ord-product-name')) $('#new-ord-product-name').value = '';
  if ($('#new-ord-price')) $('#new-ord-price').value = '';
  if ($('#new-ord-note')) $('#new-ord-note').value = '';
  $('#modal-create-order')?.showModal();
});

$('#btn-submit-create-order')?.addEventListener('click', () => {
  const name = $('#new-ord-name')?.value.trim();
  if (!name) return toast('Vui lòng nhập tên khách hàng', '⚠️');

  const handle = ($('#new-ord-handle')?.value.trim() || name.toLowerCase().replace(/\s+/g, '')).replace(/^@/, '');
  const phone = $('#new-ord-phone')?.value.trim() || '';
  const address = $('#new-ord-address')?.value.trim() || '';
  const prodName = $('#new-ord-product-name')?.value.trim() || 'Sản phẩm';
  const priceRaw = $('#new-ord-price')?.value.trim() || '';
  const price = parsePriceInput(priceRaw, Number(S().multiplier || 1000));
  const note = $('#new-ord-note')?.value.trim() || '';
  if (!price) return toast('Vui lòng nhập giá sản phẩm', '⚠️');

  const { order } = addOrMergeOrder({
    uniqueId: handle,
    nickname: name,
    productName: prodName,
    price,
    qty: 1
  });

  if (order) {
    if (phone) order.phone = phone;
    if (address) order.address = address;
    if (note) order.note = note;
  }

  // Ô bỏ trống không được xoá thông tin đã có của khách quen.
  updateCustomerInfo(handle, {
    uniqueId: handle,
    name,
    ...(phone ? { phone } : {}),
    ...(note ? { deliveryNote: note } : {}),
    ...(address ? { address } : {})
  });

  if (S().sound !== false) playCashChime(0.5);

  $('#modal-create-order')?.close();
  renderOrdersView();
  toast(`Đã tạo${syncedWord()} đơn ${order.code} cho ${name}!`, '✓');
});

$('#btn-order-filter-icon')?.addEventListener('click', () => {
  $('#modal-filter-time')?.showModal();
});

$$('[data-order-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-order-filter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    orderFilter = btn.dataset.orderFilter;
    renderOrdersView();
  });
});

$('#input-search-orders')?.addEventListener('input', (e) => {
  orderSearchQuery = e.target.value.trim();
  renderOrdersView();
});

/* ============================================================
   4. TAB TÔI & TÀI KHOẢN TIKTOK (SCREEN 6)
   ============================================================ */
function renderSettingsView() {
  updatePrinterStatusUI();
  const accountsContainer = $('#accounts-cards-list');
  if (!accountsContainer) return;

  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  if (accounts.length === 0) {
    accountsContainer.innerHTML = `
      <div style="padding:18px 16px;text-align:center;color:var(--text-sub);font-size:13.5px;border-bottom:1px solid var(--border-light)">
        Chưa có tài khoản TikTok nào. Bấm <b>+ Thêm tài khoản</b> bên dưới để liên kết shop của bạn.
      </div>
    `;
    return;
  }

  accountsContainer.innerHTML = accounts
    .map(
      (acc, idx) => `
      <div class="account-item-box" data-account-card="${acc.id}">
        <div class="acc-box-left">
          <div class="user-circle-avatar ${idx === 0 ? 'warm' : ''}" style="width:42px;height:42px">${esc(acc.avatar || 'TT')}</div>
          <div class="acc-name-handle">
            <span class="acc-name">${esc(acc.name)}</span>
            <span class="acc-handle">${esc(acc.handle)}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${acc.active ? '<span class="badge-in-use">Đang dùng</span>' : ''}
          <div class="acc-radio-circle ${acc.active ? 'active' : ''}">
            ${acc.active ? '✓' : ''}
          </div>
        </div>
      </div>
    `
    )
    .join('');
}

$('#accounts-cards-list')?.addEventListener('click', (e) => {
  const box = e.target.closest('[data-account-card]');
  if (box) {
    const accId = box.dataset.accountCard;
    const act = switchActiveAccount(accId);
    renderSettingsView();
    updateSidebarShopUI();
    toast(`Đã chuyển sang tài khoản ${act.name}`, '✓');
  }
});

$('#btn-add-tiktok-account')?.addEventListener('click', () => {
  if ($('#input-new-acc-name')) $('#input-new-acc-name').value = '';
  if ($('#input-new-acc-handle')) $('#input-new-acc-handle').value = '';
  $('#modal-add-account')?.showModal();
});

$('#btn-save-new-account')?.addEventListener('click', () => {
  const name = $('#input-new-acc-name')?.value.trim();
  const handle = $('#input-new-acc-handle')?.value.trim();
  if (!name || !handle) return toast('Vui lòng nhập tên Shop và username TikTok', '⚠️');

  addNewAccount({
    name,
    handle: handle.startsWith('@') ? handle : '@' + handle,
    avatar: name.slice(0, 2).toUpperCase()
  });
  renderSettingsView();
  updateSidebarShopUI();
  $('#modal-add-account')?.close();
  toast(`Đã thêm${syncedWord()} tài khoản TikTok mới!`, '✓');
});

$('#menu-row-printer')?.addEventListener('click', () => $('#modal-printer-setup')?.showModal());
$('#btn-sidebar-printer')?.addEventListener('click', () => $('#modal-printer-setup')?.showModal());
$('#btn-header-printer-status')?.addEventListener('click', () => $('#modal-printer-setup')?.showModal());

// Đồng bộ Web & App IPA Modal
function openSyncSetupModal() {
  if ($('#input-sync-server-url')) {
    $('#input-sync-server-url').value = S().serverUrl || getServerBaseUrl();
  }
  updateSyncUI(syncStatus);
  renderSyncGuide();
  $('#modal-sync-setup')?.showModal();
}

async function renderSyncGuide() {
  const user = getCurrentUser();
  if ($('#sync-guide-account')) $('#sync-guide-account').textContent = user?.username || '—';
  const base = getServerBaseUrl();
  if ($('#sync-guide-server')) $('#sync-guide-server').textContent = base;
  const lanBox = $('#sync-guide-lan');
  if (!lanBox) return;
  let isLocal = false;
  try {
    const host = new URL(base).hostname;
    isLocal = host === 'localhost' || host === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  } catch {}
  lanBox.style.display = 'none';
  if (!isLocal) return;
  const info = await apiFetch('/api/server-info', { method: 'GET', cache: 'no-store' }).catch(() => null);
  if (info?.lanUrls?.length) {
    $('#sync-guide-lan-urls').textContent = info.lanUrls.join('  hoặc  ');
    lanBox.style.display = 'block';
  }
}

$('#menu-row-sync')?.addEventListener('click', openSyncSetupModal);
$('#btn-sidebar-sync')?.addEventListener('click', openSyncSetupModal);

$('#btn-save-sync-url')?.addEventListener('click', () => {
  const val = $('#input-sync-server-url')?.value.trim() || '';
  setServerBaseUrl(val);
  $('#modal-sync-setup')?.close();
  toast('Đã lưu địa chỉ máy chủ & đang đồng bộ!', '🔄');
});

$('#btn-sync-pull-now')?.addEventListener('click', async () => {
  const ok = await fetchInitialStateFromServer();
  toast(ok ? 'Đã đồng bộ dữ liệu mới nhất từ máy chủ!' : 'Không kết nối được máy chủ', ok ? '✓' : '⚠️');
});

$('#menu-row-keywords')?.addEventListener('click', () => {
  if ($('#cfg-kw-multiplier')) $('#cfg-kw-multiplier').value = S().multiplier || '1000';
  if ($('#cfg-kw-autoprint')) $('#cfg-kw-autoprint').checked = S().autoPrint !== false;
  $('#modal-keyword-setup')?.showModal();
});

$('#btn-save-keyword-setup')?.addEventListener('click', () => {
  S().multiplier = $('#cfg-kw-multiplier')?.value || '1000';
  S().autoPrint = $('#cfg-kw-autoprint')?.checked;
  save('settings_keywords');
  $('#modal-keyword-setup')?.close();
  toast('Đã lưu cấu hình bắt giá tự động!', '✓');
});

$('#menu-row-notify')?.addEventListener('click', () => {
  if ($('#cfg-notify-sound')) $('#cfg-notify-sound').checked = S().sound !== false;
  if ($('#cfg-notify-voice')) $('#cfg-notify-voice').checked = S().voiceEnabled === true;
  $('#modal-notify-setup')?.showModal();
});

$('#btn-test-chime')?.addEventListener('click', () => {
  playCashChime(0.6);
  toast('Đang phát tiếng chuông Kaching chốt đơn', '🔔');
});

$('#btn-test-voice')?.addEventListener('click', () => {
  speakOrder({
    nickname: 'Linh Nguyễn',
    items: [{ name: 'Mã 150', qty: 1 }]
  });
  toast('Đang đọc to đơn bằng giọng Việt', '🗣');
});

$('#btn-save-notify-setup')?.addEventListener('click', () => {
  S().sound = $('#cfg-notify-sound')?.checked;
  S().voiceEnabled = $('#cfg-notify-voice')?.checked;
  save('settings_notify');
  $('#modal-notify-setup')?.close();
  toast('Đã lưu cài đặt thông báo & giọng nói!', '✓');
});

$('#menu-row-help')?.addEventListener('click', () => {
  $('#modal-help-guide')?.showModal();
});

/* ============================================================
   4B. ĐĂNG NHẬP, ĐĂNG KÝ, PHÂN QUYỀN & QUẢN TRỊ ADMIN
   ============================================================ */
let adminUsersList = [];
let adminSearchQuery = '';
let targetResetPassUserId = null;

function showAuthBanner(msg, type = 'error') {
  const banner = $('#auth-alert-banner');
  if (!banner) return;
  if (!msg) {
    banner.style.display = 'none';
    banner.textContent = '';
    return;
  }
  banner.className = `auth-alert-banner ${type}`;
  banner.textContent = msg;
  banner.style.display = 'block';
}

function switchAuthTab(mode = 'login') {
  const isLogin = mode === 'login';
  $('#tab-auth-login')?.classList.toggle('active', isLogin);
  $('#tab-auth-register')?.classList.toggle('active', !isLogin);
  if ($('#form-auth-login')) $('#form-auth-login').style.display = isLogin ? 'block' : 'none';
  if ($('#form-auth-register')) $('#form-auth-register').style.display = isLogin ? 'none' : 'block';
  showAuthBanner('');
}

$('#tab-auth-login')?.addEventListener('click', () => switchAuthTab('login'));
$('#tab-auth-register')?.addEventListener('click', () => switchAuthTab('register'));

// Trên trình duyệt, web luôn nối về chính máy chủ đang mở trang nên không cần chỉnh địa chỉ.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  $('#btn-auth-server-config')?.closest('.auth-card-footer')?.remove();
}
$('#btn-auth-server-config')?.addEventListener('click', () => {
  openSyncSetupModal();
});

$('#nav-btn-admin-shortcut')?.addEventListener('click', () => {
  switchTab('settings', false);
  setTimeout(() => {
    $('#admin-accounts-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
});

const timeLeft = (access) => remainingText(access.endsAt - Date.now());
const accessDate = (ms) => new Date(ms).toLocaleDateString('vi-VN');

function showAccessExpired(message) {
  if ($('#access-expired-message')) $('#access-expired-message').textContent = message;
  const dialog = $('#modal-access-expired');
  if (dialog && !dialog.open) {
    $('#modal-new-live')?.close();
    dialog.showModal();
  }
}

let trialCountdownTimer = null;
let trialCheckedAt = 0;

/** Tới 0 thì hỏi lại server thay vì tự kết luận: đồng hồ máy có thể lệch, và server chỉ báo hết hạn cho máy đang theo dõi live. */
async function recheckAccessFromServer() {
  try {
    const res = await apiFetch('/api/auth/me');
    const data = await res.json();
    if (res.ok && data.user && getAuthToken()) {
      setAuthSession(getAuthToken(), data.user);
      renderOwnAccess(data.user.access);
    }
  } catch {}
}

function tickTrialCountdown(access) {
  const remaining = access.endsAt - Date.now();
  if ($('#current-auth-access')) $('#current-auth-access').textContent = `Dùng thử miễn phí còn ${countdownText(remaining)}`;
  if ($('#sidebar-access-value')) $('#sidebar-access-value').textContent = countdownClock(remaining);
  if (remaining <= 0 && Date.now() - trialCheckedAt >= 5000) {
    trialCheckedAt = Date.now();
    recheckAccessFromServer();
  }
}

function renderSidebarAccess(access) {
  const badge = $('#btn-sidebar-access');
  if (!badge) return;
  const show = access?.status === 'trial' || access?.status === 'expired';
  badge.style.display = show ? 'block' : 'none';
  badge.classList.toggle('expired', access?.status === 'expired');
  if (access?.status === 'trial') {
    $('#sidebar-access-label').textContent = 'Dùng thử miễn phí còn';
  } else if (access?.status === 'expired') {
    $('#sidebar-access-label').textContent = 'Hết hạn sử dụng';
    $('#sidebar-access-value').textContent = access.code === 'PLAN_EXPIRED' ? 'Gói đã hết hạn' : 'Đã hết dùng thử';
  }
}

/** Thẻ tài khoản ở màn Tôi, ô ở thanh bên và dòng nhắc ở màn Bình luận. Thời gian còn lại chỉ để xem, server mới là nơi chặn. */
function renderOwnAccess(access) {
  const line = $('#current-auth-access');
  const notice = $('#live-access-notice');
  const text =
    access?.status === 'expired'
      ? access.message
      : access?.status === 'plan'
        ? `Gói còn hiệu lực đến ${accessDate(access.endsAt)} (còn ${timeLeft(access)})`
        : '';
  const isTrial = access?.status === 'trial';
  if (line) {
    line.textContent = text;
    line.className = `auth-user-access ${access?.status || ''}`;
    line.style.display = text || isTrial ? 'block' : 'none';
  }
  if (notice) {
    notice.textContent = access?.status === 'expired' ? access.message : '';
    notice.style.display = access?.status === 'expired' ? 'block' : 'none';
  }
  renderSidebarAccess(access);

  clearInterval(trialCountdownTimer);
  trialCountdownTimer = null;
  if (isTrial) {
    tickTrialCountdown(access);
    trialCountdownTimer = setInterval(() => tickTrialCountdown(access), 1000);
  }
}

onAccountAccess(renderOwnAccess);

$('#btn-sidebar-access')?.addEventListener('click', () => switchTab('settings', false));

function applyAuthUserToUI(user) {
  const overlay = $('#auth-screen-overlay');
  renderOwnAccess(user?.access);
  if (!user || !getAuthToken()) {
    overlay?.classList.remove('hidden');
    if ($('#admin-accounts-panel')) $('#admin-accounts-panel').style.display = 'none';
    if ($('#nav-btn-admin-shortcut')) $('#nav-btn-admin-shortcut').style.display = 'none';
    return;
  }

  overlay?.classList.add('hidden');
  const isAdmin = user.role === 'admin';

  if ($('#current-auth-avatar')) {
    $('#current-auth-avatar').textContent = avatarInitial(user.username);
  }
  if ($('#current-auth-username')) {
    $('#current-auth-username').textContent = user.username;
  }
  if ($('#current-auth-role-badge')) {
    $('#current-auth-role-badge').textContent = isAdmin ? '🛡 Quản trị viên (Admin)' : 'Thành viên';
    $('#current-auth-role-badge').className = `role-pill-badge ${isAdmin ? 'admin' : 'user'}`;
  }
  if ($('#current-auth-desc')) {
    $('#current-auth-desc').textContent = isAdmin
      ? 'Tài khoản Admin: Toàn quyền tạo, khoá/mở khoá và đổi mật khẩu các tài khoản khác'
      : 'Tài khoản thành viên: Quản lý phiên Live, khách hàng, đơn hàng và in tem 80mm';
  }

  if ($('#admin-accounts-panel')) {
    $('#admin-accounts-panel').style.display = isAdmin ? 'block' : 'none';
  }
  if ($('#nav-btn-admin-shortcut')) {
    $('#nav-btn-admin-shortcut').style.display = isAdmin ? 'flex' : 'none';
  }

  if (isAdmin) {
    loadAdminUsers();
  }
}

// Xử lý Form Đăng nhập
$('#form-auth-login')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#auth-login-username')?.value.trim();
  const password = $('#auth-login-password')?.value || '';
  if (!username || !password) {
    return showAuthBanner('Vui lòng nhập tên tài khoản và mật khẩu');
  }

  const btn = $('#btn-submit-login');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang đăng nhập...';
  }

  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showAuthBanner(data.error || 'Đăng nhập thất bại');
      return;
    }

    setAuthSession(data.token, data.user);
    if (data.state) {
      applyRemoteState(data.state, 'initial_fetch');
    }
    showAuthBanner('');
    applyAuthUserToUI(data.user);
    await fetchInitialStateFromServer();
    connectSync();
    toast(`Xin chào ${data.user.username}! Đã đăng nhập thành công.`, '👋');
  } catch (_err) {
    showAuthBanner('Không kết nối được máy chủ. Vui lòng kiểm tra địa chỉ Server URL.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Đăng nhập vào hệ thống';
    }
  }
});

// Xử lý Form Đăng ký (chỉ gồm Tên tài khoản, Mật khẩu, Xác nhận mật khẩu)
$('#form-auth-register')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#auth-reg-username')?.value.trim();
  const password = $('#auth-reg-password')?.value || '';
  const confirmPassword = $('#auth-reg-confirm')?.value || '';

  if (!username) {
    return showAuthBanner('Vui lòng nhập tên tài khoản');
  }
  if (password.length < 6) {
    return showAuthBanner('Mật khẩu phải có ít nhất 6 ký tự');
  }
  if (password !== confirmPassword) {
    return showAuthBanner('Xác nhận mật khẩu không khớp!');
  }

  const btn = $('#btn-submit-register');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang tạo tài khoản...';
  }

  try {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, confirmPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showAuthBanner(data.error || 'Đăng ký thất bại');
      return;
    }

    setAuthSession(data.token, data.user);
    if (data.state) {
      applyRemoteState(data.state, 'initial_fetch');
    }
    if ($('#auth-reg-username')) $('#auth-reg-username').value = '';
    if ($('#auth-reg-password')) $('#auth-reg-password').value = '';
    if ($('#auth-reg-confirm')) $('#auth-reg-confirm').value = '';
    showAuthBanner('');
    applyAuthUserToUI(data.user);
    await fetchInitialStateFromServer();
    connectSync();
    toast(`Đã tạo tài khoản "${data.user.username}" & đăng nhập thành công!`, '🎉');
  } catch (_err) {
    showAuthBanner('Không kết nối được máy chủ. Vui lòng kiểm tra địa chỉ Server URL.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Đăng ký tài khoản';
    }
  }
});

// Đổi mật khẩu của chính tài khoản đang đăng nhập
$('#btn-open-change-own-pass')?.addEventListener('click', () => {
  if ($('#own-pass-current')) $('#own-pass-current').value = '';
  if ($('#own-pass-new')) $('#own-pass-new').value = '';
  if ($('#own-pass-confirm')) $('#own-pass-confirm').value = '';
  $('#modal-change-own-pass')?.showModal();
});

$('#btn-submit-own-pass')?.addEventListener('click', async () => {
  const currentPassword = $('#own-pass-current')?.value || '';
  const newPassword = $('#own-pass-new')?.value || '';
  const confirmPassword = $('#own-pass-confirm')?.value || '';

  if (!currentPassword || !newPassword) {
    return toast('Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới', '⚠️');
  }
  if (newPassword !== confirmPassword) {
    return toast('Xác nhận mật khẩu mới không khớp!', '⚠️');
  }

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return toast(data.error || 'Không thể đổi mật khẩu', '⚠️');
    }
    if (data.token) {
      setAuthSession(data.token, getCurrentUser());
    }
    $('#modal-change-own-pass')?.close();
    toast('Đã đổi mật khẩu của bạn thành công!', '🔑');
  } catch (_err) {
    toast('Lỗi kết nối máy chủ khi đổi mật khẩu', '⚠️');
  }
});

// Bảng Quản lý Tài khoản dành riêng cho Admin
async function loadAdminUsers() {
  const cur = getCurrentUser();
  if (!cur || cur.role !== 'admin') return;
  try {
    const res = await apiFetch('/api/admin/users');
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.users)) {
      adminUsersList = data.users;
      renderAdminUsersTable();
    }
  } catch (_err) {}
}

function adminAccessText(access) {
  if (access?.status === 'plan') return `Có gói đến ${accessDate(access.endsAt)} (còn ${timeLeft(access)})`;
  if (access?.status === 'trial') return `Dùng thử còn ${timeLeft(access)}`;
  if (access?.status === 'expired') return access.code === 'PLAN_EXPIRED' ? 'Gói đã hết hạn' : 'Đã hết dùng thử';
  return '';
}

function adminAccessBadge(access) {
  if (!access || access.status === 'admin') return '';
  const icon = { plan: '🎫', trial: '⏳', expired: '⛔' }[access.status];
  const short = access.status === 'plan' ? `Gói đến ${accessDate(access.endsAt)}` : adminAccessText(access);
  return `<span class="status-pill-badge ${access.status === 'expired' ? 'locked' : access.status}">${icon} ${esc(short)}</span>`;
}

let targetPlanUserId = null;

/** Gửi yêu cầu đổi gói; server trả về danh sách mới. */
async function submitPlanChange(options, successMessage) {
  if (!targetPlanUserId) return;
  try {
    const res = await apiFetch(`/api/admin/users/${encodeURIComponent(targetPlanUserId)}/plan`, options);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return toast(data.error || 'Không thể cập nhật gói', '⚠️');
    }
    $('#modal-admin-plan')?.close();
    toast(successMessage(data.user), '🎫', 3500);
    adminUsersList = data.users;
    renderAdminUsersTable();
  } catch (_err) {
    toast('Lỗi kết nối máy chủ', '⚠️');
  }
}

$('#btn-submit-admin-plan')?.addEventListener('click', () => {
  const months = Number($('#admin-plan-months')?.value);
  submitPlanChange({ method: 'POST', body: JSON.stringify({ months }) }, (user) => {
    return `Đã cấp gói cho "${user.username}", hết hạn ngày ${accessDate(user.access.endsAt)}`;
  });
});

$('#btn-revoke-admin-plan')?.addEventListener('click', () => {
  const user = adminUsersList.find((u) => u.id === targetPlanUserId);
  if (!user || !confirm(`Thu hồi gói của tài khoản "${user.username}"?`)) return;
  submitPlanChange({ method: 'DELETE' }, (u) => `Đã thu hồi gói của "${u.username}"`);
});

function renderAdminUsersTable() {
  const container = $('#admin-users-list');
  if (!container) return;

  if ($('#admin-users-count-badge')) {
    const lockedCount = adminUsersList.filter((u) => u.locked).length;
    $('#admin-users-count-badge').textContent =
      lockedCount > 0
        ? `${adminUsersList.length} tài khoản (${lockedCount} đang khoá)`
        : `${adminUsersList.length} tài khoản`;
  }

  const q = adminSearchQuery.toLowerCase();
  const filtered = adminUsersList.filter(
    (u) => !q || String(u.username || '').toLowerCase().includes(q)
  );

  if (filtered.length === 0) {
    container.innerHTML = `<p style="text-align:center;color:var(--text-sub);padding:18px">Không tìm thấy tài khoản nào khớp từ khoá</p>`;
    return;
  }

  const curUser = getCurrentUser();
  container.innerHTML = filtered
    .map((u) => {
      const isPrimaryAdmin = String(u.username).toLowerCase() === 'admin';
      const isSelf = curUser && curUser.id === u.id;
      const createdDate = u.createdAt
        ? new Date(u.createdAt).toLocaleDateString('vi-VN')
        : 'Hôm nay';
      const onlineBadge =
        u.onlineCount > 0
          ? `<span style="color:#15803d;font-weight:700">● Online (${u.onlineCount} thiết bị)</span>`
          : `<span>Offline</span>`;

      return `
        <div class="admin-user-row-card ${u.locked ? 'is-locked' : ''}" data-admin-user-row="${esc(u.id)}">
          <div class="admin-user-main-info">
            <div class="user-circle-avatar ${u.role === 'admin' ? 'warm' : ''}" style="width:42px;height:42px;font-size:14px">
              ${esc(avatarInitial(u.username))}
            </div>
            <div>
              <div class="auth-user-name-row">
                <span style="font-weight:800;font-size:15.5px;color:var(--text-main)">${esc(u.username)}</span>
                <span class="role-pill-badge ${u.role === 'admin' ? 'admin' : 'user'}">
                  ${u.role === 'admin' ? '🛡 Admin' : 'Thành viên'}
                </span>
                <span class="status-pill-badge ${u.locked ? 'locked' : 'active'}">
                  ${u.locked ? '🔒 Đã khoá' : '✓ Hoạt động'}
                </span>
                ${adminAccessBadge(u.access)}
              </div>
              <div class="admin-user-meta-line">
                ${onlineBadge}
                <span>·</span>
                <span>Tạo ngày ${createdDate}</span>
                ${isSelf ? '<span>· <b style="color:var(--primary-orange-strong)">(Tài khoản của bạn)</b></span>' : ''}
              </div>
            </div>
          </div>

          <div class="admin-user-actions-group">
            ${
              u.role !== 'admin'
                ? `<button type="button" class="btn-admin-act plan-btn" data-admin-plan-id="${esc(u.id)}">
                    🎫 Cấp gói
                  </button>`
                : ''
            }
            ${
              !isPrimaryAdmin && !isSelf
                ? `<button type="button" class="btn-admin-act ${u.locked ? 'unlock-btn' : 'lock-btn'}" data-admin-lock-id="${esc(u.id)}" data-admin-locked="${u.locked ? '1' : '0'}">
                    ${u.locked ? '🔓 Mở khoá' : '🔒 Khoá TK'}
                  </button>`
                : ''
            }
            <button type="button" class="btn-admin-act pass-btn" data-admin-pass-id="${esc(u.id)}" data-admin-pass-name="${esc(u.username)}">
              🔑 Đổi pass
            </button>
            ${
              !isPrimaryAdmin && !isSelf
                ? `<button type="button" class="btn-admin-act del-btn" data-admin-delete-id="${esc(u.id)}" data-admin-delete-name="${esc(u.username)}">
                    🗑 Xoá
                  </button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

$('#input-admin-search-user')?.addEventListener('input', (e) => {
  adminSearchQuery = e.target.value.trim();
  renderAdminUsersTable();
});

// Xử lý các nút Khoá / Mở khoá, Đổi pass, Xoá trên từng dòng tài khoản
$('#admin-users-list')?.addEventListener('click', async (e) => {
  // 1. Nút Khoá / Mở khoá
  const lockBtn = e.target.closest('[data-admin-lock-id]');
  if (lockBtn) {
    const userId = lockBtn.dataset.adminLockId;
    const currentlyLocked = lockBtn.dataset.adminLocked === '1';
    const nextLocked = !currentlyLocked;
    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/lock`, {
        method: 'POST',
        body: JSON.stringify({ locked: nextLocked })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return toast(data.error || 'Không thể cập nhật trạng thái khoá', '⚠️');
      }
      toast(
        nextLocked
          ? `Đã KHOÁ tài khoản "${data.user.username}" & ngắt phiên đăng nhập tức thì!`
          : `Đã MỞ KHOÁ tài khoản "${data.user.username}"!`,
        nextLocked ? '🔒' : '🔓'
      );
      loadAdminUsers();
    } catch (_err) {
      toast('Lỗi kết nối máy chủ', '⚠️');
    }
    return;
  }

  // Nút Cấp gói
  const planBtn = e.target.closest('[data-admin-plan-id]');
  if (planBtn) {
    targetPlanUserId = planBtn.dataset.adminPlanId;
    const user = adminUsersList.find((u) => u.id === targetPlanUserId);
    if ($('#admin-plan-account')) $('#admin-plan-account').textContent = user?.username || '';
    if ($('#admin-plan-current')) $('#admin-plan-current').textContent = adminAccessText(user?.access);
    if ($('#admin-plan-months')) $('#admin-plan-months').value = '1';
    if ($('#btn-revoke-admin-plan')) {
      $('#btn-revoke-admin-plan').style.display = user?.access?.status === 'plan' ? 'inline-flex' : 'none';
    }
    $('#modal-admin-plan')?.showModal();
    return;
  }

  // 2. Nút Đổi mật khẩu từ Admin
  const passBtn = e.target.closest('[data-admin-pass-id]');
  if (passBtn) {
    targetResetPassUserId = passBtn.dataset.adminPassId;
    const uname = passBtn.dataset.adminPassName || '';
    if ($('#admin-reset-pass-subtitle')) {
      $('#admin-reset-pass-subtitle').innerHTML = `Cập nhật mật khẩu mới cho tài khoản: <b>${esc(uname)}</b>`;
    }
    if ($('#admin-input-new-pass')) $('#admin-input-new-pass').value = '';
    if ($('#admin-input-confirm-pass')) $('#admin-input-confirm-pass').value = '';
    $('#modal-admin-reset-pass')?.showModal();
    return;
  }

  // 3. Nút Xoá tài khoản
  const delBtn = e.target.closest('[data-admin-delete-id]');
  if (delBtn) {
    const userId = delBtn.dataset.adminDeleteId;
    const uname = delBtn.dataset.adminDeleteName || '';
    if (!confirm(`Bạn có chắc chắn muốn xoá vĩnh viễn tài khoản "${uname}"?`)) return;
    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return toast(data.error || 'Không thể xoá tài khoản', '⚠️');
      }
      toast(`Đã xoá tài khoản "${uname}"!`, '🗑');
      loadAdminUsers();
    } catch (_err) {
      toast('Lỗi kết nối máy chủ', '⚠️');
    }
  }
});

// Xác nhận Đổi mật khẩu từ Modal Admin
$('#btn-confirm-admin-reset-pass')?.addEventListener('click', async () => {
  if (!targetResetPassUserId) return;
  const newPassword = $('#admin-input-new-pass')?.value || '';
  const confirmPassword = $('#admin-input-confirm-pass')?.value || '';

  if (newPassword.length < 6) {
    return toast('Mật khẩu mới phải có ít nhất 6 ký tự', '⚠️');
  }
  if (newPassword !== confirmPassword) {
    return toast('Xác nhận mật khẩu mới không khớp!', '⚠️');
  }

  try {
    const res = await apiFetch(`/api/admin/users/${encodeURIComponent(targetResetPassUserId)}/password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword, confirmPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return toast(data.error || 'Lỗi khi đổi mật khẩu', '⚠️');
    }
    $('#modal-admin-reset-pass')?.close();
    toast(data.message || 'Đã đổi mật khẩu thành công!', '🔑');
    loadAdminUsers();
  } catch (_err) {
    toast('Lỗi kết nối máy chủ', '⚠️');
  }
});

// Tạo tài khoản mới từ Admin
$('#btn-admin-open-create')?.addEventListener('click', () => {
  if ($('#admin-create-username')) $('#admin-create-username').value = '';
  if ($('#admin-create-password')) $('#admin-create-password').value = '';
  if ($('#admin-create-confirm')) $('#admin-create-confirm').value = '';
  if ($('#admin-create-role')) $('#admin-create-role').value = 'user';
  $('#modal-admin-create-user')?.showModal();
});

$('#btn-submit-admin-create-user')?.addEventListener('click', async () => {
  const username = $('#admin-create-username')?.value.trim();
  const password = $('#admin-create-password')?.value || '';
  const confirmPassword = $('#admin-create-confirm')?.value || '';
  const role = $('#admin-create-role')?.value || 'user';

  if (!username) return toast('Vui lòng nhập tên tài khoản', '⚠️');
  if (password.length < 6) return toast('Mật khẩu phải có ít nhất 6 ký tự', '⚠️');
  if (password !== confirmPassword) return toast('Xác nhận mật khẩu không khớp!', '⚠️');

  try {
    const res = await apiFetch('/api/admin/users/create', {
      method: 'POST',
      body: JSON.stringify({ username, password, confirmPassword, role })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return toast(data.error || 'Không thể tạo tài khoản', '⚠️');
    }
    $('#modal-admin-create-user')?.close();
    toast(`Đã tạo tài khoản "${data.user.username}" thành công!`, '✓');
    loadAdminUsers();
  } catch (_err) {
    toast('Lỗi kết nối máy chủ', '⚠️');
  }
});

// Tự động cập nhật danh sách tài khoản của Admin theo thời gian thực qua WebSocket
onAdminUsersSync((users) => {
  adminUsersList = users;
  renderAdminUsersTable();
});

// Khi bị Admin khoá tài khoản hoặc đổi mật khẩu từ xa -> văng ra khung Đăng nhập ngay lập tức
onForceLogout((reason) => {
  clearAuthSession();
  applyAuthUserToUI(null);
  switchAuthTab('login');
  showAuthBanner(reason || 'Phiên đăng nhập đã hết hạn hoặc tài khoản bị khoá.', 'error');
  toast(reason || 'Tài khoản đã bị ngắt kết nối', '🔒', 4000);
});

// Đăng xuất
$('#btn-logout-app')?.addEventListener('click', async () => {
  if (confirm('Bạn có chắc muốn đăng xuất khỏi tài khoản này?')) {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_e) {}
    clearAuthSession();
    applyAuthUserToUI(null);
    switchAuthTab('login');
    toast('Đã đăng xuất thành công', '✓');
  }
});

/* ============================================================
   5. TAB DOANH SỐ (SCREEN 1)
   ============================================================ */
let salesChartMode = '7days';

$('#chip-chart-7days')?.addEventListener('click', () => {
  $('#chip-chart-7days')?.classList.add('active');
  $('#chip-chart-30days')?.classList.remove('active');
  salesChartMode = '7days';
  renderSalesView();
});

$('#chip-chart-30days')?.addEventListener('click', () => {
  $('#chip-chart-30days')?.classList.add('active');
  $('#chip-chart-7days')?.classList.remove('active');
  salesChartMode = '30days';
  renderSalesView();
});

$('#btn-export-sales-report')?.addEventListener('click', () => {
  try {
    exportOrdersToCSV(state.orders);
    toast('Đã xuất file báo cáo đơn hàng Excel (CSV UTF-8)', '📥');
  } catch (err) {
    toast(err.message || 'Lỗi khi xuất file', '⚠️');
  }
});

function renderSalesView() {
  const isDemo = isDemoAccount();
  const m = state.salesMetrics || initialSalesMetrics;
  const barsContainer = $('#barchart-bars-container');
  const labelsContainer = $('#barchart-labels-container');

  if (!isDemo) {
    const sales = computeSales(state.orders, { sessions: state.sessions });
    const signed = (pct) => `${pct > 0 ? '+' : ''}${pct}%`;

    if ($('#sales-header-date')) {
      const dateText = new Date().toLocaleDateString('vi-VN', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      $('#sales-header-date').textContent = dateText.charAt(0).toUpperCase() + dateText.slice(1);
    }
    if ($('#sales-live-badge')) {
      const hasLive = Array.isArray(state.sessions) && state.sessions.some((s) => s.isLive);
      $('#sales-live-badge').style.display = hasLive ? 'inline-flex' : 'none';
    }
    if ($('#sales-hero-revenue')) $('#sales-hero-revenue').innerHTML = formatVNDHtml(sales.todayRevenue);
    if ($('#sales-today-growth-pct')) {
      $('#sales-today-growth-pct').textContent = sales.todayGrowthPct === null ? '—' : signed(sales.todayGrowthPct);
      const arrow = $('#sales-today-growth-pct').parentElement?.querySelector('svg');
      if (arrow) arrow.style.transform = sales.todayGrowthPct < 0 ? 'rotate(180deg)' : '';
    }
    if ($('#sales-today-guests')) $('#sales-today-guests').textContent = String(sales.todayGuests);
    if ($('#sales-new-guests-sub')) $('#sales-new-guests-sub').textContent = `${sales.newGuests} khách mới`;
    if ($('#sales-month-label')) $('#sales-month-label').textContent = `Doanh thu tháng ${sales.monthNumber}`;
    if ($('#sales-month-revenue')) $('#sales-month-revenue').innerHTML = formatVNDHtml(sales.monthRevenue);
    if ($('#sales-month-growth')) {
      $('#sales-month-growth').textContent =
        sales.monthGrowthPct === null
          ? 'Chưa có số liệu tháng trước'
          : `${signed(sales.monthGrowthPct)} so với cùng kỳ tháng ${sales.prevMonthNumber}`;
      $('#sales-month-growth').className = `stat-box-sub ${sales.monthGrowthPct < 0 ? 'orange' : 'green'}`;
    }

    const { new: cntNew, printed: cntPrinted, shipping: cntShipping, done: cntDone } = sales.statusCounts;
    const pctNew = sales.todayOrderCount > 0 ? Math.round((cntNew / sales.todayOrderCount) * 100) : 0;

    if ($('#sales-donut-pct')) $('#sales-donut-pct').textContent = `${pctNew}%`;
    if ($('#sales-donut-circle')) {
      $('#sales-donut-circle').setAttribute('stroke-dashoffset', String(289 - Math.round((289 * pctNew) / 100)));
    }
    if ($('#sales-cnt-new')) $('#sales-cnt-new').textContent = String(cntNew);
    if ($('#sales-cnt-printed')) $('#sales-cnt-printed').textContent = String(cntPrinted);
    if ($('#sales-cnt-shipping')) $('#sales-cnt-shipping').textContent = String(cntShipping);
    if ($('#sales-cnt-done')) $('#sales-cnt-done').textContent = String(cntDone);
    if ($('#sales-rate-pct')) {
      $('#sales-rate-pct').textContent = sales.closeRatePct === null ? '—' : `${sales.closeRatePct}%`;
    }
    if ($('#sales-aov-val')) $('#sales-aov-val').textContent = formatVND(sales.averageOrderValue);

    const bars = salesChartMode === '30days' ? sales.periods : sales.days;
    const colStyle = salesChartMode === '30days' ? ' style="width:20%"' : '';
    const maxAmount = Math.max(...bars.map((b) => b.amount), 0);
    if (barsContainer) {
      barsContainer.innerHTML = bars
        .map((b) => {
          const height = b.amount > 0 && maxAmount > 0 ? Math.max(4, Math.round((b.amount / maxAmount) * 80)) : 4;
          const amountText = formatVND(b.amount);
          return `
            <div class="barchart-col ${b.isCurrent ? 'highlight' : ''}"${colStyle} title="${esc(b.label)}: ${esc(amountText)}">
              ${b.isCurrent ? `<span class="barchart-tooltip-val">${esc(amountText)}</span>` : ''}
              <div class="barchart-pill-bar" style="height:${height}%"></div>
            </div>
          `;
        })
        .join('');
    }
    if (labelsContainer) {
      labelsContainer.innerHTML = bars
        .map(
          (b) => `
          <span class="barchart-day-label ${b.isCurrent ? 'highlight' : ''}"${colStyle}>${esc(b.label)}</span>
        `
        )
        .join('');
    }
    return;
  }

  if ($('#sales-live-badge')) $('#sales-live-badge').style.display = 'inline-flex';
  if ($('#sales-header-date')) $('#sales-header-date').textContent = 'Chủ nhật, 25/10/2026';
  if ($('#sales-month-label')) $('#sales-month-label').textContent = 'Doanh thu tháng 10';
  if ($('#sales-today-growth-pct')) {
    $('#sales-today-growth-pct').textContent = '+18%';
    const arrow = $('#sales-today-growth-pct').parentElement?.querySelector('svg');
    if (arrow) arrow.style.transform = '';
  }
  if ($('#sales-donut-pct')) $('#sales-donut-pct').textContent = '75%';
  if ($('#sales-donut-circle')) $('#sales-donut-circle').setAttribute('stroke-dashoffset', '60');
  if ($('#sales-cnt-new')) $('#sales-cnt-new').textContent = '12';
  if ($('#sales-cnt-printed')) $('#sales-cnt-printed').textContent = '31';
  if ($('#sales-cnt-shipping')) $('#sales-cnt-shipping').textContent = '7';
  if ($('#sales-cnt-done')) $('#sales-cnt-done').textContent = '0';
  if ($('#sales-rate-pct')) $('#sales-rate-pct').textContent = '83.8%';
  if ($('#sales-aov-val')) $('#sales-aov-val').textContent = '97.200 ₫';

  // Tính doanh thu động theo các đơn mới phát sinh so với mốc gốc
  const extraRev = (state.orders || [])
    .filter((o) => !String(o.id).startsWith('o_'))
    .reduce((s, o) => s + (Number(o.total) || 0), 0);

  const todayRev = (m.todayRevenue || 4860000) + extraRev;
  const monthRev = (m.monthRevenue || 68450000) + extraRev;

  if ($('#sales-hero-revenue')) $('#sales-hero-revenue').innerHTML = formatVNDHtml(todayRev);
  if ($('#sales-today-guests')) $('#sales-today-guests').textContent = m.todayCustomers || 37;
  if ($('#sales-new-guests-sub')) $('#sales-new-guests-sub').textContent = `${m.todayNewCustomers || 9} khách mới`;
  if ($('#sales-month-revenue')) $('#sales-month-revenue').innerHTML = formatVNDHtml(monthRev);
  if ($('#sales-month-growth')) $('#sales-month-growth').textContent = m.monthGrowth || '+12% so với tháng 9';

  if (salesChartMode === '30days') {
    const weeksData = [
      { day: 'Tuần 1', height: 42, text: '14,2tr' },
      { day: 'Tuần 2', height: 58, text: '16,5tr' },
      { day: 'Tuần 3', height: 74, text: '18,3tr' },
      { day: 'Tuần 4', height: 88, text: '19,45tr', highlight: true }
    ];
    if (barsContainer) {
      barsContainer.innerHTML = weeksData
        .map(
          (d) => `
          <div class="barchart-col ${d.highlight ? 'highlight' : ''}" style="width:20%">
            ${d.text ? `<span class="barchart-tooltip-val">${d.text}</span>` : ''}
            <div class="barchart-pill-bar" style="height:${d.height}%"></div>
          </div>
        `
        )
        .join('');
    }
    if (labelsContainer) {
      labelsContainer.innerHTML = weeksData
        .map(
          (d) => `
          <span class="barchart-day-label ${d.highlight ? 'highlight' : ''}" style="width:20%">${d.day}</span>
        `
        )
        .join('');
    }
  } else {
    const chartDays = m.chartDays || initialSalesMetrics.chartDays;
    if (barsContainer) {
      barsContainer.innerHTML = chartDays
        .map(
          (d) => `
          <div class="barchart-col ${d.highlight ? 'highlight' : ''}">
            ${d.text ? `<span class="barchart-tooltip-val">${d.text}</span>` : ''}
            <div class="barchart-pill-bar" style="height:${d.height}%"></div>
          </div>
        `
        )
        .join('');
    }
    if (labelsContainer) {
      labelsContainer.innerHTML = chartDays
        .map(
          (d) => `
          <span class="barchart-day-label ${d.highlight ? 'highlight' : ''}">${d.day}</span>
        `
        )
        .join('');
    }
  }
}

/* ============================================================
   XỬ LÝ IN TEM HOÁ ĐƠN (XPRINTER Q80BS 80MM)
   ============================================================ */
/** In đúng 1 bình luận: lưu vào đơn/khách của người đó rồi in tem riêng cho bình luận này. */
function printSingleComment(commentId) {
  let c = getLiveComments().find((x) => x.id === commentId);
  if (!c && olderComments.has(String(commentId))) {
    // Bình luận cũ tải thêm: đưa vào danh sách để trạng thái "đã in" được gửi lên server.
    c = olderComments.get(String(commentId));
    getLiveComments().push(c);
  }
  if (!c || !(c.price > 0)) return toast('Bình luận này chưa có giá để in', '⚠️');

  const { order, newItem, isDuplicate } = addOrMergeOrder({
    uniqueId: c.uniqueId,
    userId: c.userId || '',
    nickname: c.nickname,
    productName: c.productName || 'Sản phẩm',
    price: c.price,
    qty: c.qty || 1,
    comment: c.comment,
    commentId: c.id,
    sessionId: c.sessionId || ''
  });
  const item = newItem || order.items.find((it) => it.commentId === c.id);
  if (!item) return toast('Không lưu được bình luận vào khách', '⚠️');
  if (isDuplicate) toast('Bình luận này đã lưu trước đó, in lại tem', 'ℹ️');

  c.printed = true;
  state.selectedCustomerUniqueId = c.uniqueId;
  handlePrintOrder(order, false, item);
}

async function handlePrintOrder(order, isRemoteTrigger = false, onlyItem = null) {
  toast(`Đang in tem cho ${order.nickname}...`, '🖨');
  order.printCount = (order.printCount || 0) + 1;
  order.status = 'printed';
  if (!isRemoteTrigger) {
    save('order_printed');
    sendUiEvent({ action: 'print_order', orderId: order.id, itemId: onlyItem?.id || '' });
  }
  renderOrdersView();
  if (activeTab === 'live') renderLiveView();

  try {
    await ensureFonts();
    // onlyItem chỉ có khi in từ 1 bình luận đang live: tem rút gọn, giờ là lúc bấm in.
    const canvas = renderTicket(S(), onlyItem ? {
      uniqueId: order.uniqueId,
      nickname: order.nickname,
      liveComment: onlyItem.comment || onlyItem.name || '',
      ts: Date.now()
    } : {
      uniqueId: order.uniqueId,
      userId: order.userId || '',
      nickname: order.nickname,
      items: order.items || [],
      total: order.total || 0,
      ts: order.ts
    });

    const bytes = canvasToEscPos(canvas);
    const imgUrl = canvas.toDataURL('image/png');

    if (!isRemoteTrigger) {
      addPrint({ ticket: order, bytes: bytes.length });
    }

    if (printerState.connected) {
      try {
        await printHardwareEscPos(bytes);
        toast(`Đã gửi tem in tới ${printerState.deviceName}!`, '🖨');
      } catch (err) {
        toast('Lỗi in phần cứng: ' + err.message, '⚠️');
      }
    }

    const tray = $('#printer-paper-tray');
    if (tray) {
      $('#tray-empty-hint')?.remove();
      const ticketEl = document.createElement('div');
      ticketEl.className = 'printed-bill-ticket';
      ticketEl.innerHTML = `
        <img src="${imgUrl}" alt="Tem in ${order.code}" style="max-width:280px" />
        <div style="display:flex;gap:6px;justify-content:center;margin:6px 0 10px">
          <button class="btn-outline-pill btn-print-sys-sm" style="font-size:11.5px;padding:3px 10px;cursor:pointer">🖨 In qua hệ thống</button>
        </div>
      `;
      ticketEl.querySelector('.btn-print-sys-sm')?.addEventListener('click', () => {
        printViaSystemDriver(canvas, `Tem in ${order.code}`);
      });
      tray.prepend(ticketEl);
    }

    if (S().sound !== false) playPrinterSound();
  } catch (err) {
    console.error('Lỗi khi vẽ tem in:', err);
  }
}

$('#btn-modal-connect-bt')?.addEventListener('click', async () => {
  try {
    toast('Đang tìm máy in Bluetooth Xprinter...', '📡');
    const dev = await connectBluetooth();
    $('#lbl-printer-conn-state').textContent = 'Đã kết nối';
    $('#quick-printer-name').textContent = dev.deviceName || 'Xprinter Q80BS';
    toast(`Đã kết nối Bluetooth: ${dev.deviceName}!`, '✓');
  } catch (err) {
    toast(err.message, '⚠️');
  }
});

$('#btn-modal-connect-usb')?.addEventListener('click', async () => {
  try {
    const dev = await connectSerial();
    $('#lbl-printer-conn-state').textContent = 'Đã kết nối';
    $('#quick-printer-name').textContent = dev.deviceName || 'USB Xprinter';
    toast(`Đã kết nối USB: ${dev.deviceName}!`, '✓');
  } catch (err) {
    toast(err.message, '⚠️');
  }
});

$('#btn-modal-test-print')?.addEventListener('click', () => {
  const testOrder = state.orders[0] || {
    code: 'TEST80',
    uniqueId: 'linh.nguyen98',
    nickname: 'Linh Nguyễn',
    phone: '0905 123 456',
    address: '25 Lê Lợi, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
    items: [
      { id: 't1', name: 'Mã 150', price: 150000, qty: 1 },
      { id: 't2', name: 'Mã 120', price: 120000, qty: 1 },
      { id: 't3', name: 'Mã 180', price: 180000, qty: 1 }
    ],
    total: 450000,
    ts: Date.now()
  };
  handlePrintOrder(testOrder);
});

$('#btn-clear-tray')?.addEventListener('click', () => {
  const tray = $('#printer-paper-tray');
  if (tray) {
    tray.innerHTML =
      '<p style="color:var(--text-muted);font-size:12.5px" id="tray-empty-hint">Tem in sẽ hiện ở đây khi in</p>';
  }
});

$$('[data-close-dialog]').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.closest('dialog')?.close();
  });
});

/* ============================================================
   ĐỒNG BỘ 2 CHIỀU THỜI GIAN THỰC (WEB <-> SERVER <-> APP IPA)
   ============================================================ */
function refreshAllViewsFromRemote(action = '') {
  updateSidebarShopUI();
  renderSalesView();
  renderLiveView();
  renderCustomersView();
  renderOrdersView();
  renderSettingsView();

  // Nếu đang mở chi tiết đơn hoặc hồ sơ khách hàng thì cập nhật trực tiếp luôn
  if (currentDetailOrderId && $('#subview-order-detail')?.style.display !== 'none') {
    const exists = state.orders.some((o) => o.id === currentDetailOrderId);
    if (exists) {
      openOrderDetailView(currentDetailOrderId);
    } else {
      currentDetailOrderId = null;
      $('#subview-order-detail').style.display = 'none';
      $('#subview-orders-list').style.display = 'block';
    }
  }

  if (currentProfileUniqueId && $('#subview-customer-profile')?.style.display !== 'none') {
    openCustomerProfileView(currentProfileUniqueId);
  }

  if (action && action !== 'hello' && action !== 'initial_fetch') {
    const labels = {
      order_created: 'Đơn hàng mới vừa được tạo từ thiết bị kia',
      order_merged: 'Đơn hàng vừa được gộp từ thiết bị kia',
      order_status: 'Trạng thái đơn vừa được cập nhật',
      order_printed: 'Đơn hàng vừa được bấm in',
      order_deleted: 'Đơn hàng vừa được xoá',
      order_items_edited: 'Sản phẩm trong đơn vừa được sửa',
      customer_updated: 'Địa chỉ khách hàng vừa được cập nhật',
      account_switched: 'Đã đồng bộ chuyển tài khoản TikTok',
      account_added: 'Đã đồng bộ thêm tài khoản TikTok'
    };
    if (labels[action]) {
      toast(labels[action], '🔄', 1800);
    }
  }
}

onRemoteStateApplied((_newState, action) => {
  refreshAllViewsFromRemote(action);
});

onRemoteUiEvent((msg) => {
  if (msg.action === 'select_customer' && msg.selectedCustomerUniqueId) {
    state.selectedCustomerUniqueId = msg.selectedCustomerUniqueId;
    renderLiveView();
  } else if (msg.action === 'select_session' && msg.activeSessionId) {
    state.activeSessionId = msg.activeSessionId;
  } else if (msg.action === 'print_order' && msg.orderId) {
    const ord = state.orders.find((o) => o.id === msg.orderId);
    // Nếu thiết bị hiện tại (VD: App IPA) đang kết nối máy in Bluetooth thật thì tự động in ra giấy luôn!
    if (ord && printerState.connected) {
      handlePrintOrder(ord, true, ord.items?.find((it) => it.id === msg.itemId) || null);
    }
  }
});

onOfflineChanges((kind, count) => {
  if (kind === 'saved') {
    toast('Mất kết nối: thay đổi được giữ trên máy, có mạng sẽ tự gửi. Đừng xoá dữ liệu trình duyệt.', '📴', 5000);
  } else {
    toast(`Đã gửi ${count} thay đổi lúc mất mạng lên server`, '✓', 3500);
  }
});

function updateSyncUI(st) {
  const connected = st.connected;
  const count = st.clientsCount || 1;
  const waiting = connected ? 0 : pendingChangeCount();
  const waitingText = waiting ? ` (${waiting} thay đổi chờ gửi)` : '';
  if ($('#sidebar-sync-led')) {
    $('#sidebar-sync-led').style.background = connected ? '#16a34a' : '#f59e0b';
  }
  if ($('#sidebar-sync-text')) {
    $('#sidebar-sync-text').textContent = connected
      ? `Đồng bộ Live (${count} thiết bị)`
      : `Đang kết nối lại...${waitingText}`;
  }
  if ($('#lbl-sync-conn-state')) {
    $('#lbl-sync-conn-state').textContent = connected
      ? `Đang đồng bộ (${count})`
      : `Đang kết nối...${waitingText}`;
  }
  if ($('#modal-sync-status-title')) {
    $('#modal-sync-status-title').textContent = connected
      ? '● Đã kết nối máy chủ đồng bộ thời gian thực'
      : '○ Đang kết nối tới máy chủ...';
  }
  if ($('#modal-sync-devices-sub')) {
    $('#modal-sync-devices-sub').textContent =
      count > 1
        ? `${count} thiết bị đang cùng đồng bộ`
        : 'Mới có 1 thiết bị. Nếu điện thoại đang mở app mà số này không tăng thì điện thoại đang dùng server hoặc tài khoản khác.';
  }
}

onSyncStatusChange(updateSyncUI);

/* ============================================================
   Khởi động ban đầu & Kiểm tra phiên đăng nhập
   ============================================================ */
ensureFonts();
updateSidebarShopUI();
renderSalesView();
renderCustomersView();
renderOrdersView();
renderSettingsView();
switchTab('live');

async function bootAppWithAuth() {
  const token = getAuthToken();
  if (!token) {
    applyAuthUserToUI(null);
    return;
  }

  try {
    const res = await apiFetch('/api/auth/me');
    const data = await res.json();
    if (res.ok && data.ok && data.user) {
      setAuthSession(token, data.user);
      applyAuthUserToUI(data.user);
      await fetchInitialStateFromServer();
      connectSync();
    } else {
      clearAuthSession();
      applyAuthUserToUI(null);
      if (data?.error) showAuthBanner(data.error, 'error');
    }
  } catch (_err) {
    // Nếu tạm mất mạng mà đã có user lưu sẵn trên máy thì vẫn hiển thị phiên cũ
    const cachedUser = getCurrentUser();
    if (cachedUser) {
      applyAuthUserToUI(cachedUser);
      connectSync();
    } else {
      applyAuthUserToUI(null);
    }
  }
}

bootAppWithAuth();
