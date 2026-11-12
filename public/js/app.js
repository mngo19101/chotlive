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
  pendingChangeCount,
  setOrdersShip,
  clearManualCod,
  createdDescOf,
  fixCreatedDesc
} from './store.js';
import { VTP_PROVINCES, vtpWardsOf, vtpProvinceByName, normalizeVN } from './vtp-address.js';
import {
  VTP_OLD_PROVINCES,
  vtpOldDistrictsOf,
  vtpOldWardsOf,
  findVtpOldAddress,
  findVtpNewAddress,
  oldKey
} from './vtp-address-old.js';
import {
  shipStateOf,
  shipKeyOf,
  isPending,
  goodsTotal,
  itemQty,
  pendingOrdersOfCustomer,
  olderPendingOf,
  groupByCustomer,
  summarizeGroup,
  buildVtpXlsx,
  vtpFileName,
  vtpAddressLine,
  VTP_SERVICES,
  DEFAULT_VTP_SERVICE,
  DEFAULT_WEIGHT_G
} from './vtp-export.js';
import { downloadBytes } from './xlsx-writer.js';
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
  onSupportMessage,
  onAccountAccess,
  onOfflineChanges
} from './sync.js?v=3';
import { countdownClock, countdownText, remainingText } from './countdown.js';
import {
  parsePrice,
  parsePriceInput,
  formatVND,
  formatPhone,
  extractProductInfo,
  isOnlyCodes,
  stripAccents
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
/** Kết nối Viettel Post của tài khoản (máy chủ giữ token): { connected, phone, sender, hookUrl }. */
let vtpConn = { connected: false };
const priceOpts = () => ({
  multiplier: Number(S().multiplier) || 1000,
  minPrice: 1, // mọi mức giá đều tính (5k, 2k...)
  maxPrice: Number(S().maxPrice) || 1e12
});

function formatVNDHtml(amount) {
  const num = Math.round(Number(amount) || 0).toLocaleString('vi-VN');
  return `${num} <span class="vnd-underline">đ</span>`;
}

const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function toast(msg, mark = '✓', ms = 2400, action = null) {
  const box = $('#web-toast-box');
  if (!box) return;
  const warn = mark === '⚠️';
  const el = document.createElement('div');
  el.className = `toast-item${warn ? ' warn' : ''}`;
  el.innerHTML = `${icon(warn ? 'warn' : 'check')}<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ''}`;
  if (action) {
    el.querySelector('.toast-action').addEventListener('click', () => {
      action.onClick();
      el.remove();
    });
  }
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

/**
 * Hộp hỏi lại của app, thay cho confirm() / prompt() của trình duyệt.
 * Trả về true / false; khi có `input` thì trả về chuỗi đã nhập, hoặc false nếu huỷ.
 */
function askConfirm({ title, message = '', ok = 'Đồng ý', danger = false, input = null }) {
  const dlg = $('#modal-confirm');
  if (!dlg) return Promise.resolve(false);
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  const okBtn = $('#btn-confirm-ok');
  const cancelBtn = $('#btn-confirm-cancel');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'btn-outline-pill btn-detail-del' : 'btn-orange-pill';
  $('#confirm-input-group').hidden = !input;
  if (input) {
    $('#confirm-input-label').textContent = input.label;
    $('#confirm-input').value = '';
    $('#confirm-input').placeholder = input.placeholder || '';
  }
  return new Promise((resolve) => {
    let result = false;
    const onOk = () => {
      result = input ? $('#confirm-input').value.trim() : true;
      dlg.close();
    };
    const onCancel = () => dlg.close();
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener(
      'close',
      () => {
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        resolve(result);
      },
      { once: true }
    );
    dlg.showModal();
  });
}

const askStopLive = (username) =>
  askConfirm({
    title: 'Dừng theo dõi live?',
    message: `Ngừng đọc bình luận của @${username}. Bình luận và đơn đã ghi vẫn giữ nguyên.`,
    ok: 'Dừng theo dõi',
    danger: true
  });

/** Báo lỗi ngay dưới ô nhập bị sai; tự mất khi người dùng sửa ô đó. */
function fieldError(sel, msg) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return toast(msg, '⚠️');
  const group = el.closest('.form-field-group') || el.parentElement;
  group.querySelector('.field-error.auto')?.remove();
  const p = document.createElement('p');
  p.className = 'field-error auto';
  p.setAttribute('role', 'alert');
  p.textContent = msg;
  group.appendChild(p);
  el.setAttribute('aria-invalid', 'true');
  el.focus?.();
  const clear = () => {
    p.remove();
    el.removeAttribute('aria-invalid');
  };
  el.addEventListener('input', clear, { once: true });
  el.addEventListener('change', clear, { once: true });
}

// Đóng hộp thoại thì xoá các dòng báo lỗi còn sót, lần mở sau không hiện lỗi cũ.
document.addEventListener(
  'close',
  (e) => {
    if (!(e.target instanceof HTMLDialogElement)) return;
    $$('.field-error.auto', e.target).forEach((p) => p.remove());
    $$('[aria-invalid]', e.target).forEach((x) => x.removeAttribute('aria-invalid'));
  },
  true
);

// Dòng và thẻ bấm được (role="button") dùng được bằng phím Enter / dấu cách.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"]')) {
    e.preventDefault();
    e.target.click();
  }
});

// Nút Hiện / Ẩn cạnh ô mật khẩu.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-toggle-pass]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.togglePass);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Ẩn' : 'Hiện';
  btn.setAttribute('aria-pressed', String(show));
});

/** Trang con đang mở ở tab Tôi. */
let settingsPane = 'account';
function openSettingsPane(name) {
  if (activeTab !== 'settings') switchTab('settings');
  settingsPane = name;
  $$('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.paneId === name));
  $$('#settings-menu [data-pane]').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $('#settings-md')?.classList.add('has-pane');
}

/* Trang Giao diện: nền sáng/tối và màu chủ đạo (thanh bên đi theo nền). Việc áp màu nằm ở /js/theme.js. */
const THEME_NAMES = { orange: 'Cam', red: 'Đỏ', pink: 'Hồng', purple: 'Tím', blue: 'Xanh dương', teal: 'Xanh ngọc', green: 'Xanh lá', mono: 'Đen trắng' };
const THEME_MODES = { auto: 'Theo máy', light: 'Sáng', dark: 'Tối' };
function renderThemeControls() {
  const t = window.chotTheme?.get();
  if (!t) return;
  const mark = (attr, val) => $$(`[${attr}]`).forEach((b) => {
    const on = b.getAttribute(attr) === val;
    b.setAttribute('aria-pressed', String(on));
    if (b.classList.contains('segment-pill-btn')) b.classList.toggle('active', on);
  });
  mark('data-theme-mode', t.mode);
  mark('data-theme-accent', t.accent);
  const lbl = $('#lbl-theme-summary');
  if (lbl) lbl.textContent = `${THEME_MODES[t.mode]} · ${THEME_NAMES[t.accent]}`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-theme-mode], [data-theme-accent], #btn-theme-reset');
  if (!b || !window.chotTheme) return;
  if (b.id === 'btn-theme-reset') window.chotTheme.set({ mode: 'auto', accent: 'orange' });
  else if (b.dataset.themeMode) window.chotTheme.set({ mode: b.dataset.themeMode });
  else window.chotTheme.set({ accent: b.dataset.themeAccent });
  renderThemeControls();
});
$('#menu-row-appearance')?.addEventListener('click', () => openSettingsPane('appearance'));
renderThemeControls();

/** Đơn vừa bấm xoá, còn trong 5 giây hoàn tác: ẩn khỏi danh sách, chưa xoá thật. */
const hiddenOrderIds = new Set();

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
  if (tabName === 'settings') {
    renderSettingsView();
    $('#settings-md')?.classList.remove('has-pane');
  }
  if (tabName === 'admin') {
    loadAdminUsers();
    loadSupportList();
  }

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
      lbl.className = 'badge-in-use';
    }
    if (quickName) quickName.textContent = printerState.deviceName || 'Xprinter 80mm';
    if (quickLed) quickLed.style.background = '#16a34a';
    if (headerLed) headerLed.style.background = '#16a34a';
  } else {
    if (lbl) {
      lbl.textContent = 'Chưa kết nối';
      lbl.className = 'badge-off';
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
/** Đang tải bình luận từ server cho phiên đang xem. */
let olderLoading = false;
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
  updateLiveDateLabel();
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
        <div class="session-row-card" data-select-session="s_evening" role="button" tabindex="0">
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
        <div class="session-row-card" data-select-session="s_noon" role="button" tabindex="0">
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
    // Phiên đang live chỉ hiện ở khoảng ngày có hôm nay, không lẫn sang "Hôm qua".
    .filter((s) => inDay(s.startTs || 0) || (s.isLive && inDay(Date.now())))
    .sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
  const shownOrders = orders.filter((o) => inDay(Number(o.ts) || 0));
  const shownGuests = new Set(shownOrders.map((o) => (o.uniqueId || o.nickname || '').toLowerCase()));
  const totalComments = shownSessions.reduce((n, s) => n + (Number(s.commentCount) || 0), 0);

  if ($('#overview-cnt-sessions')) $('#overview-cnt-sessions').textContent = String(shownSessions.length);
  if ($('#overview-cnt-comments')) $('#overview-cnt-comments').textContent = String(totalComments);
  if ($('#overview-cnt-guests')) $('#overview-cnt-guests').textContent = String(shownGuests.size);
  if ($('#overview-cnt-orders')) $('#overview-cnt-orders').textContent = String(shownOrders.length);
  if ($('#overview-sessions-sub')) $('#overview-sessions-sub').textContent = `${shownSessions.length} phiên`;
  if ($('.sessions-section-heading h3')) $('.sessions-section-heading h3').textContent = `Các phiên · ${liveRangeText()}`;

  renderTimelineChunks(sessions);

  const listBox = $('#sessions-list-container');
  if (listBox) {
    if (shownSessions.length === 0) {
      listBox.innerHTML = `
        <div class="empty-box">
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
          <div class="session-row-card" data-select-session="${esc(s.id)}" role="button" tabindex="0">
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

/** Khoảng ngày tự chọn ở tab Bình luận, dùng khi sessionDayFilter === 'range'. */
let liveDayFrom = null;
let liveDayTo = null;

/** Ngày đang xem nếu bộ lọc là đúng một ngày, không thì null. */
function liveSingleDay() {
  const today = dayStart();
  if (sessionDayFilter === 'Hôm nay') return today;
  if (sessionDayFilter === 'Hôm qua') return addDays(today, -1);
  if (sessionDayFilter === 'range' && liveDayFrom === liveDayTo) return liveDayFrom;
  return null;
}

function liveRangeText() {
  if (sessionDayFilter !== 'range') return sessionDayFilter;
  return liveDayFrom === liveDayTo ? dayText(liveDayFrom) : `${dayText(liveDayFrom)} → ${dayText(liveDayTo)}`;
}

function updateLiveDateLabel() {
  const today = dayStart();
  const single = liveSingleDay();
  const prefix = single === today ? 'Hôm nay · ' : single === addDays(today, -1) ? 'Hôm qua · ' : '';
  if ($('#lbl-current-nav-date')) $('#lbl-current-nav-date').textContent = single !== null ? prefix + dayText(single) : liveRangeText();
  if ($('#live-header-date')) {
    const text = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    $('#live-header-date').textContent = text.charAt(0).toUpperCase() + text.slice(1);
  }
  if ($('#btn-next-day-nav')) $('#btn-next-day-nav').disabled = single === null || single >= today;
  if ($('#btn-prev-day-nav')) $('#btn-prev-day-nav').disabled = single === null;
  $$('[data-day-chip]').forEach((b) => b.classList.toggle('active', b.dataset.dayChip === sessionDayFilter));
}

function setLiveRange(from, to = from) {
  const today = dayStart();
  liveDayFrom = Math.min(from, to);
  liveDayTo = Math.max(from, to);
  const one = liveDayFrom === liveDayTo;
  sessionDayFilter = one && liveDayFrom === today ? 'Hôm nay' : one && liveDayFrom === addDays(today, -1) ? 'Hôm qua' : 'range';
  renderSessionsOverview();
}

function shiftLiveDay(n) {
  const cur = liveSingleDay();
  if (cur === null) return;
  setLiveRange(Math.min(dayStart(addDays(cur, n)), dayStart()));
}

function isInSessionDayFilter(ts) {
  if (sessionDayFilter === 'range') return ts >= liveDayFrom && ts < addDays(liveDayTo, 1);
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
      return `<div class="timeline-live-chunk ${s.isLive ? 'active-chunk' : ''}" data-select-session="${esc(s.id)}" title="${esc(s.name || 'Phiên live')}" style="left:${left}%;width:${width}%"></div>`;
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
  // Nút Dừng live: dừng live đang xem; chưa chọn live nào mà chỉ có một live thì dừng live đó.
  const stopBtn = $('#btn-stop-live');
  if (stopBtn) {
    const target = session
      ? activeLives.find((l) => l.sessionId === session.id)
      : activeLives.length === 1
      ? activeLives[0]
      : null;
    stopBtn.hidden = !target;
    stopBtn.dataset.stopLive = target ? target.username : '';
    stopBtn.textContent = target ? `Dừng live @${target.username}` : 'Dừng live';
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
    renderCommentScopeHeader();
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
          <button type="button" class="live-chip-stop" data-stop-live="${esc(l.username)}" aria-label="Dừng theo dõi @${esc(l.username)}">Dừng</button>
        </div>`;
      })
      .join('');
  renderCommentScopeHeader();
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
  // Phiên cũ không còn trong phần bình luận mới nhất đã có sẵn: tự tải về, khỏi phải bấm "Xem thêm".
  if (sessionId && !isDemoAccount() && !olderExhausted && commentsInScope().length < COMMENT_PAGE) {
    loadOlderComments({ grow: false });
  }
}

$('#btn-stop-live')?.addEventListener('click', async (e) => {
  const username = e.currentTarget.dataset.stopLive;
  if (!username) return;
  if (!(await askStopLive(username))) return;
  if (!sendLiveCommand('disconnect', username)) toast('Chưa nối được server, thử lại sau', '⚠️');
});

$('#active-lives-strip')?.addEventListener('click', async (e) => {
  const stop = e.target.closest('[data-stop-live]');
  if (stop) {
    e.stopPropagation();
    const username = stop.dataset.stopLive;
    if (!(await askStopLive(username))) return;
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
}

function formatCommentText(rawText) {
  let text = esc(rawText);
  text = text.replace(/(Mã\s+\d+)/gi, '<b>$1</b>');
  text = text.replace(/(\b\d{2,4}\b(?=\s+với|\s+nữa|\s+ạ|\s+nha|\s+chốt))/gi, '<b>$1</b>');
  return text;
}

/** Từ khoá chốt đơn, giống mặc định của app iPhone và Android. */
const closingKeywords = () =>
  String(S().triggers || 'chot, lay')
    .split(',')
    .map((k) => stripAccents(k.trim().toLowerCase()))
    .filter(Boolean);

/**
 * Bình luận chốt đơn: đã in, có từ khoá chốt, hoặc chỉ ghi mã.
 * Có số thôi chưa đủ: "35 tuổi" hay "Cho em xem mã 25 với" không phải chốt đơn.
 */
function isClosingComment(c) {
  if (c.printed) return true;
  const text = stripAccents(String(c.comment || '').toLowerCase());
  if (closingKeywords().some((k) => text.includes(k))) return true;
  return isOnlyCodes(c.comment, priceOpts());
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const isRealUserId = (id) => /^\d{8,}$/.test(String(id || ''));

/**
 * Khách mới: lần đầu có đơn đúng vào ngày của phiên live, giống app điện thoại.
 * Trả về hàm kiểm tra cho từng bình luận.
 */
function newCustomerChecker() {
  const byUser = new Map();
  const byUid = new Map();
  const keep = (map, key, ts) => {
    if (key && !(map.get(key) <= ts)) map.set(key, ts);
  };
  for (const o of state.orders || []) {
    if (o.status === 'cancelled') continue;
    for (const it of o.items || []) {
      const ts = Number(it.ts) || Number(o.ts) || 0;
      if (!ts) continue;
      if (isRealUserId(o.userId)) keep(byUser, String(o.userId), ts);
      keep(byUid, String(o.uniqueId || '').toLowerCase(), ts);
    }
  }
  const sessionStart = new Map((state.sessions || []).map((x) => [x.id, Number(x.startTs) || 0]));
  return (c) => {
    const first = (isRealUserId(c.userId) && byUser.get(String(c.userId))) || byUid.get(String(c.uniqueId || '').toLowerCase());
    if (!first) return false;
    return sameDay(first, sessionStart.get(c.sessionId) || Number(c.ts) || Date.now());
  };
}

function customerKeyOf(c) {
  return isRealUserId(c.userId) ? String(c.userId) : String(c.uniqueId || '').toLowerCase();
}

function matchesLiveFilter(c, isNewCustomer) {
  if (liveFilter === 'deals') return isClosingComment(c);
  if (liveFilter === 'new') return isNewCustomer(c);
  return true;
}

function renderCommentStream() {
  const container = $('#comment-stream-container');
  if (!container) return;

  const isDemo = isDemoAccount();
  const liveComments = commentsInScope();
  const isNewCustomer = newCustomerChecker();

  const filtered = liveComments.filter((c) => matchesLiveFilter(c, isNewCustomer));

  const scopeSessions = (state.sessions || []).filter((s) => !commentScopeSessionId || s.id === commentScopeSessionId);
  const countAll = isDemo
    ? liveComments.length >= 6
      ? 208 + liveComments.length
      : liveComments.length
    : Math.max(scopeSessions.reduce((n, s) => n + (Number(s.commentCount) || 0), 0), liveComments.length);
  // Bình luận đã chốt có thể chưa được tải về: đếm cả các món đã lưu thành đơn trong phiên.
  const scopeIds = new Set(scopeSessions.map((s) => s.id));
  const scopeItems = (state.orders || [])
    .filter((o) => o.status !== 'cancelled')
    .flatMap((o) => (o.items || []).filter((it) => scopeIds.has(it.sessionId)).map((it) => ({ o, it })));
  const dealIds = new Set(liveComments.filter(isClosingComment).map((c) => String(c.id)));
  for (const { it } of scopeItems) dealIds.add(String(it.commentId || it.id));
  const countDeals = isDemo ? 28 + dealIds.size : dealIds.size;
  const newKeys = new Set(liveComments.filter(isNewCustomer).map(customerKeyOf));
  for (const { o, it } of scopeItems) {
    if (isNewCustomer({ userId: o.userId, uniqueId: o.uniqueId, sessionId: it.sessionId, ts: it.ts })) newKeys.add(customerKeyOf(o));
  }
  const countNew = isDemo ? 9 : newKeys.size;
  if ($('#chip-live-all')) $('#chip-live-all').textContent = `Tất cả ${countAll}`;
  if ($('#chip-live-deals')) $('#chip-live-deals').textContent = `Chốt đơn ${countDeals}`;
  if ($('#chip-live-new')) $('#chip-live-new').textContent = `Khách mới ${countNew}`;

  // Chỉ dựng số dòng vừa đủ để trang không chậm dần; phần còn lại mở bằng nút "Xem thêm".
  const shownRows = filtered.slice(0, commentRenderLimit);
  const moreBtn = $('#btn-load-older-comments');
  if (moreBtn) {
    const canLoadMore = !isDemo && !olderExhausted && countAll > liveComments.length;
    moreBtn.style.display = filtered.length > shownRows.length || canLoadMore || olderLoading ? 'block' : 'none';
    moreBtn.disabled = olderLoading;
    moreBtn.textContent = olderLoading ? 'Đang tải...' : 'Xem thêm bình luận cũ hơn';
  }

  if (filtered.length === 0) {
    const scopeLive = commentScopeSessionId && activeLives.some((l) => l.sessionId === commentScopeSessionId);
    container.innerHTML = `
      <div class="empty-box">
        ${
          olderLoading
            ? 'Đang tải bình luận của phiên này...'
            : commentScopeSessionId && liveComments.length && liveFilter !== 'all'
            ? 'Không có bình luận nào hợp bộ lọc này.'
            : commentScopeSessionId && !scopeLive
            ? olderExhausted
              ? 'Phiên này không có bình luận nào.'
              : 'Chưa tải được bình luận. Bấm <b>Xem thêm</b> bên dưới để thử lại.'
            : activeLives.length
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
      const tagBadge =
        c.tag === 'Mua nhiều'
          ? '<span class="badge-pill-tag badge-tag-loyal">Mua nhiều</span>'
          : isNewCustomer(c)
          ? '<span class="badge-pill-tag badge-tag-new">Mới</span>'
          : '';

      const isPrinted = Boolean(c.printed);
      // Bình luận nào cũng in được: không có giá thì vẫn lưu vào khách với giá 0.
      const printBtnHtml = `
        <button class="btn-cmt-quick-print ${isPrinted ? 'printed' : ''}" data-cmt-print-id="${esc(c.id)}" data-cmt-print-user="${esc(c.uniqueId)}">
          ${icon('print', 'sm')}
          <span>${isPrinted ? 'Đã in' : 'In'}</span>
        </button>
      `;

      const warmClass = isWarmAvatar(c) ? 'warm' : '';
      const isNewRow = !isFirstPaint && !renderedCommentIds.has(String(c.id));
      renderedCommentIds.add(String(c.id));

      return `
        <div class="comment-row-item ${isNewRow ? 'is-new' : ''}" data-comment-user="${esc(c.uniqueId)}">
          <div class="comment-left">
            <button type="button" class="user-circle-avatar ${warmClass}" data-cmt-profile="${esc(c.uniqueId)}" aria-label="Xem hồ sơ của ${esc(c.nickname || c.uniqueId)}">${avatarInitial(c.nickname || c.uniqueId)}</button>
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

$('#btn-load-older-comments')?.addEventListener('click', () => {
  const isNewCustomer = newCustomerChecker();
  const filteredCount = commentsInScope().filter((c) => matchesLiveFilter(c, isNewCustomer)).length;
  if (commentRenderLimit < filteredCount) {
    commentRenderLimit += COMMENT_PAGE;
    renderCommentStream();
    return;
  }
  loadOlderComments({ grow: true });
});

/** Tải trang bình luận cũ tiếp theo của phạm vi đang xem. grow: mở thêm một trang dòng hiển thị. */
async function loadOlderComments({ grow }) {
  if (olderLoading) return;
  const scope = commentScopeSessionId;
  const loaded = commentsInScope();
  // Nhiều bình luận có thể trùng thời gian: lấy đúng bình luận cuối theo thứ tự của server (thời gian rồi id).
  const oldest = loaded.reduce((min, c) => {
    if (!min) return c;
    const diff = Number(c.ts) - Number(min.ts);
    return diff < 0 || (diff === 0 && String(c.id) < String(min.id)) ? c : min;
  }, null);
  olderLoading = true;
  renderCommentStream();
  const params = new URLSearchParams({ limit: String(COMMENT_PAGE) });
  if (oldest?.ts) {
    params.set('before', String(oldest.ts));
    params.set('beforeId', String(oldest.id));
  }
  if (scope) params.set('sessionId', scope);
  try {
    const data = await apiFetch(`/api/comments?${params}`, { method: 'GET', cache: 'no-store' });
    if (!data.ok) throw new Error(data.error || 'Không tải được');
    // Đã chuyển sang phiên khác trong lúc tải: bỏ kết quả, phiên mới tự tải phần của nó.
    if (scope !== commentScopeSessionId) return;
    for (const c of data.comments || []) olderComments.set(String(c.id), c);
    if (!data.hasMore) olderExhausted = true;
    if (grow) commentRenderLimit += COMMENT_PAGE;
  } catch {
    if (scope === commentScopeSessionId) toast('Không tải được bình luận cũ, thử lại sau', '⚠️');
  } finally {
    olderLoading = false;
    renderCommentStream();
    if (scope !== commentScopeSessionId) setCommentScope(commentScopeSessionId);
  }
}

$('#comment-stream-container')?.addEventListener('click', (e) => {
  const btnPrint = e.target.closest('[data-cmt-print-user]');
  if (btnPrint) {
    e.stopPropagation();
    const uid = btnPrint.dataset.cmtPrintUser;
    setSelectedCustomerUid(uid);
    printSingleComment(btnPrint.dataset.cmtPrintId);
    return;
  }
  const who = e.target.closest('[data-cmt-profile]');
  if (who) {
    const uid = who.dataset.cmtProfile;
    if (!findCustomerByUid(uid)) return toast('Khách này chưa có đơn nên chưa có hồ sơ', '⚠️');
    switchTab('customers');
    openCustomerProfileView(uid);
  }
});

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

  if (seg === 'timeline') {
    if (overview) overview.style.display = 'block';
    if (details) details.style.display = 'none';
    if (btnTimeline) btnTimeline.classList.add('active');
    if (btnLive) btnLive.classList.remove('active');
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
    sessionDayFilter = btn.dataset.dayChip;
    renderSessionsOverview();
  });
});

$('#btn-date-picker-trigger')?.addEventListener('click', openLiveTimeFilter);

$('#btn-prev-day-nav')?.addEventListener('click', () => shiftLiveDay(-1));
$('#btn-next-day-nav')?.addEventListener('click', () => shiftLiveDay(1));


/* ---------- Bảng "Xem lại thời điểm" dùng để lọc đơn theo ngày / khoảng ngày ---------- */
let timeFilterCtx = null; // 'orders' khi mở từ tab Đơn hàng, 'live' khi mở từ tab Bình luận
const calSel = { month: 0, from: null, to: null };
const MONTHS = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
const minText = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const parseMin = (v, fallback) => {
  const m = /^(\d{1,2})[:h.](\d{2})$/.exec(String(v || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
};

function renderOrderCalendar() {
  const first = new Date(calSel.month);
  first.setDate(1);
  $('#cal-month-label').textContent = `${MONTHS[first.getMonth()]}, ${first.getFullYear()}`;
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // tuần bắt đầu thứ Hai
  const today = dayStart();
  const lo = calSel.from;
  const hi = calSel.to ?? calSel.from;
  let html = '';
  for (let w = 0; w < 6; w++) {
    html += '<tr>';
    for (let k = 0; k < 7; k++) {
      const t = dayStart(addDays(start.getTime(), w * 7 + k));
      const d = new Date(t);
      const cls = [
        d.getMonth() !== first.getMonth() ? 'muted' : '',
        t > today ? 'future' : '',
        t === lo || t === hi ? 'active' : lo !== null && t > lo && t < hi ? 'in-range' : ''
      ].filter(Boolean).join(' ');
      html += `<td class="${cls}" data-cal-ts="${t}"><span>${d.getDate()}</span></td>`;
    }
    html += '</tr>';
  }
  $('#cal-grid-tbody').innerHTML = html;
}

function markTimeChip() {
  const today = dayStart();
  const m0 = new Date(today);
  m0.setDate(1);
  const lastM = new Date(m0);
  lastM.setMonth(lastM.getMonth() - 1);
  const ranges = {
    today: [today, today],
    yesterday: [addDays(today, -1), addDays(today, -1)],
    '7days': [addDays(today, -6), today],
    '30days': [addDays(today, -29), today],
    thismonth: [m0.getTime(), today],
    lastmonth: [lastM.getTime(), addDays(m0.getTime(), -1)]
  };
  const hi = calSel.to ?? calSel.from;
  $$('[data-time-chip]').forEach((b) => {
    const r = ranges[b.dataset.timeChip];
    b.classList.toggle('active', !!r && r[0] === calSel.from && r[1] === hi);
  });
  return ranges;
}

function openOrderTimeFilter() {
  timeFilterCtx = 'orders';
  calSel.from = orderDayFrom;
  calSel.to = orderDayTo;
  calSel.month = orderDayTo;
  $('#input-time-from').value = minText(orderMinFrom);
  $('#input-time-to').value = minText(orderMinTo);
  $('#time-range-block').hidden = false;
  renderOrderCalendar();
  markTimeChip();
  $('#modal-filter-time')?.showModal();
}

function openLiveTimeFilter() {
  timeFilterCtx = 'live';
  const today = dayStart();
  const monthStart = new Date(today);
  monthStart.setDate(1);
  const [from, to] =
    sessionDayFilter === 'range'
      ? [liveDayFrom, liveDayTo]
      : sessionDayFilter === 'Hôm qua'
      ? [addDays(today, -1), addDays(today, -1)]
      : sessionDayFilter === '7 ngày'
      ? [addDays(today, -6), today]
      : sessionDayFilter === 'Tháng này'
      ? [monthStart.getTime(), today]
      : [today, today];
  calSel.from = from;
  calSel.to = to;
  calSel.month = to;
  // Tab Bình luận chỉ lọc theo ngày, không theo khung giờ.
  $('#time-range-block').hidden = true;
  renderOrderCalendar();
  markTimeChip();
  $('#modal-filter-time')?.showModal();
}

$('#modal-filter-time')?.addEventListener('close', () => {
  timeFilterCtx = null;
});

$('#cal-grid-tbody')?.addEventListener('click', (e) => {
  if (timeFilterCtx) {
    const cell = e.target.closest('td[data-cal-ts]');
    if (!cell || cell.classList.contains('future')) return;
    const t = Number(cell.dataset.calTs);
    // Bấm lần đầu chọn một ngày; bấm ngày thứ hai thành khoảng từ ngày đến ngày.
    if (calSel.from === null || calSel.to !== null) {
      calSel.from = t;
      calSel.to = null;
    } else {
      calSel.to = Math.max(t, calSel.from);
      calSel.from = Math.min(t, calSel.from);
    }
    renderOrderCalendar();
    markTimeChip();
    return;
  }
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
      <div class="empty-box">
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
  if (!val) return fieldError(input, 'Nhập ID TikTok Live hoặc dán link phiên live');

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



$$('[data-time-chip]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-time-chip]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (!timeFilterCtx) return;
    const r = markTimeChip()[btn.dataset.timeChip];
    if (!r) return;
    [calSel.from, calSel.to] = r;
    calSel.month = r[1];
    renderOrderCalendar();
    markTimeChip();
  });
});

$('#btn-cal-prev')?.addEventListener('click', () => {
  if (!timeFilterCtx) return;
  const d = new Date(calSel.month);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  calSel.month = d.getTime();
  renderOrderCalendar();
});
$('#btn-cal-next')?.addEventListener('click', () => {
  if (!timeFilterCtx) return;
  const d = new Date(calSel.month);
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  if (d.getTime() > dayStart()) return;
  calSel.month = d.getTime();
  renderOrderCalendar();
});

$('#btn-apply-time-filter')?.addEventListener('click', () => {
  if (timeFilterCtx === 'orders') {
    orderMinFrom = parseMin($('#input-time-from').value, 0);
    orderMinTo = parseMin($('#input-time-to').value, 24 * 60 - 1);
    const from = calSel.from ?? dayStart();
    $('#modal-filter-time')?.close();
    setOrderRange(from, calSel.to ?? from);
    toast(`Đang xem đơn ${orderRangeLabel()}`, '🗓');
    return;
  }
  if (timeFilterCtx === 'live') {
    const from = calSel.from ?? dayStart();
    const to = calSel.to ?? from;
    $('#modal-filter-time')?.close();
    setLiveRange(from, to);
    return;
  }
  $('#modal-filter-time')?.close();
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
      <div class="empty-box">
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
        <div class="customer-row-item${c.uniqueId === currentProfileUniqueId ? ' active' : ''}" data-view-profile="${esc(c.uniqueId)}" role="button" tabindex="0">
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

/** Nhãn trạng thái thật của đơn, dùng ở lịch sử mua hàng của khách. */
function orderStateBadge(o) {
  const st = shipStateOf(o);
  const [text, cls] =
    o.status === 'done'
      ? ['Đã giao', 'status-done-badge']
      : isVtpReturned(o)
      ? ['Hoàn về', 'ship-tag-vtp-bad']
      : o.status === 'shipping' || st === 'exported' || st === 'gone'
      ? ['Đang giao', 'ship-tag-ready']
      : st === 'ready'
      ? ['Chờ gửi', 'ship-tag-ready']
      : st === 'hold'
      ? ['Gom sau', 'ship-tag-old']
      : ['Đơn mới', 'status-new-badge'];
  return `<span class="badge-order-status ${cls}">${text}</span>`;
}

const findCustomerByUid = (uniqueId) =>
  state.customers.find((c) => (c.uniqueId || '').toLowerCase() === (uniqueId || '').toLowerCase());

const joinRegion = ({ ward, district, province } = {}) => [ward, district, province].filter(Boolean).join(', ');

function openCustomerProfileView(uniqueId) {
  currentProfileUniqueId = uniqueId;
  const cust = findCustomerByUid(uniqueId);
  if (!cust) return;

  $('#subview-customers-list').style.display = 'none';
  $('#subview-customer-profile').style.display = 'block';
  $$('.customer-row-item').forEach((r) => r.classList.toggle('active', r.dataset.viewProfile === cust.uniqueId));

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
  $('#prof-addr-receiver').textContent = cust.receiver || cust.name;
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
        const itemCount = o.items?.reduce((s, it) => s + (Number(it.qty) || 1), 0) || o.items?.length || 1;
        return `
          <div class="history-order-row" data-order-click="${o.id}" role="button" tabindex="0">
            <div class="hist-order-date">
              <span class="hist-date-main">${esc(o.dateStr || '25/10')}</span>
              <span class="hist-time-sub">${esc(o.timeStr || '20:42')}</span>
            </div>
            <span class="hist-items-count">${itemCount} sản phẩm</span>
            <div class="hist-right-stack">
              <span class="hist-amount">${formatVNDHtml(o.total || 0)}</span>
              ${orderStateBadge(o)}
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

/**
 * Bảng chọn khu vực có hai chế độ như app điện thoại, cả hai lấy đúng danh mục Viettel Post:
 * - mới: Tỉnh (34) → Phường/Xã, lưu district = ''
 * - cũ: Tỉnh (63) → Quận/Huyện → Phường/Xã, tên kiểu "P.Bến Nghé, Q.1, TP.Hồ Chí Minh"
 */
let areaMode = 'new';

const areaProvinces = () => (areaMode === 'old' ? VTP_OLD_PROVINCES : VTP_PROVINCES);

/** Tỉnh, quận và phường đang chọn trong bảng chọn khu vực. */
function readAreaInputs() {
  const pid = $('#area-input-province').value;
  const prov = areaProvinces().find(([id]) => String(id) === pid);
  return {
    ward: $('#area-input-ward').value || '',
    district: areaMode === 'old' ? $('#area-input-district').value || '' : '',
    province: prov ? prov[1] : ''
  };
}

function fillProvinceOptions(selectedId = '') {
  $('#area-input-province').innerHTML =
    '<option value="">Chọn tỉnh / thành</option>' +
    areaProvinces()
      .map(([id, name]) => `<option value="${id}" ${String(id) === String(selectedId) ? 'selected' : ''}>${esc(name)}</option>`)
      .join('');
}

function fillDistrictOptions(selected = '') {
  const pid = $('#area-input-province').value;
  const list = pid ? vtpOldDistrictsOf(pid) : [];
  $('#area-input-district').innerHTML = pid
    ? '<option value="">Chọn quận / huyện</option>' +
      list.map((d) => `<option value="${esc(d)}" ${d === selected ? 'selected' : ''}>${esc(d)}</option>`).join('')
    : '<option value="">Chọn tỉnh / thành trước</option>';
}

function fillWardOptions(selected = '') {
  const pid = $('#area-input-province').value;
  const dist = areaMode === 'old' ? $('#area-input-district').value : '';
  const q = normalizeVN($('#area-input-ward-search').value);
  const wards = !pid ? [] : areaMode === 'old' ? (dist ? vtpOldWardsOf(pid, dist) : []) : vtpWardsOf(pid);
  const list = q ? wards.filter((w) => normalizeVN(w.replace(/\./g, ' ')).includes(q)) : wards;
  const sel = $('#area-input-ward');
  const waiting = !pid ? 'Chọn tỉnh / thành trước' : areaMode === 'old' && !dist ? 'Chọn quận / huyện trước' : '';
  sel.innerHTML = waiting
    ? `<option value="" disabled>${waiting}</option>`
    : list.map((w) => `<option value="${esc(w)}" ${w === selected ? 'selected' : ''}>${esc(w)}</option>`).join('') ||
      '<option value="" disabled>Không thấy phường/xã nào</option>';
  if (selected && !list.includes(selected)) sel.value = '';
}


/* ---------- Ô chọn có tìm kiếm cho <select> (tỉnh, quận/huyện): gõ không dấu cũng ra ---------- */
const comboSyncers = [];
function makeCombo(sel) {
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-field-input combo-input';
  input.autocomplete = 'off';
  input.placeholder = sel.dataset.combo || 'Gõ để tìm';
  const caret = document.createElement('span');
  caret.className = 'combo-caret';
  caret.textContent = '⌵';
  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.hidden = true;
  sel.after(wrap);
  wrap.append(input, caret, list);
  sel.hidden = true;
  let active = -1;

  const options = () => [...sel.options].filter((o) => o.value !== '');
  const syncText = () => {
    const o = sel.selectedOptions[0];
    input.value = o && o.value !== '' ? o.textContent : '';
    input.disabled = sel.options.length <= 1 && !sel.value && /trước/.test(sel.options[0]?.textContent || '');
    if (input.disabled) input.placeholder = sel.options[0]?.textContent || '';
    else input.placeholder = sel.dataset.combo || 'Gõ để tìm';
  };
  const render = (q) => {
    const key = normalizeVN(q || '');
    const found = options().filter((o) => !key || normalizeVN(o.textContent.replace(/\./g, ' ')).includes(key));
    active = found.length ? 0 : -1;
    list.innerHTML = found.length
      ? found
          .map(
            (o, i) =>
              `<li class="combo-item${o.value === sel.value ? ' selected' : ''}${i === 0 ? ' active' : ''}" data-v="${esc(o.value)}">${esc(o.textContent)}</li>`
          )
          .join('')
      : '<li class="combo-empty">Không thấy kết quả</li>';
    list.hidden = false;
  };
  const pick = (v) => {
    sel.value = v;
    list.hidden = true;
    syncText();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  input.addEventListener('focus', () => {
    input.select();
    render('');
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.combo-item')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) render(input.value);
      else if (items.length) {
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle('active', i === active));
        items[active].scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!list.hidden && items[active]) pick(items[active].dataset.v);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.stopPropagation();
      list.hidden = true;
      syncText();
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.combo-item');
    if (!li) return;
    e.preventDefault();
    pick(li.dataset.v);
  });
  input.addEventListener('blur', () => {
    list.hidden = true;
    syncText();
  });
  new MutationObserver(syncText).observe(sel, { childList: true });
  syncText();
  comboSyncers.push(syncText);
}
$$('select[data-combo]').forEach(makeCombo);

function updateAreaSummary() {
  comboSyncers.forEach((f) => f());
  const a = readAreaInputs();
  const done = a.province && a.ward && (areaMode === 'new' || a.district);
  $('#area-summary-text').textContent = done ? joinRegion(a) : 'Chưa chọn đủ';
  // Địa chỉ cũ: cho xem luôn phường mới mà Viettel Post gộp vào, để đối chiếu với khách.
  const equiv = $('#area-equiv-hint');
  const r = done && areaMode === 'old' ? findVtpOldAddress(a) : null;
  equiv.hidden = !r?.newWard;
  equiv.textContent = r?.newWard ? `Theo địa chỉ mới: ${r.newWard}, ${r.newProvince}` : '';
}

function setAreaMode(mode) {
  areaMode = mode;
  $$('[data-area-mode]').forEach((b) => b.classList.toggle('active', b.dataset.areaMode === mode));
  $('#area-district-group').hidden = mode !== 'old';
  $('#area-input-ward-search').placeholder = mode === 'old' ? 'Gõ để tìm, ví dụ: Bến Nghé' : 'Gõ để tìm, ví dụ: Tân Định';
}

/** Mở bảng chọn khu vực, chọn sẵn theo địa chỉ đang có nếu khớp danh mục Viettel Post (mới hoặc cũ). */
function openAreaPicker() {
  const isOld = !!editingArea.district;
  setAreaMode(isOld ? 'old' : 'new');
  $('#area-input-ward-search').value = '';
  let matched = null;
  if (isOld) {
    matched = findVtpOldAddress(editingArea);
    const prov = matched
      ? VTP_OLD_PROVINCES.find(([, n]) => n === matched.province)
      : VTP_OLD_PROVINCES.find(([, n]) => oldKey(n) === oldKey(editingArea.province));
    fillProvinceOptions(prov ? prov[0] : '');
    fillDistrictOptions(matched ? matched.district : '');
    fillWardOptions(matched ? matched.ward : '');
  } else {
    matched = findVtpNewAddress(editingArea);
    const prov = matched
      ? VTP_PROVINCES.find(([, n]) => n === matched.province)
      : vtpProvinceByName(editingArea.province);
    fillProvinceOptions(prov ? prov[0] : '');
    fillDistrictOptions();
    fillWardOptions(matched ? matched.ward : '');
  }

  const saved = joinRegion(editingArea);
  const exact = matched && joinRegion(matched) === saved;
  const hint = $('#area-old-hint');
  hint.hidden = !saved || exact;
  hint.textContent = !saved || exact
    ? ''
    : matched
      ? `Địa chỉ đang lưu: ${saved}. Đã chọn sẵn tên đúng theo Viettel Post, bấm Xác nhận để lưu.`
      : `Địa chỉ đang lưu: ${saved}. Không có trong danh mục Viettel Post, chọn lại.`;
  updateAreaSummary();
  $('#modal-select-area')?.showModal();
}

$$('[data-area-mode]').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (btn.dataset.areaMode === areaMode) return;
    setAreaMode(btn.dataset.areaMode);
    $('#area-input-ward-search').value = '';
    fillProvinceOptions();
    fillDistrictOptions();
    fillWardOptions();
    updateAreaSummary();
  })
);

$('#btn-open-edit-address')?.addEventListener('click', () => openAddressEditor(currentProfileUniqueId));

/** Mở form sửa địa chỉ của khách; gọi được cả từ bảng Giao hàng và màn Xuất Viettel Post. */
function openAddressEditor(uniqueId) {
  const cust = findCustomerByUid(uniqueId);
  if (!cust) return toast('Không tìm thấy hồ sơ khách này', '⚠️');
  currentProfileUniqueId = cust.uniqueId;

  editingArea = { ward: cust.ward || '', district: cust.district || '', province: cust.province || '' };
  $('#edit-addr-subtitle').textContent = `${cust.name} · @${cust.uniqueId}`;
  $('#edit-addr-input-phone').value = cust.phone || '';
  $('#edit-addr-input-name').value = cust.receiver || cust.name || '';
  // Địa chỉ cũ chỉ có một dòng, chưa tách khu vực: đưa cả dòng vào ô địa chỉ để không mất.
  $('#edit-addr-input-street').value = cust.street || (joinRegion(editingArea) ? '' : cust.address || '');
  if ($('#edit-addr-input-note')) {
    $('#edit-addr-input-note').value = cust.deliveryNote || '';
  }
  showEditingArea();

  $('#modal-edit-address')?.showModal();
}

$('#edit-addr-trigger-area')?.addEventListener('click', openAreaPicker);

$('#area-input-province')?.addEventListener('change', () => {
  $('#area-input-ward-search').value = '';
  fillDistrictOptions();
  fillWardOptions();
  updateAreaSummary();
});
$('#area-input-district')?.addEventListener('change', () => {
  $('#area-input-ward-search').value = '';
  fillWardOptions();
  updateAreaSummary();
});
$('#area-input-ward-search')?.addEventListener('input', () => {
  fillWardOptions($('#area-input-ward').value);
  updateAreaSummary();
});
$('#area-input-ward')?.addEventListener('change', updateAreaSummary);

$('#btn-confirm-area')?.addEventListener('click', () => {
  const a = readAreaInputs();
  if (!a.province) return fieldError('#area-input-province', 'Chọn tỉnh / thành phố');
  if (areaMode === 'old' && !a.district) return fieldError('#area-input-district', 'Chọn quận / huyện');
  if (!a.ward) return fieldError('#area-input-ward', 'Chọn phường / xã trong danh sách');
  editingArea = a;
  showEditingArea();
  $('#modal-select-area')?.close();
});

$('#btn-save-address-changes')?.addEventListener('click', () => {
  const name = $('#edit-addr-input-name').value.trim();
  const phone = $('#edit-addr-input-phone').value.trim();
  const street = $('#edit-addr-input-street').value.trim();
  const note = $('#edit-addr-input-note')?.value.trim() || '';
  if (!name) return fieldError('#edit-addr-input-name', 'Nhập họ tên người nhận');

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
  refreshShipDialogs();
});

/* ============================================================
   3. TAB ĐƠN HÀNG (SCREEN 5, SCREEN 7, SCREEN 8)
   ============================================================ */
let orderSearchQuery = '';
let orderFilter = 'all';

/* Ngày đang xem ở tab Đơn hàng: mặc định hôm nay. Mọi việc gom đơn (nhãn đơn cũ, bảng Duyệt đơn,
   thanh sẵn sàng xuất, file Viettel Post) chỉ tính đơn trong khoảng ngày này. */
const dayStart = (t = Date.now()) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const addDays = (t, n) => {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
let orderDayFrom = dayStart();
let orderDayTo = orderDayFrom;
let orderMinFrom = 0; // khung giờ trong ngày, tính bằng phút
let orderMinTo = 24 * 60 - 1;
const inOrderRange = (o) => {
  const t = Number(o?.ts) || 0;
  if (t < orderDayFrom || t >= addDays(orderDayTo, 1)) return false;
  const d = new Date(t);
  const min = d.getHours() * 60 + d.getMinutes();
  return min >= orderMinFrom && min <= orderMinTo;
};
const scopedOrders = () => (state.orders || []).filter(inOrderRange);
const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const dayText = (t) => {
  const d = new Date(t);
  return `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};
function orderRangeLabel() {
  const today = dayStart();
  const hours = orderMinFrom > 0 || orderMinTo < 24 * 60 - 1 ? ` · ${minText(orderMinFrom)}–${minText(orderMinTo)}` : '';
  if (orderDayFrom !== orderDayTo) return `${dayText(orderDayFrom)} → ${dayText(orderDayTo)}${hours}`;
  if (orderDayFrom === today) return `Hôm nay · ${dayText(today)}${hours}`;
  if (orderDayFrom === addDays(today, -1)) return `Hôm qua · ${dayText(orderDayFrom)}${hours}`;
  return dayText(orderDayFrom) + hours;
}
const toDateInput = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromDateInput = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
};
function setOrderRange(from, to = from) {
  orderDayFrom = Math.min(from, to);
  orderDayTo = Math.max(from, to);
  renderOrdersView();
}

function renderOrdersView() {
  const container = $('#orders-list-container');
  if (!container) return;

  // Chỉ hiển thị các đơn hàng hiện tại (không hiển thị các đơn lịch sử cũ từ tuần trước trong danh sách hôm nay)
  // Tab "Tất cả" hiện đơn của mọi ngày; các tab còn lại theo ngày / khoảng ngày đang chọn.
  const everyOrders = (state.orders || [])
    .filter((o) => !String(o.id).startsWith('o_linh_prev_') && !hiddenOrderIds.has(o.id))
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const allOrders = scopedOrders().filter((o) => !String(o.id).startsWith('o_linh_prev_') && !hiddenOrderIds.has(o.id));
  const q = orderSearchQuery.toLowerCase();

  // Đơn mới = chưa duyệt gửi; Chờ gửi = đã duyệt (sẵn sàng xuất); Gom sau = khách hẹn gom.
  const newCnt = allOrders.filter((o) => shipStateOf(o) === 'ask').length;
  const shippingCnt = allOrders.filter((o) => o.status === 'shipping').length;

  const isDemo = isDemoAccount();
  // Hiển thị số đếm chuẩn Screen 5 (Admin cộng số nền demo; tài khoản mới hiển thị đúng số thực tế)
  const displayTotal = isDemo ? 46 + everyOrders.length : everyOrders.length;
  const displayNew = isDemo ? 9 + newCnt : newCnt;
  const displayShipping = isDemo ? 7 + shippingCnt : shippingCnt;

  if ($('#orders-sub-count')) {
    $('#orders-sub-count').textContent =
      orderFilter === 'all' ? `${displayTotal} đơn · mọi ngày` : `${allOrders.length} đơn · ${orderRangeLabel()}`;
  }
  if ($('#chip-ord-all')) $('#chip-ord-all').textContent = `Tất cả · ${displayTotal}`;
  if ($('#chip-ord-new')) $('#chip-ord-new').textContent = `Đơn mới · ${displayNew}`;
  if ($('#chip-ord-shipping')) $('#chip-ord-shipping').textContent = `Đang giao · ${displayShipping}`;
  const pendingCnt = allOrders.filter((o) => shipStateOf(o) === 'ready').length;
  const holdCnt = allOrders.filter((o) => shipStateOf(o) === 'hold').length;
  if ($('#chip-ord-pending')) $('#chip-ord-pending').textContent = `Chờ gửi · ${pendingCnt}`;
  if ($('#chip-ord-hold')) $('#chip-ord-hold').textContent = `Gom sau · ${holdCnt}`;
  renderVtpReadyBanner();
  renderVtpAttention();
  if ($('#order-range-label')) $('#order-range-label').textContent = orderRangeLabel();
  const showsAllDays = orderFilter === 'all' || orderFilter === 'vtpattn';
  $('#btn-order-filter-icon')?.classList.toggle('is-muted', showsAllDays);
  if ($('#btn-order-filter-icon')) {
    $('#btn-order-filter-icon').title = showsAllDays ? 'Bộ lọc này hiện đơn của mọi ngày. Khoảng ngày áp dụng cho các bộ lọc còn lại.' : 'Chọn ngày hoặc khoảng ngày';
  }
  const attnChip = $('#chip-ord-attn');
  if (attnChip) {
    attnChip.hidden = orderFilter !== 'vtpattn';
    attnChip.classList.toggle('active', orderFilter === 'vtpattn');
  }
  const navBadge = $('#nav-orders-badge');
  if (navBadge) {
    navBadge.hidden = !displayNew;
    navBadge.textContent = String(displayNew);
  }

  const filtered = (orderFilter === 'all' || orderFilter === 'vtpattn' ? everyOrders : allOrders).filter((o) => {
    if (orderFilter === 'new' && shipStateOf(o) !== 'ask') return false;
    if (orderFilter === 'printed' && o.status !== 'printed' && !o.printCount) return false;
    if (orderFilter === 'shipping' && o.status !== 'shipping') return false;
    if (orderFilter === 'pending' && shipStateOf(o) !== 'ready') return false;
    if (orderFilter === 'hold' && shipStateOf(o) !== 'hold') return false;
    if (orderFilter === 'vtpattn' && !vtpNeedsAction(o)) return false;
    if (q) {
      const match = `${o.code} ${o.nickname} ${o.uniqueId} ${o.phone || ''}`.toLowerCase();
      if (!match.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-box">
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
      // Không hiện nhãn "Đã in": nút In đơn / In lại đã cho biết đơn in chưa.
      // Hàng Viettel Post trả về shop: đơn vẫn ở mục Đang giao nhưng trạng thái ghi "Hoàn về".
      const isReturned = isVtpReturned(o);
      const badgeText = isReturned ? 'Hoàn về' : isNew ? 'Đơn mới' : isPrinted ? '' : isShipping ? 'Đang giao' : 'Đã giao';
      const hasPrinted = isPrinted || Number(o.printCount) > 0;
      const badgeClass = isReturned
        ? 'ship-tag-vtp-bad'
        : isNew
        ? 'status-new-badge'
        : isPrinted
        ? 'status-printed-badge'
        : 'status-done-badge';

      const warmClass = isWarmAvatar(o) ? 'warm' : '';
      const itemCount = o.items?.reduce((s, it) => s + (Number(it.qty) || 1), 0) || o.items?.length || 1;
      const shipTag = shipTagHtml(o, state.orders) + vtpTagHtml(o);
      const hasOldGom = shipStateOf(o) === 'ask' && olderPendingOf(state.orders, o).length > 0;
      const shipLabel = shipButtonLabel(o);

      return `
        <div class="order-card-item${hasOldGom ? ' has-old-gom' : ''}${o.id === currentDetailOrderId ? ' active' : ''}" data-order-row="${o.id}" role="button" tabindex="0">
          <div class="order-card-top">
            <div class="order-card-user">
              <div class="user-circle-avatar ${warmClass}">${avatarInitial(o.nickname || o.uniqueId)}</div>
              <div class="order-card-user-info">
                <div class="order-cust-name">${esc(o.nickname || o.uniqueId)}</div>
                <div class="order-meta-sub">@${esc(o.uniqueId)} · ${itemCount} sản phẩm · ${esc(o.timeStr || '20:42')}${(Number(o.ts) || 0) < dayStart() ? ' · ' + esc(dmText(o.ts)) : ''}</div>
                ${shipTag}
              </div>
            </div>
            <div class="order-card-price-col">
              <span class="order-total-price">${formatVNDHtml(o.total || 0)}</span>
              ${badgeText ? `<span class="badge-order-status ${badgeClass}">${badgeText}</span>` : ''}
            </div>
          </div>

          <div class="order-card-actions-row">
            <button class="btn-ord-card-print ${hasPrinted ? 'is-printed' : 'is-new'}" data-act-print="${o.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
              <span>${hasPrinted ? 'In lại' : 'In đơn'}</span>
            </button>
            <button class="btn-ord-card-ship" data-act-ship="${o.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
              <span>${shipLabel}</span>
            </button>
            <button class="btn-ord-card-more" data-act-more="${o.id}" title="Thao tác khác" aria-label="Thao tác khác">${icon('more')}</button>
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
    const so = state.orders.find((x) => x.id === btnShip.dataset.actShip);
    if (so?.ship?.vtpCode) openOrderDetailView(so.id);
    else openShipSheet(btnShip.dataset.actShip);
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

let ocOrderId = null;

function openOrderComments(ord) {
  if (!ord) return;
  ocOrderId = ord.id;
  const cust = customerOfOrder(ord);
  const name = cust?.name || ord.nickname || ord.uniqueId || '';
  const items = [...(ord.items || [])].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  const qty = items.reduce((n, it) => n + (Number(it.qty) || 1), 0);
  const initials = name.trim().split(/\s+/).slice(-2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  $('#oc-subtitle').textContent = `Đơn của ${name}${ord.timeStr ? ' · ' + ord.timeStr : ''}`;
  $('#oc-avatar').textContent = initials;
  $('#oc-name').textContent = name;
  $('#oc-uid').textContent = ord.uniqueId ? '@' + String(ord.uniqueId).replace(/^@/, '') : '';
  $('#oc-count').textContent = `${items.length} bình luận`;
  $('#oc-value').textContent = `${qty} sản phẩm · ${vndText(goodsTotal(ord))}`;
  $('#oc-list').innerHTML = items.length
    ? items
        .map((it) => {
          const text = it.comment || `chốt ${it.code || ''}`;
          const code = it.code ? String(it.code) : '';
          const shown = code && text.includes(code) ? esc(text).replace(esc(code), `<span class="oc-code">${esc(code)}</span>`) : esc(text);
          return `<div class="oc-row">
            <span class="oc-time">${esc(it.timeStr || ord.timeStr || '')}</span>
            <div class="oc-bubble">
              <div class="oc-text">${shown}</div>
              <div class="oc-item"><span class="oc-arrow">→</span><b>${esc(it.name || it.code || 'Sản phẩm')}</b><span>${Number(it.qty) || 1} × ${vndText(it.price)}</span></div>
            </div>
          </div>`;
        })
        .join('')
    : '<p class="ship-pay-hint">Đơn này chưa có bình luận chốt.</p>';
  $('#modal-order-comments')?.showModal();
}

$('#sheet-act-comments')?.addEventListener('click', () => {
  $('#modal-order-menu')?.close();
  openOrderComments(currentSheetOrder);
});

$('#btn-oc-detail')?.addEventListener('click', () => {
  $('#modal-order-comments')?.close();
  if (ocOrderId) openOrderDetailView(ocOrderId);
});

/** Hỏi lại rồi xoá đơn; trong 5 giây đầu bấm Hoàn tác thì đơn trở lại như cũ. */
async function confirmDeleteOrder(ord) {
  if (!ord) return;
  // Vận đơn còn hiệu lực mà xoá đơn thì bưu tá vẫn tới lấy hàng, app lại không còn gì để theo dõi.
  if (ord.ship?.vtpCode && ord.status !== 'done') {
    return toast(`Đơn đang có vận đơn ${ord.ship.vtpCode}. Huỷ vận đơn ở chi tiết đơn trước rồi mới xoá đơn.`, '⚠️', 5000);
  }
  const yes = await askConfirm({
    title: 'Xoá đơn này?',
    message: `Xoá đơn ${ord.code || ''} của ${ord.nickname || ord.uniqueId}. Sau khi xoá có 5 giây để bấm Hoàn tác.`,
    ok: 'Xoá đơn',
    danger: true
  });
  if (!yes) return;
  hiddenOrderIds.add(ord.id);
  if (currentDetailOrderId === ord.id) {
    currentDetailOrderId = null;
    $('#subview-order-detail').style.display = 'none';
    $('#subview-orders-list').style.display = 'block';
  }
  renderOrdersView();
  const commit = () => {
    if (!hiddenOrderIds.has(ord.id)) return;
    hiddenOrderIds.delete(ord.id);
    removeOrder(ord.id);
    renderOrdersView();
  };
  const timer = setTimeout(commit, 5000);
  // Đóng trang trong lúc chờ thì xoá luôn, không để đơn sống lại.
  window.addEventListener('pagehide', commit, { once: true });
  toast('Đã xoá đơn hàng', '✓', 5000, {
    label: 'Hoàn tác',
    onClick: () => {
      clearTimeout(timer);
      hiddenOrderIds.delete(ord.id);
      renderOrdersView();
    }
  });
}

$('#sheet-act-delete')?.addEventListener('click', () => {
  $('#modal-order-menu')?.close();
  confirmDeleteOrder(currentSheetOrder);
});

// View Chi tiết đơn hàng (Screen 8)
function openOrderDetailView(orderId) {
  currentDetailOrderId = orderId;
  const ord = state.orders.find((o) => o.id === orderId);
  if (!ord) return;

  $('#subview-orders-list').style.display = 'none';
  $('#subview-order-detail').style.display = 'block';
  $$('.order-card-item').forEach((r) => r.classList.toggle('active', r.dataset.orderRow === orderId));

  const badgeEl = $('#detail-order-badge');
  if (badgeEl) {
    const isNew = ord.status === 'new';
    const isPrinted = ord.status === 'printed';
    const isShipping = ord.status === 'shipping';
    const isReturned = isVtpReturned(ord);
    badgeEl.textContent = isReturned ? 'Hoàn về' : isNew ? 'Đơn mới' : isPrinted ? '' : isShipping ? 'Đang giao' : 'Đã giao';
    badgeEl.hidden = !badgeEl.textContent;
    if ($('#detail-ship-label')) $('#detail-ship-label').textContent = shipButtonLabel(ord);
    if ($('#detail-print-label')) $('#detail-print-label').textContent = isPrinted || Number(ord.printCount) > 0 ? 'In lại' : 'In đơn';
    badgeEl.className = `badge-order-status ${
      isReturned ? 'ship-tag-vtp-bad' : isNew ? 'status-new-badge' : isPrinted ? 'status-printed-badge' : 'status-done-badge'
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
    // Đơn tạo từ bản web cũ ghi cứng "CN" cho mọi ngày: sửa lại thứ theo đúng ngày trong chuỗi.
    $('#detail-created-text').textContent = fixCreatedDesc(ord.createdDesc) || createdDescOf(Number(ord.ts) || Date.now());
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
  renderDetailVtp(ord);
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
  if (!currentDetailOrderId) return;
  const o = state.orders.find((x) => x.id === currentDetailOrderId);
  if (o?.ship?.vtpCode) return $('#detail-vtp-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  openShipSheet(currentDetailOrderId);
});

/* ============================================================
   GIAO HÀNG & XUẤT EXCEL VIETTEL POST
   ============================================================ */
const vndText = (n) => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const dmText = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const customerOfOrder = (o) => state.customers.find((c) => shipKeyOf(c) === shipKeyOf(o)) || null;

function shipButtonLabel(o) {
  const st = shipStateOf(o);
  if (st === 'hold') return 'Gom sau';
  if (st === 'ready') return 'Sẵn sàng gửi';
  if (isVtpReturned(o)) return 'Hoàn về';
  if (o.ship?.vtpCode && o.status !== 'done') return vtpNeedsAction(o) ? 'Cần xử lý' : 'Vận đơn';
  if (st === 'exported' || st === 'gone') return o.status === 'done' ? 'Đã giao' : 'Đang giao';
  return 'Duyệt đơn';
}

/** Nhãn dưới tên khách: còn đơn cũ chưa gửi, hoặc đơn này đang gom / sẵn sàng. */
function shipTagHtml(o, orders) {
  const st = shipStateOf(o);
  if (!isPending(o)) return '';
  const older = olderPendingOf(orders, o);
  if (older.length && st === 'ask') {
    // Đơn mới của khách còn đơn gom ngày trước: bấm là mở bảng duyệt, các đơn cũ đã tick sẵn để gộp.
    return `<button type="button" class="ship-tag ship-tag-old ship-tag-merge" data-act-ship="${o.id}">Có ${older.length} đơn gom từ ${dmText(older[0].ts)} · bấm để gộp</button>`;
  }
  if (older.length) {
    return `<span class="ship-tag ship-tag-old">Còn ${older.length} đơn cũ chưa gửi · từ ${dmText(older[0].ts)}</span>`;
  }
  if (st === 'hold') return '<span class="ship-tag ship-tag-old">Khách hẹn gom sau</span>';
  if (st === 'ready') return '<span class="ship-tag ship-tag-ready">Sẵn sàng gửi</span>';
  return '';
}

function renderVtpReadyBanner() {
  const banner = $('#vtp-ready-banner');
  if (!banner) return;
  // Xuất VTP lấy mọi đơn đã duyệt chưa xuất ở mọi ngày (không theo ngày đang xem); cùng khách gộp 1 vận đơn.
  // Nháp nào đã có cước thật thì thu hộ ở đây cũng tính theo cước đó, khớp với bảng nháp.
  const groups = vtpGroups();
  banner.hidden = groups.length === 0;
  if (banner.hidden) return;
  const merged = groups.filter((g) => g.orders.length > 1).length;
  const cod = groups.reduce((s, g) => s + g.cod, 0);
  const older = groups.filter((g) => g.orders.some((o) => (Number(o.ts) || 0) < dayStart())).length;
  // Đã kết nối Viettel Post: đơn ở Chờ gửi là nháp sẵn, bấm Soát & tạo mở bảng nháp.
  $('#vtp-ready-title').textContent = vtpConnected() ? `${groups.length} nháp chờ tạo vận đơn` : `${groups.length} khách sẵn sàng xuất`;
  const btnLabel = $('#btn-open-vtp-export span');
  if (btnLabel) btnLabel.textContent = vtpConnected() ? 'Soát & tạo' : 'Xuất VTP';
  $('#vtp-ready-sub').textContent = [
    merged ? `${merged} khách gộp nhiều đơn` : '',
    older ? `${older} khách có đơn duyệt từ ngày trước` : '',
    `Thu hộ ${vndText(cod)}`
  ]
    .filter(Boolean)
    .join(' · ');
}

/* ---------- Bảng Giao hàng ---------- */
let shipCtx = null; // { key, uniqueId, orderIds, checked:Set, pay, focusId }

/**
 * `draft` (tuỳ chọn): mở từ nút Sửa ở "Hàng & tiền" của một nháp vận đơn. `draft.ids` là các đơn của nháp:
 * chỉ tick sẵn đúng các đơn đó, giữ số COD đã sửa tay, lưu xong quay lại nháp `draft.key`.
 */
function openShipSheet(orderId, draft = null) {
  const ord = state.orders.find((o) => o.id === orderId);
  if (!ord) return;
  shipCtx = { focusId: orderId, key: shipKeyOf(ord), uniqueId: ord.uniqueId, checked: null, pay: null, payer: null, deposit: null, fee: null, cod: null, draft };
  $('#ship-sheet-title').textContent = draft ? 'Sửa hàng & tiền' : 'Duyệt đơn';
  $('#btn-ship-ready').textContent = draft ? 'Lưu thay đổi' : 'Xác nhận gửi';
  renderShipSheet();
  $('#modal-ship')?.showModal();
}

function renderShipSheet() {
  if (!shipCtx) return;
  const focus = state.orders.find((o) => o.id === shipCtx.focusId);
  if (!focus) return $('#modal-ship')?.close();
  const cust = customerOfOrder(focus);
  // Quét đơn chưa gửi của khách ở mọi ngày (đơn gom ngày trước) để duyệt chung, không sót.
  const pending = pendingOrdersOfCustomer(state.orders, focus);
  const focusState = shipStateOf(focus);
  const sent = focusState === 'exported' || focusState === 'gone';

  // Sửa nháp: chỉ lấy các đơn của nháp; đơn khác của khách vẫn hiện nhưng không tick sẵn.
  const own = shipCtx.draft ? pending.filter((o) => shipCtx.draft.ids.includes(o.id)) : [];
  const base = own.length ? own : pending;
  if (!shipCtx.checked) shipCtx.checked = new Set(base.map((o) => o.id));
  if (!shipCtx.pay) {
    const fromOrders = (own.length ? own : [...pending, focus]).map((o) => o.ship?.pay).filter(Boolean);
    shipCtx.pay = fromOrders.includes('paid') || fromOrders.includes('shipOnly') ? 'paid' : 'cod';
    const pick = (k) => {
      for (const o of [...base].reverse()) if (o.ship?.[k] !== undefined && o.ship[k] !== null && o.ship[k] !== '') return o.ship[k];
      return null;
    };
    shipCtx.payer = pick('payer');
    if (shipCtx.payer !== 'sender' && shipCtx.payer !== 'receiver') shipCtx.payer = shipCtx.pay === 'cod' ? 'receiver' : 'sender';
    shipCtx.deposit = base.reduce((s, o) => s + (Number(o.ship?.deposit) || 0), 0) || null;
    shipCtx.fee = pick('shipFee');
    // Kích thước kiện (cm): lấy theo đơn đã nhập gần nhất, chỉ dùng khi nặng từ 10kg.
    shipCtx.size = ['lengthCm', 'widthCm', 'heightCm'].map((k) => {
      const v = Number(pick(k));
      return v > 0 ? String(Math.round(v)) : '';
    });
    // COD luôn bắt đầu bằng tổng tiền các đơn đang tick (tính tự động); bạn sửa tay được, không khoá.
    shipCtx.cod = null;
    // Sửa nháp: COD đã sửa tay lúc duyệt thì giữ nguyên, không lặng lẽ quay về số tự cộng.
    if (own.length) {
      const manual = pick('codOverride');
      if (manual !== null && Number.isFinite(Number(manual))) shipCtx.cod = Math.round(Number(manual));
    }
  }


  const stateText = { ask: 'Chưa hỏi', hold: 'Gom sau', ready: 'Sẵn sàng' };
  const list = $('#ship-orders-list');
  if (sent) {
    list.innerHTML = `<div class="ship-order-row"><span>Đơn ${esc(focus.code || '')} · ${itemQty(focus)} món</span><b>${vndText(goodsTotal(focus))}</b></div>`;
  } else {
    list.innerHTML = pending
      .map(
        (o) => `
        <label class="ship-order-row">
          <input type="checkbox" data-ship-check="${o.id}" ${shipCtx.checked.has(o.id) ? 'checked' : ''} />
          <span class="ship-order-main">${o.id === focus.id ? 'Đơn này' : 'Đơn cũ'} ${dmText(o.ts)} · ${itemQty(o)} món
            <small>${esc(o.code || '')} · ${stateText[shipStateOf(o)] || ''}</small></span>
          <b>${vndText(goodsTotal(o))}</b>
        </label>`
      )
      .join('');
  }

  const chosen = pending.filter((o) => shipCtx.checked.has(o.id));
  $('#ship-merge-note').textContent = sent
    ? `Đã xuất Viettel Post${focus.ship?.exportedAt ? ' lúc ' + dmText(focus.ship.exportedAt) : ''}.`
    : '';
  $('#ship-merge-note').hidden = !sent;

  $$('[data-ship-pay]').forEach((b) => {
    const on = b.dataset.shipPay === shipCtx.pay;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  $$('[data-ship-payer]').forEach((b) => {
    const on = b.dataset.shipPayer === shipCtx.payer;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  // Cân nặng lấy theo đơn lúc mở bảng; sau đó giữ đúng số bạn gõ, không bị đặt lại khi sửa ô khác.
  if (shipCtx.weightKg === undefined) {
    const w = Math.max(...chosen.map((o) => Number(o.ship?.weightG) || 0), 0) || DEFAULT_WEIGHT_G;
    shipCtx.weightKg = String(w / 1000);
  }
  if (document.activeElement !== $('#ship-weight')) $('#ship-weight').value = shipCtx.weightKg;
  // Từ 10kg: hiện 3 ô Dài / Rộng / Cao và bắt buộc nhập trước khi Xác nhận gửi.
  const needSize = !sent && shipNeedsSize();
  $('#ship-size-group').hidden = !needSize;
  SHIP_SIZE_INPUTS.forEach((sel, i) => {
    if (document.activeElement !== $(sel)) $(sel).value = shipCtx.size?.[i] || '';
  });
  $('#ship-size-warn').hidden = !(needSize && !shipSizeCm());

  // Tính thử đúng như lúc xuất: tiền cọc đặt ở đơn đầu, các cài đặt khác đặt ở mọi đơn.
  const trial = (chosen.length ? chosen : [focus]).map((o, i) => ({ ...o, ship: { ...o.ship, ...shipPatch(i === 0) } }));
  const sum = summarizeGroup({ orders: trial, customer: cust });
  const codEl = $('#ship-cod');
  if (document.activeElement !== codEl) codEl.value = String(shipCtx.cod !== null ? shipCtx.cod : sum.autoCod);
  codEl.placeholder = String(sum.autoCod);
  if (document.activeElement !== $('#ship-deposit')) $('#ship-deposit').value = shipCtx.deposit ? String(shipCtx.deposit) : '';
  $('#btn-ship-cod-auto').hidden = shipCtx.cod === null;
  // Đơn dưới 17.000đ mà chọn người nhận trả: vẫn cho chọn, khi xuất tự đổi người gửi trả và cộng ship vào COD.
  // Kể cả khi đã chọn người gửi trả hoặc tự nhập số thu hộ: báo rõ khách sẽ trả bao nhiêu khi nhận hàng.
  const payerWarn = $('#ship-payer-warn');
  payerWarn.hidden = sent || sum.pay !== 'cod' || !(sum.shipFee > 0 || sum.forcedSender);
  payerWarn.textContent = sum.shipFee > 0
    ? `Thu hộ thấp hơn tiền ship: người gửi trả ship và cộng tiền ship vào thu hộ. Tạm tính ship ${vndText(sum.shipFee)}, khách trả ${vndText(sum.cod)}. Bước nháp vận đơn sẽ tính lại theo cước thật Viettel Post báo.`
    : `Tiền hàng thấp hơn tiền ship: người gửi trả ship. Thu hộ giữ đúng ${vndText(sum.cod)} bạn đã nhập.`;
  const warn = $('#ship-addr-warn');
  // Thiếu kích thước đã báo ngay dưới 3 ô Dài / Rộng / Cao; ô này chỉ báo lỗi địa chỉ / số điện thoại.
  const addrProblems = sum.problems.filter((p) => !p.includes('kích thước'));
  warn.hidden = sent || addrProblems.length === 0;
  warn.innerHTML = addrProblems.length
    ? `${esc(addrProblems.join(' · '))}. <button type="button" class="link-btn" id="btn-ship-fix-addr">Sửa địa chỉ</button>`
    : '';

  $$('#modal-ship .ship-seg-btn, #ship-weight, #ship-cod, #ship-deposit, #btn-ship-cod-auto, #btn-ship-hold, #btn-ship-ready').forEach((el) => {
    el.disabled = sent;
  });
  $('#btn-ship-undo').hidden = !(sent && focusState === 'exported');
}

/** Các cài đặt giao hàng đang chọn trong bảng, ghi vào đơn. `first`: đơn đầu nhận tiền cọc của cả vận đơn. */
function shipPatch(first = true) {
  const size = shipNeedsSize() ? shipSizeCm() : null;
  return {
    pay: shipCtx.pay,
    payer: shipCtx.payer || 'receiver',
    deposit: first ? shipCtx.deposit || 0 : 0,
    shipFee: shipCtx.fee,
    codOverride: shipCtx.cod,
    weightG: shipWeightG(),
    lengthCm: size ? size[0] : null,
    widthCm: size ? size[1] : null,
    heightCm: size ? size[2] : null
  };
}

/** Từ cân nặng này Viettel Post cần kích thước kiện (giống app điện thoại). */
const SHIP_SIZE_REQUIRED_G = 10000;
const SHIP_SIZE_INPUTS = ['#ship-length', '#ship-width', '#ship-height'];
const shipNeedsSize = () => shipWeightG() >= SHIP_SIZE_REQUIRED_G;

/** [dài, rộng, cao] (cm) khi đã nhập đủ 3 ô, không thì null. */
function shipSizeCm() {
  const v = (shipCtx?.size || []).map((s) => Math.round(Number(s)));
  return v.length === 3 && v.every((n) => Number.isFinite(n) && n > 0) ? v : null;
}

function shipChosenIds() {
  const focus = state.orders.find((o) => o.id === shipCtx.focusId);
  return pendingOrdersOfCustomer(state.orders, focus)
    .filter((o) => shipCtx.checked.has(o.id))
    .map((o) => o.id);
}

function shipWeightG() {
  const kg = Number(String(shipCtx?.weightKg ?? $('#ship-weight').value).replace(',', '.'));
  return Number.isFinite(kg) && kg > 0 ? Math.round(kg * 1000) : DEFAULT_WEIGHT_G;
}

$('#ship-orders-list')?.addEventListener('change', (e) => {
  const cb = e.target.closest('[data-ship-check]');
  if (!cb || !shipCtx) return;
  if (cb.checked) shipCtx.checked.add(cb.dataset.shipCheck);
  else shipCtx.checked.delete(cb.dataset.shipCheck);
  shipCtx.cod = null; // đổi đơn tick thì tính lại tổng
  renderShipSheet();
});

$$('[data-ship-pay]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!shipCtx) return;
    shipCtx.pay = b.dataset.shipPay;
    shipCtx.cod = null;
    // Đã bank đủ thì mặc định shop trả cước (đổi được); thu tiền hàng thì người nhận trả.
    shipCtx.payer = shipCtx.pay === 'cod' ? 'receiver' : 'sender';
    renderShipSheet();
  })
);

$$('[data-ship-payer]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!shipCtx) return;
    shipCtx.payer = b.dataset.shipPayer;
    shipCtx.cod = null;
    renderShipSheet();
  })
);

const moneyInput = (el) => {
  const raw = String(el.value).trim();
  const n = Number(raw);
  return raw === '' || !Number.isFinite(n) || n < 0 ? null : Math.round(n);
};
$('#ship-cod')?.addEventListener('input', (e) => {
  if (!shipCtx) return;
  shipCtx.cod = moneyInput(e.target);
  renderShipSheet();
});
$('#ship-deposit')?.addEventListener('input', (e) => {
  if (!shipCtx) return;
  shipCtx.deposit = moneyInput(e.target);
  shipCtx.cod = null;
  renderShipSheet();
});
$('#btn-ship-cod-auto')?.addEventListener('click', () => {
  if (!shipCtx) return;
  shipCtx.cod = null;
  renderShipSheet();
});
$('#ship-weight')?.addEventListener('input', (e) => {
  if (!shipCtx) return;
  shipCtx.weightKg = e.target.value;
  renderShipSheet();
});
SHIP_SIZE_INPUTS.forEach((sel, i) =>
  $(sel)?.addEventListener('input', (e) => {
    if (!shipCtx) return;
    shipCtx.size = shipCtx.size || ['', '', ''];
    shipCtx.size[i] = e.target.value;
    renderShipSheet();
  })
);

$('#ship-addr-warn')?.addEventListener('click', (e) => {
  if (e.target.closest('#btn-ship-fix-addr') && shipCtx) openAddressEditor(shipCtx.uniqueId);
});

function applyShip(newState) {
  if (!shipCtx) return;
  const ids = shipChosenIds();
  if (!ids.length) return toast('Tick ít nhất một đơn', '⚠️');
  if (newState === 'ready' && shipNeedsSize() && !shipSizeCm()) {
    $('#ship-length')?.focus();
    return toast('Hàng từ 10kg phải nhập đủ kích thước dài, rộng, cao (cm)', '⚠️');
  }
  ids.forEach((id, i) => setOrdersShip([id], { state: newState, ...shipPatch(i === 0) }));
  // Đơn đang Sẵn sàng mà bị bỏ tick: đưa về chưa duyệt, không thì lúc tạo vận đơn vẫn bị gộp chung và cộng tiền.
  if (newState === 'ready') {
    const focus = state.orders.find((o) => o.id === shipCtx.focusId);
    const dropped = pendingOrdersOfCustomer(state.orders, focus)
      .filter((o) => !ids.includes(o.id) && shipStateOf(o) === 'ready')
      .map((o) => o.id);
    if (dropped.length) setOrdersShip(dropped, { state: 'ask', deposit: 0, codOverride: null });
  }
  const draft = shipCtx.draft;
  $('#modal-ship')?.close();
  renderOrdersView();
  // Sửa từ nháp vận đơn: quay lại đúng nháp đó (Gom sau thì nháp không còn, về danh sách nháp).
  if (draft && $('#modal-vtp-export')?.open && $('#vtp-result')?.hidden) {
    vtpDetailKey = newState === 'ready' ? draft.key : null;
    renderVtpExport();
    if (newState === 'ready') return toast(`Đã lưu thay đổi${syncedWord()}`);
  }
  if (currentDetailOrderId) openOrderDetailView(currentDetailOrderId);
  toast(
    newState === 'ready'
      ? `Đã chuyển ${ids.length} đơn sang Sẵn sàng gửi${syncedWord()}`
      : `Đã giữ ${ids.length} đơn chờ gom${syncedWord()}`,
    newState === 'ready' ? '🚚' : '📦'
  );
}

$('#btn-ship-ready')?.addEventListener('click', () => applyShip('ready'));
$('#btn-ship-hold')?.addEventListener('click', () => applyShip('hold'));

$('#btn-ship-undo')?.addEventListener('click', () => {
  if (!shipCtx) return;
  const focus = state.orders.find((o) => o.id === shipCtx.focusId);
  if (!focus) return;
  const batch = focus.ship?.batchId;
  const ids = state.orders
    .filter((o) => o.id === focus.id || (batch && o.ship?.batchId === batch && shipKeyOf(o) === shipKeyOf(focus)))
    .map((o) => o.id);
  setOrdersShip(ids, { state: 'ready', exportedAt: null, batchId: null }, (o) => (o.printCount ? 'printed' : 'new'));
  shipCtx.checked = null;
  renderShipSheet();
  renderOrdersView();
  toast('Đã đưa đơn về Sẵn sàng gửi', '↩');
});

/* ---------- Màn Xuất Viettel Post ---------- */
let vtpSelected = new Set();
let vtpTouched = false;
/** Nháp đang mở để soát chi tiết (khoá của nhóm khách); null là đang ở danh sách nháp. */
let vtpDetailKey = null;
let vtpCreating = false;

/**
 * Nháp vận đơn: đơn ở Chờ gửi là nháp sẵn. Khi đã kết nối Viettel Post, mỗi nháp được hỏi cước và
 * địa chỉ Viettel Post hiểu (máy chủ gọi API tính cước, không tạo đơn). Lưu theo "chữ ký" của nháp
 * để sửa địa chỉ, tiền hay cân nặng thì tự hỏi lại.
 */
const vtpQuotes = new Map();
const vtpQuoteSig = (g, service) => [g.key, vtpAddressLine(g.address), g.cod, g.goods, g.weightG, (g.size || []).join('x'), service].join('|');
const vtpCurService = () => $('#vtp-service')?.value || DEFAULT_VTP_SERVICE;

function vtpGroups() {
  const groups = groupByCustomer(state.orders, state.customers, 'ready', state.orders);
  if (!vtpConnected()) return groups;
  const service = vtpCurService();
  for (const g of groups) {
    // Chữ ký lấy từ số tạm tính (chưa có cước thật) để không đổi khi cước thật được cộng vào thu hộ.
    g.quoteSig = vtpQuoteSig(g, service);
    const q = vtpQuotes.get(g.quoteSig);
    g.quote = q;
    // Đã có cước thật: đơn thu hộ thấp hơn cước đó chuyển người gửi trả và cộng đúng cước đó vào thu hộ.
    if (q && q !== 'busy' && q.ok && q.fee > 0) Object.assign(g, summarizeGroup(g, { realFee: q.fee }));
    // Viettel Post đọc ra phường/tỉnh khác app: chưa cho tạo, bấm Sửa địa chỉ.
    if (q && q !== 'busy' && q.addrOk === false) g.problems.push(`Viettel Post hiểu "${q.parsed}", khác địa chỉ trong app`);
  }
  return groups;
}

function ensureVtpQuotes(groups) {
  if (!vtpConnected() || !vtpConn.sender) return;
  const service = vtpCurService();
  const sigOf = (g) => g.quoteSig || vtpQuoteSig(g, service);
  const need = groups.filter((g) => g.address.ok && !g.problems.length && !vtpQuotes.has(sigOf(g)));
  if (!need.length) return;
  const sigs = new Map(need.map((g) => [g.key, sigOf(g)]));
  for (const s of sigs.values()) vtpQuotes.set(s, 'busy');
  apiFetch('/api/vtp/quote', jsonPost({ service, groups: need.map(vtpPayload) }))
    .then((r) => {
      for (const res of r?.results || []) if (sigs.has(res.key)) vtpQuotes.set(sigs.get(res.key), res);
      // Phản hồi thiếu khách nào thì ghi lỗi để không treo "Đang tính cước…".
      for (const s of sigs.values()) if (vtpQuotes.get(s) === 'busy') vtpQuotes.set(s, { ok: false, error: r?.error || 'Không tính được cước' });
    })
    .catch(() => {
      for (const s of sigs.values()) vtpQuotes.set(s, { ok: false, error: 'Không tính được cước' });
    })
    .finally(() => {
      if ($('#modal-vtp-export')?.open && $('#vtp-result')?.hidden) renderVtpExport();
    });
}

function vtpQuoteLine(q) {
  if (!q) return '';
  if (q === 'busy') return '<div class="vtp-row-note">Đang tính cước và kiểm địa chỉ với Viettel Post…</div>';
  const fee = q.ok ? `Cước dự tính <b>${vndText(q.fee)}</b>` : `<span class="vtp-row-err">${esc(q.error || 'Không tính được cước')}</span>`;
  const addr = q.parsed && q.addrOk !== false ? ` · <span class="vtp-quote-ok">✓ VTP hiểu: ${esc(q.parsed)}</span>` : '';
  return `<div class="vtp-row-quote">${fee}${addr}</div>`;
}

function openVtpExport() {
  $('#vtp-result').hidden = true;
  $('#vtp-export-body').hidden = false;
  vtpTouched = false;
  vtpSelected = new Set();
  vtpDetailKey = null;
  const sel = $('#vtp-service');
  // Khoá mới: lựa chọn cũ (STK) không còn đè lên mặc định Flashsale thỏa thuận.
  const cur = VTP_SERVICES.some(([c]) => c === S().vtpServiceCode) ? S().vtpServiceCode : DEFAULT_VTP_SERVICE;
  sel.innerHTML = VTP_SERVICES.map(
    ([code, name]) => `<option value="${code}" ${code === cur ? 'selected' : ''}>${code} · ${esc(name)}</option>`
  ).join('');
  renderVtpExport();
  $('#modal-vtp-export')?.showModal();
}

/** Soát một nháp: người nhận, hàng & tiền, cước dự tính, ghi chú. Giống màn "Nháp · tên khách" trên điện thoại. */
function renderVtpDetail(g) {
  const q = g.quote;
  const busy = q === 'busy';
  const bad = g.problems.length > 0;
  const name = g.receiver || g.customer?.name || g.orders[0].nickname || g.key;
  const uid = g.customer?.uniqueId || g.orders[0].uniqueId;
  const codes = g.orders.map((o) => o.code).filter(Boolean).join(' + ');
  const line = vtpAddressLine(g.address);
  const parsed = q && !busy ? q.parsed || '' : '';
  const mismatch = q && !busy && q.addrOk === false;
  const kv = (k, v, strong) => `<div class="vtp-kv${strong ? ' strong' : ''}"><span>${k}</span><b>${v}</b></div>`;
  $('#vtp-export-title').textContent = `Nháp · ${name}`;
  $('#vtp-export-subtitle').textContent = codes || `${g.orders.length} đơn`;

  let addrCheck = '';
  if (busy) addrCheck = kv('VTP hiểu', 'Đang kiểm…');
  else if (parsed)
    addrCheck =
      kv('VTP hiểu', esc(parsed)) +
      `<p class="${mismatch ? 'vtp-row-err' : 'vtp-quote-ok'} vtp-detail-check">${mismatch ? 'Khác phường hoặc tỉnh. Sửa địa chỉ trước khi tạo.' : '✓ Khớp phường và tỉnh'}</p>`;
  else if (!bad) addrCheck = '<p class="vtp-row-note">Chưa đối chiếu được địa chỉ với Viettel Post.</p>';

  let fee;
  if (busy) fee = '<p class="vtp-row-note">Đang tính cước…</p>';
  else if (q && q.ok)
    fee = kv('Tổng cước', vndText(q.fee), true) + '<p class="vtp-row-note">Chưa tạo đơn. Cước thật do Viettel Post chốt khi nhận hàng.</p>';
  else fee = `<p class="${q ? 'vtp-row-err' : 'vtp-row-note'}">${esc(q?.error || 'Cước chưa tính')}</p>`;

  const sending = vtpCreating;
  $('#vtp-detail').innerHTML = `
    <section class="vtp-detail-box">
      <div class="vtp-detail-head"><h3>Người nhận</h3><button type="button" class="link-btn" data-vtp-fix="${esc(uid)}">Sửa</button></div>
      <div class="vtp-detail-name">${esc(name)}</div>
      <div class="${g.phone ? '' : 'vtp-row-err'}">${esc(g.phone || 'Chưa có số điện thoại')}</div>
      ${kv('App ghi', esc(line || 'Chưa có địa chỉ'))}
      ${addrCheck}
      ${bad ? `<p class="vtp-row-err">${esc(g.problems.join(' · '))}</p>` : ''}
    </section>
    <section class="vtp-detail-box">
      <div class="vtp-detail-head"><h3>Hàng &amp; tiền</h3><button type="button" class="link-btn" data-vtp-edit-goods ${sending ? 'disabled' : ''}>Sửa</button></div>
      ${kv('Tên hàng', `Quần áo · ${Math.max(g.qty || 0, 1)} món`)}
      ${kv('Giá trị hàng', vndText(g.goods))}
      ${kv('Người trả cước', g.senderPays ? 'Shop (người gửi)' : 'Người nhận')}
      ${kv('Trọng lượng', `${g.weightG / 1000}kg`)}
      ${g.size ? kv('Kích thước', `${g.size.join(' × ')} cm`) : ''}
      ${g.shipFee ? kv(g.feeIsReal ? 'Tiền ship cộng vào thu hộ' : 'Tiền ship cộng vào thu hộ (tạm tính)', vndText(g.shipFee)) : ''}
      ${kv('Thu hộ (COD)', vndText(g.cod), true)}
    </section>
    <section class="vtp-detail-box">
      <div class="vtp-detail-head"><h3>Cước dự tính · ${esc(vtpCurService())}</h3></div>
      ${fee}
    </section>
    <section class="vtp-detail-box">
      <div class="vtp-detail-head"><h3>Ghi chú cho bưu tá</h3></div>
      <p class="${g.note ? '' : 'vtp-row-note'}">${esc(g.note || 'Trống')}</p>
    </section>
    <div class="ship-actions">
      <button type="button" class="btn-ghost-pill" data-vtp-detail-back ${sending ? 'disabled' : ''}>Để nháp</button>
      <button type="button" class="btn-orange-pill" data-vtp-detail-create ${bad || busy || sending ? 'disabled' : ''}>${
        sending ? 'Đang tạo vận đơn…' : busy ? 'Đang tính cước…' : 'Tạo vận đơn này'
      }</button>
    </div>`;
}

function renderVtpExport() {
  const groups = vtpGroups();
  ensureVtpQuotes(groups);
  // Đang soát một nháp: vẽ màn chi tiết thay cho danh sách. Nháp không còn (đã gom sau, đã gửi) thì về danh sách.
  const detail = vtpDetailKey && vtpConnected() ? groups.find((g) => g.key === vtpDetailKey) : null;
  if (!detail) vtpDetailKey = null;
  $('#vtp-detail').hidden = !detail;
  $('#vtp-export-body').hidden = !!detail;
  if (detail) return renderVtpDetail(detail);
  if (!vtpTouched) vtpSelected = new Set(groups.filter((g) => !g.problems.length).map((g) => g.key));
  for (const k of [...vtpSelected]) if (!groups.some((g) => g.key === k && !g.problems.length)) vtpSelected.delete(k);

  $('#vtp-export-subtitle').textContent = vtpConnected()
    ? `${groups.length} nháp · Viettel Post chưa nhận đơn nào. Soát xong rồi bấm Tạo.`
    : `${groups.length} khách sẵn sàng gửi`;
  const list = $('#vtp-export-list');
  list.innerHTML = groups.length
    ? [...groups]
        // Nháp sẵn sàng lên đầu, nháp cần sửa xuống cuối; sort ổn định nên giữ thứ tự trong từng nhóm.
        .sort((a, b) => (a.problems.length > 0) - (b.problems.length > 0))
        .map((g) => {
          const bad = g.problems.length > 0;
          const name = g.receiver || g.customer?.name || g.orders[0].nickname || g.key;
          const merged = g.orders.length > 1 ? `<span class="ship-tag ship-tag-old">gộp ${g.orders.length} đơn</span>` : '';
          // Địa chỉ cũ Viettel Post nhận ngay; địa chỉ mới có thể bị hỏi lại phường cũ.
          const addrTag = g.address.ok && g.address.mode === 'old' ? '<span class="ship-tag ship-tag-addr">địa chỉ cũ</span>' : '';
          const paid = g.pay === 'paid' ? '<span class="ship-tag ship-tag-paid">bank đủ</span>' : '';
          // Chỉ thiếu kích thước: mở lại bảng Duyệt đơn để nhập; còn lại là địa chỉ / số điện thoại.
          const onlySize = g.problems.every((p) => p.includes('kích thước'));
          const fixBtn = onlySize
            ? `<button type="button" class="link-btn" data-vtp-resize="${esc(g.orders[g.orders.length - 1].id)}">Nhập kích thước</button>`
            : `<button type="button" class="link-btn" data-vtp-fix="${esc(g.customer?.uniqueId || g.orders[0].uniqueId)}">Sửa</button>`;
          const sub = bad
            ? `<span class="vtp-row-err">${esc(g.problems.join(' · '))}</span> ${fixBtn}`
            : `${g.senderPays ? 'Shop trả ship' : 'Khách trả ship'}${g.shipFee ? ` (${g.pay === 'paid' ? 'thu tiền ship' : 'thu hộ thấp hơn ship'}, COD +${vndText(g.shipFee)}${g.feeIsReal ? '' : ' tạm tính'})` : ''} · COD ${vndText(g.cod)} · ${g.weightG / 1000}kg`;
          const notes = [];
          if (g.recentExported.length)
            notes.push(
              `Khách đã có vận đơn xuất ${dmText(g.recentExported[0].ship.exportedAt)}`
            );
          const review = !bad && vtpConnected() ? `<button type="button" class="link-btn vtp-row-review" data-vtp-detail="${esc(g.key)}">Soát chi tiết ›</button>` : '';
          const other = notes.map((t) => `<div class="vtp-row-note">${esc(t)}</div>`).join('') + (bad ? '' : vtpQuoteLine(g.quote)) + review;
          return `
          <label class="vtp-export-row ${bad ? 'is-bad' : ''}">
            <input type="checkbox" data-vtp-key="${esc(g.key)}" ${vtpSelected.has(g.key) ? 'checked' : ''} ${bad ? 'disabled' : ''} />
            <div class="vtp-row-main">
              <div class="vtp-row-name">${esc(name)} ${merged} ${paid} ${addrTag}</div>
              <div class="vtp-row-sub">${sub}</div>
              ${other}
            </div>
          </label>`;
        })
        .join('')
    : '<p class="ship-pay-hint" style="text-align:center;padding:16px 0">Chưa có đơn nào đã duyệt.</p>';

  const n = vtpSelected.size;
  const api = vtpConnected();
  const picked = groups.filter((g) => vtpSelected.has(g.key));
  const busy = api && picked.some((g) => g.quote === 'busy');
  const feeTotal = picked.reduce((s, g) => s + (g.quote && g.quote !== 'busy' && g.quote.ok ? g.quote.fee : 0), 0);
  $('#vtp-export-count').textContent = api && feeTotal ? `Đã chọn ${n} · cước dự tính ${vndText(feeTotal)}` : `Đã chọn ${n}`;
  $('#vtp-export-title').textContent = api ? 'Nháp vận đơn' : 'Xuất Viettel Post';
  const go = $('#btn-vtp-export-go');
  go.textContent = api ? (busy ? 'Đang tính cước…' : `Tạo ${n} vận đơn Viettel Post`) : `Xuất Excel · ${n} vận đơn`;
  go.disabled = busy;
  $('#btn-vtp-excel-alt').hidden = !api;
  const senderLine = $('#vtp-sender-line');
  senderLine.hidden = !api;
  if (api) {
    senderLine.innerHTML = vtpConn.sender
      ? `Lấy hàng tại <b>${esc(vtpConn.sender.name)}</b> · ${esc(vtpConn.sender.address)}`
      : '<span class="vtp-row-err">Chưa chọn điểm lấy hàng</span> <button type="button" class="link-btn" data-vtp-pick-sender>Chọn</button>';
  }
}

function refreshShipDialogs() {
  if ($('#modal-ship')?.open) renderShipSheet();
  if ($('#modal-vtp-export')?.open && $('#vtp-result')?.hidden) renderVtpExport();
  renderOrdersView();
}

$('#btn-open-vtp-export')?.addEventListener('click', openVtpExport);

$('#vtp-export-list')?.addEventListener('change', (e) => {
  const cb = e.target.closest('[data-vtp-key]');
  if (!cb) return;
  vtpTouched = true;
  if (cb.checked) vtpSelected.add(cb.dataset.vtpKey);
  else vtpSelected.delete(cb.dataset.vtpKey);
  renderVtpExport();
});

$('#vtp-export-list')?.addEventListener('click', (e) => {
  const resize = e.target.closest('[data-vtp-resize]');
  if (resize) {
    e.preventDefault();
    $('#modal-vtp-export')?.close();
    openShipSheet(resize.dataset.vtpResize);
    return;
  }
  const fix = e.target.closest('[data-vtp-fix]');
  if (fix) {
    e.preventDefault();
    openAddressEditor(fix.dataset.vtpFix);
    return;
  }
  const review = e.target.closest('[data-vtp-detail]');
  if (review) {
    e.preventDefault();
    vtpDetailKey = review.dataset.vtpDetail;
    renderVtpExport();
  }
});

$('#vtp-detail')?.addEventListener('click', (e) => {
  const g = vtpGroups().find((x) => x.key === vtpDetailKey);
  if (e.target.closest('[data-vtp-detail-back]')) {
    vtpDetailKey = null;
    return renderVtpExport();
  }
  if (!g) return renderVtpExport();
  const fix = e.target.closest('[data-vtp-fix]');
  if (fix) return openAddressEditor(fix.dataset.vtpFix);
  // Sửa cân nặng, kích thước, COD, tiền cọc, người trả cước của đúng các đơn trong nháp này.
  if (e.target.closest('[data-vtp-edit-goods]'))
    return openShipSheet(g.orders[g.orders.length - 1].id, { key: g.key, ids: g.orders.map((o) => o.id) });
  if (e.target.closest('[data-vtp-detail-create]')) createVtpWaybills([g]);
});

$('#btn-vtp-select-all')?.addEventListener('click', () => {
  vtpTouched = true;
  const ok = vtpGroups().filter((g) => !g.problems.length);
  vtpSelected = vtpSelected.size === ok.length ? new Set() : new Set(ok.map((g) => g.key));
  renderVtpExport();
});

$('#vtp-service')?.addEventListener('change', (e) => {
  S().vtpServiceCode = e.target.value;
  save('settings_vtp_service');
  // Đổi gói thì cước đổi: vẽ lại để hỏi cước gói mới.
  if (vtpConnected()) renderVtpExport();
});

$('#btn-vtp-export-go')?.addEventListener('click', () => (vtpConnected() ? createVtpWaybills() : exportVtpExcel()));
$('#btn-vtp-excel-alt')?.addEventListener('click', () => exportVtpExcel());
$('#vtp-sender-line')?.addEventListener('click', (e) => {
  if (!e.target.closest('[data-vtp-pick-sender]')) return;
  $('#modal-vtp-export')?.close();
  openVtpConnect();
});

function exportVtpExcel() {
  const groups = vtpGroups().filter((g) => vtpSelected.has(g.key) && !g.problems.length);
  if (!groups.length) return toast('Chọn ít nhất một khách đủ địa chỉ', '⚠️');
  const service = $('#vtp-service').value || DEFAULT_VTP_SERVICE;
  const now = new Date();
  downloadBytes(buildVtpXlsx(groups, { service }), vtpFileName(now));
  const batchId = 'vtp_' + now.getTime().toString(36);
  const ids = groups.flatMap((g) => g.orders.map((o) => o.id));
  setOrdersShip(ids, { state: 'exported', exportedAt: now.getTime(), batchId }, 'shipping');
  $('#modal-vtp-export')?.close();
  renderOrdersView();
  toast(`Đã xuất ${groups.length} vận đơn (${ids.length} đơn). Mở Viettel Post › Nhập excel › Mở file để nhập.`, '📄', 5000);
}

/* ---------- Viettel Post qua API (khi shop đã dán token) ---------- */
const VTP_LABEL_SIZES = [
  ['a6', 'Tem A6 (máy in nhiệt 100×150)'],
  ['k100', 'Tem 100mm'],
  ['a5', 'Giấy A5']
];
function vtpConnected() {
  return !!vtpConn.connected;
}
function vtpTrackUrl(code) {
  return `https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=${encodeURIComponent(code)}`;
}
function vtpKindOf(o) {
  return o.ship?.vtpKind || (o.ship?.vtpCode ? 'created' : '');
}
/** Viettel Post đã trả hàng về shop: đơn vẫn nằm ở mục Đang giao nhưng trạng thái hiện "Hoàn về". */
function isVtpReturned(o) {
  return !!o?.ship?.vtpCode && vtpKindOf(o) === 'returned' && o.status !== 'done';
}
function vtpStatusText(o) {
  return isVtpReturned(o) ? 'Hoàn về' : o.ship?.vtpStatusName || 'Chờ lấy hàng';
}
function vtpNeedsAction(o) {
  return !!o.ship?.vtpCode && ['attention', 'returned'].includes(vtpKindOf(o)) && o.status !== 'done';
}

async function loadVtpStatus() {
  try {
    const r = await apiFetch('/api/vtp/status', { method: 'GET', cache: 'no-store' });
    vtpConn = r.ok ? r : { connected: false };
  } catch {
    // Mất mạng: giữ trạng thái cũ.
  }
  applyVtpConnUI();
}

function applyVtpConnUI() {
  const lbl = $('#lbl-vtp-conn-state');
  if (lbl) {
    lbl.textContent = vtpConnected() ? (vtpConn.sender ? 'Đã kết nối' : 'Chọn điểm lấy hàng') : 'Chưa kết nối';
    lbl.className = vtpConnected() ? 'badge-in-use' : 'badge-off';
  }
  renderVtpReadyBanner();
  if ($('#modal-vtp-export')?.open && $('#vtp-result')?.hidden) renderVtpExport();
}

function openVtpConnect() {
  $('#vtp-connect-error').hidden = true;
  $('#vtp-token-input').value = '';
  renderVtpConnect();
  openSettingsPane('vtp');
  if (vtpConnected()) loadVtpSenders();
}

function renderVtpConnect() {
  const on = vtpConnected();
  $('#vtp-connect-off').hidden = on;
  $('#vtp-connect-on').hidden = !on;
  if (!on) return;
  $('#vtp-conn-phone').textContent = `Tài khoản ${vtpConn.phone || ''}`;
  $('#vtp-hook-url').value = vtpConn.hookUrl || '';
  $('#vtp-hook-hint').textContent = vtpConn.lastHookAt
    ? `Đã nhận trạng thái gần nhất lúc ${new Date(vtpConn.lastHookAt).toLocaleString('vi-VN')}.`
    : 'Dán địa chỉ này vào partner2.viettelpost.vn › Bảng điều khiển › Thông tin tài khoản › Production › Cấu hình webhook để đơn tự chuyển Đang giao / Đã giao.';
  const size = $('#vtp-label-size');
  if (size && !size.options.length) {
    size.innerHTML = VTP_LABEL_SIZES.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  }
  if (size) size.value = S().vtpLabelSize || 'a6';
}

async function loadVtpSenders(list) {
  const sel = $('#vtp-sender-select');
  if (!list) {
    sel.innerHTML = '<option value="">Đang tải…</option>';
    const r = await apiFetch('/api/vtp/inventory', { method: 'GET', cache: 'no-store' }).catch(() => null);
    if (!r?.ok) {
      sel.innerHTML = `<option value="">${esc(r?.error || 'Không tải được điểm lấy hàng')}</option>`;
      return;
    }
    list = r.list;
  }
  const cur = String(vtpConn.sender?.id ?? '');
  sel.innerHTML =
    (cur ? '' : '<option value="">— Chọn điểm lấy hàng —</option>') +
    list
      .map((k) => `<option value="${esc(k.id)}" ${String(k.id) === cur ? 'selected' : ''}>${esc(k.name)} · ${esc(k.phone)} · ${esc(k.address)}</option>`)
      .join('');
  $('#vtp-sender-hint').textContent = cur
    ? 'Bưu tá đến địa chỉ này lấy hàng.'
    : `Có ${list.length} điểm trên tài khoản. Chọn đúng địa chỉ shop trước khi gửi.`;
}

$('#menu-row-vtp')?.addEventListener('click', openVtpConnect);

$('#btn-vtp-connect')?.addEventListener('click', async () => {
  const input = $('#vtp-token-input');
  const siteToken = input.value.trim();
  const err = $('#vtp-connect-error');
  err.hidden = true;
  if (!siteToken) {
    err.textContent = 'Chưa dán token';
    err.hidden = false;
    return;
  }
  const btn = $('#btn-vtp-connect');
  btn.disabled = true;
  btn.textContent = 'Đang kết nối…';
  const r = await apiFetch('/api/vtp/connect', jsonPost({ siteToken })).catch(() => null);
  btn.disabled = false;
  btn.textContent = 'Kết nối';
  input.value = '';
  if (!r?.ok) {
    err.textContent = r?.error || 'Không kết nối được máy chủ';
    err.hidden = false;
    return;
  }
  const { inventory, ...conn } = r;
  vtpConn = conn;
  applyVtpConnUI();
  renderVtpConnect();
  loadVtpSenders(inventory || []);
  toast('Đã kết nối Viettel Post', '🚚');
});

$('#vtp-sender-select')?.addEventListener('change', async (e) => {
  if (!e.target.value) return;
  const r = await apiFetch('/api/vtp/sender', jsonPost({ id: e.target.value })).catch(() => null);
  if (!r?.ok) return toast(r?.error || 'Không lưu được điểm lấy hàng', '⚠️');
  vtpConn = r;
  applyVtpConnUI();
  $('#vtp-sender-hint').textContent = 'Bưu tá đến địa chỉ này lấy hàng.';
  toast('Đã lưu điểm lấy hàng');
});

$('#vtp-label-size')?.addEventListener('change', (e) => {
  S().vtpLabelSize = e.target.value;
  save('settings_vtp_label');
});

$('#btn-vtp-hook-copy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#vtp-hook-url').value);
    toast('Đã sao chép địa chỉ webhook');
  } catch {
    $('#vtp-hook-url').select();
  }
});

$('#btn-vtp-disconnect')?.addEventListener('click', async () => {
  if (!(await askConfirm({ title: 'Ngắt kết nối Viettel Post?', message: 'App sẽ quay về xuất Excel như cũ. Vận đơn đã tạo vẫn giữ nguyên.', ok: 'Ngắt kết nối', danger: true }))) return;
  await apiFetch('/api/vtp/disconnect', jsonPost({})).catch(() => null);
  vtpConn = { connected: false };
  applyVtpConnUI();
  renderVtpConnect();
});

/** Mở link in tem. Mở cửa sổ trước khi chờ máy chủ để trình duyệt không chặn popup. */
async function printVtpLabels(codes) {
  codes = [...new Set(codes.filter(Boolean))];
  if (!codes.length) return;
  const win = window.open('', '_blank');
  if (win) win.document.write('<p style="font-family:sans-serif;padding:24px">Đang lấy tem Viettel Post…</p>');
  const r = await apiFetch('/api/vtp/print', jsonPost({ codes })).catch(() => null);
  if (!r?.ok) {
    win?.close();
    return toast(r?.error || 'Không lấy được tem', '⚠️', 4000);
  }
  const url = r.links[S().vtpLabelSize || 'a6'] || r.links.a6;
  if (win) win.location.href = url;
  else window.location.href = url;
}

function vtpPayload(g) {
  const codes = g.orders.map((o) => o.code).filter(Boolean).join('+') || g.key;
  // Vận đơn cũ đã huỷ thì Viettel Post không nhận lại đúng mã đơn đó: thêm hậu tố.
  const retry = g.orders.some((o) => o.ship?.vtpOldCode) ? '-' + Date.now().toString(36).slice(-4) : '';
  return {
    key: g.key,
    orderIds: g.orders.map((o) => o.id),
    ref: codes.slice(0, 50 - retry.length) + retry,
    receiver: g.receiver,
    phone: g.phone,
    address: vtpAddressLine(g.address),
    // Phường/tỉnh theo danh mục mới của Viettel Post để máy chủ đối chiếu với địa chỉ Viettel Post hiểu.
    expect: { province: g.address.newProvince || g.address.province, ward: g.address.newWard || g.address.ward },
    goodsName: 'Quần áo',
    qty: g.qty || 1,
    weightG: g.weightG,
    goods: g.goods,
    cod: g.cod,
    senderPays: g.senderPays,
    note: g.note ? String(g.note).slice(0, 150) : '',
    size: g.size
  };
}

/** `only`: tạo riêng các nháp này (nút "Tạo vận đơn này" ở màn soát chi tiết); bỏ trống là tạo các nháp đang tick. */
async function createVtpWaybills(only = null) {
  if (vtpCreating) return;
  const groups = (only || vtpGroups().filter((g) => vtpSelected.has(g.key))).filter((g) => !g.problems.length);
  if (!groups.length) return toast('Chọn ít nhất một khách đủ địa chỉ', '⚠️');
  if (!vtpConn.sender) {
    toast('Chọn điểm lấy hàng trước', '⚠️');
    $('#modal-vtp-export')?.close();
    return openVtpConnect();
  }
  const service = $('#vtp-service').value || DEFAULT_VTP_SERVICE;
  const btn = $('#btn-vtp-export-go');
  btn.disabled = true;
  btn.textContent = `Đang tạo ${groups.length} vận đơn…`;
  vtpCreating = true;
  if (vtpDetailKey) renderVtpExport();
  const r = await apiFetch('/api/vtp/create', jsonPost({ service, groups: groups.map(vtpPayload) })).catch(() => null);
  vtpCreating = false;
  btn.disabled = false;
  if (!r?.ok) {
    renderVtpExport();
    return toast(r?.error || 'Không tạo được vận đơn', '⚠️', 4000);
  }
  // Máy chủ đã ghi mã vận đơn vào đơn; ghi luôn ở máy này để không phải chờ đồng bộ.
  for (const res of r.results) {
    const g = groups.find((x) => x.key === res.key);
    if (g && !res.ok) {
      setOrdersShip(g.orders.map((o) => o.id), { vtpError: String(res.error || 'Lỗi').slice(0, 200), vtpErrorAt: Date.now() });
      continue;
    }
    if (!g || !res.ok || res.already) continue;
    // Đơn nào đã nhận mã này từ máy chủ thì thôi: ghi lại sẽ đè "Chờ lấy hàng" lên trạng thái Viettel Post vừa báo về.
    const ids = g.orders.map((o) => o.id).filter((id) => state.orders.find((o) => o.id === id)?.ship?.vtpCode !== res.code);
    if (!ids.length) continue;
    setOrdersShip(
      ids,
      {
        state: 'exported',
        exportedAt: Date.now(),
        vtpCode: res.code,
        vtpFee: res.fee,
        vtpService: service,
        vtpStatus: 0,
        vtpStatusName: 'Chờ lấy hàng',
        vtpKind: 'created',
        vtpNote: '',
        vtpError: '',
        vtpErrorAt: null
      },
      'shipping'
    );
  }
  showVtpResult(groups, r.results);
  renderOrdersView();
}

let vtpLastCodes = [];
function showVtpResult(groups, results) {
  const okList = results.filter((x) => x.ok);
  vtpLastCodes = okList.map((x) => x.code);
  vtpDetailKey = null;
  $('#vtp-detail').hidden = true;
  $('#vtp-export-body').hidden = true;
  $('#vtp-export-title').textContent = 'Kết quả gửi Viettel Post';
  $('#vtp-export-subtitle').textContent = `Đã tạo ${okList.length}/${results.length} vận đơn`;
  const rows = results
    .map((res) => {
      const g = groups.find((x) => x.key === res.key);
      const name = esc(g?.receiver || g?.orders[0]?.nickname || res.key);
      if (res.ok) {
        return `<div class="vtp-result-row"><span class="mark">✓</span><div class="main"><b>${name}</b>
          <div class="vtp-row-sub"><span class="vtp-code">${esc(res.code)}</span>${res.fee ? ' · cước ' + vndText(res.fee) : ''}${res.already ? ' · đã có từ trước' : ''}${res.parsed ? ' · VTP hiểu: ' + esc(res.parsed) : ''}</div></div></div>`;
      }
      const uid = g?.customer?.uniqueId || g?.orders[0]?.uniqueId || '';
      return `<div class="vtp-result-row is-bad"><span class="mark">!</span><div class="main"><b>${name}</b>
        <div class="vtp-row-sub"><span class="vtp-row-err">${esc(res.error || 'Lỗi')}</span>
        ${uid ? `<button type="button" class="link-btn" data-vtp-fix="${esc(uid)}">Sửa</button>` : ''}</div></div></div>`;
    })
    .join('');
  const box = $('#vtp-result');
  box.innerHTML = `
    <div class="vtp-result-list">${rows}</div>
    <p class="ship-pay-hint">Đơn tạo xong đã chuyển sang <b>Đang giao</b>. Khách lỗi vẫn nằm ở Chờ gửi, sửa xong gửi lại.</p>
    <div class="ship-actions">
      <button type="button" class="btn-ghost-pill" data-close-dialog>Xong</button>
      ${okList.length ? `<button type="button" class="btn-orange-pill" id="btn-vtp-print-batch">In tem · ${okList.length} vận đơn</button>` : ''}
    </div>`;
  box.hidden = false;
}

$('#vtp-result')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-dialog]')) return $('#modal-vtp-export')?.close();
  if (e.target.closest('#btn-vtp-print-batch')) return printVtpLabels(vtpLastCodes);
  const fix = e.target.closest('[data-vtp-fix]');
  if (fix) openAddressEditor(fix.dataset.vtpFix);
});

/** Nhãn mã vận đơn / trạng thái dưới tên khách trên thẻ đơn. */
function vtpTagHtml(o) {
  const code = o.ship?.vtpCode;
  if (!code) {
    if (o.ship?.vtpKind === 'cancelled' && o.ship?.vtpOldCode && isPending(o)) {
      return `<span class="ship-tag ship-tag-vtp-bad">Vận đơn ${esc(o.ship.vtpOldCode)} đã huỷ · gửi lại</span>`;
    }
    // Lần tạo vận đơn gần nhất bị Viettel Post từ chối: hiện lý do cho tới lần gửi sau.
    if (o.ship?.vtpError && isPending(o)) {
      return `<span class="ship-tag ship-tag-vtp-bad">Lỗi tạo vận đơn: ${esc(o.ship.vtpError)}</span>`;
    }
    return '';
  }
  const kind = vtpKindOf(o);
  const cls = o.status === 'done' || kind === 'delivered' ? 'ship-tag-vtp-done' : vtpNeedsAction(o) ? 'ship-tag-vtp-bad' : 'ship-tag-vtp';
  return `<span class="ship-tag ${cls}">VTP ${esc(code)} · ${esc(vtpStatusText(o))}</span>`;
}

function renderVtpAttention() {
  const strip = $('#vtp-attention');
  if (!strip) return;
  const codes = new Map();
  for (const o of state.orders || []) if (vtpNeedsAction(o) && !codes.has(o.ship.vtpCode)) codes.set(o.ship.vtpCode, o);
  strip.hidden = codes.size === 0;
  if (strip.hidden) return;
  $('#vtp-attention-title').textContent = `${codes.size} đơn cần xử lý`;
  $('#vtp-attention-sub').textContent = [...codes.values()]
    .slice(0, 3)
    .map((o) => `${o.nickname || o.uniqueId}: ${vtpStatusText(o)}`)
    .join(' · ');
}

$('#chip-ord-attn')?.addEventListener('click', () => $('#chip-ord-all')?.click());

$('#vtp-attention')?.addEventListener('click', () => {
  $$('[data-order-filter]').forEach((b) => b.classList.remove('active'));
  orderFilter = 'vtpattn';
  renderOrdersView();
});

/** Ô vận đơn trong chi tiết đơn. */
function renderDetailVtp(ord) {
  const box = $('#detail-vtp-box');
  if (!box) return;
  const code = ord.ship?.vtpCode;
  if (!code) {
    if (ord.ship?.vtpKind === 'cancelled' && ord.ship?.vtpOldCode) {
      box.className = 'detail-vtp-box is-bad';
      box.innerHTML = `<div class="vtp-status">Vận đơn ${esc(ord.ship.vtpOldCode)} đã huỷ</div>
        <div class="vtp-note">Đơn đã về Chờ gửi. Bấm Soát &amp; tạo ở danh sách đơn để tạo vận đơn mới.</div>`;
      box.hidden = false;
    } else box.hidden = true;
    return;
  }
  const kind = vtpKindOf(ord);
  const bad = vtpNeedsAction(ord);
  const at = ord.ship.vtpStatusAt ? new Date(ord.ship.vtpStatusAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
  const canCancel = kind === 'created' || (Number(ord.ship.vtpStatus) > 0 && Number(ord.ship.vtpStatus) < 200 && kind === 'moving');
  box.className = `detail-vtp-box${bad ? ' is-bad' : ''}`;
  box.innerHTML = `
    <div class="vtp-line"><span>Mã vận đơn <span class="vtp-code">${esc(code)}</span></span>${ord.ship.vtpFee ? `<span>Cước ${vndText(ord.ship.vtpFee)}</span>` : ''}</div>
    <div class="vtp-status">${bad && !isVtpReturned(ord) ? 'Cần xử lý · ' : ''}${esc(vtpStatusText(ord))}${at ? ` <span class="vtp-note" style="font-weight:400">· ${esc(at)}</span>` : ''}</div>
    ${ord.ship.vtpNote ? `<div class="vtp-note">${esc(ord.ship.vtpNote)}</div>` : ''}
    <div class="vtp-actions">
      <button type="button" class="btn-outline-pill" data-vtp-act="print">In tem</button>
      <button type="button" class="btn-outline-pill" data-vtp-act="track">Theo dõi</button>
      <button type="button" class="btn-outline-pill" data-vtp-act="copy">Sao chép mã</button>
      ${kind === 'attention' ? '<button type="button" class="btn-orange-pill" data-vtp-act="redeliver">Yêu cầu phát lại</button><button type="button" class="btn-outline-pill" data-vtp-act="return">Đồng ý hoàn</button>' : ''}
      ${canCancel ? '<button type="button" class="btn-outline-pill btn-detail-del" data-vtp-act="cancel">Huỷ vận đơn</button>' : ''}
    </div>`;
  box.hidden = false;
}

$('#detail-vtp-box')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-vtp-act]');
  const ord = state.orders.find((o) => o.id === currentDetailOrderId);
  const code = ord?.ship?.vtpCode;
  if (!btn || !code) return;
  const act = btn.dataset.vtpAct;
  if (act === 'print') return printVtpLabels([code]);
  if (act === 'track') return window.open(vtpTrackUrl(code), '_blank');
  if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(code);
      toast('Đã sao chép mã vận đơn');
    } catch {}
    return;
  }
  if (!vtpConnected()) return toast('Chưa kết nối Viettel Post', '⚠️');
  if (act === 'cancel') {
    if (!(await askConfirm({ title: 'Huỷ vận đơn?', message: `Huỷ vận đơn ${code} trên Viettel Post. Đơn sẽ về lại Chờ gửi.`, ok: 'Huỷ vận đơn', danger: true }))) return;
    btn.disabled = true;
    const r = await apiFetch('/api/vtp/cancel', jsonPost({ code })).catch(() => null);
    btn.disabled = false;
    if (!r?.ok) return toast(r?.error || 'Không huỷ được', '⚠️', 4000);
    toast('Đã huỷ vận đơn, đơn về Chờ gửi', '↩');
    return;
  }
  if (act === 'redeliver' || act === 'return') {
    const type = act === 'redeliver' ? 3 : 2;
    const note =
      act === 'redeliver'
        ? await askConfirm({
            title: 'Yêu cầu phát lại',
            message: `Vận đơn ${code}`,
            ok: 'Gửi yêu cầu',
            input: { label: 'Ghi chú cho bưu tá', placeholder: 'Ví dụ: gọi trước khi giao, giao giờ hành chính' }
          })
        : '';
    if (note === false) return;
    if (act === 'return' && !(await askConfirm({ title: 'Đồng ý hoàn đơn?', message: `Viettel Post sẽ hoàn vận đơn ${code} về shop.`, ok: 'Đồng ý hoàn' }))) return;
    btn.disabled = true;
    const r = await apiFetch('/api/vtp/resolve', jsonPost({ code, type, note })).catch(() => null);
    btn.disabled = false;
    if (!r?.ok) return toast(r?.error || 'Viettel Post không nhận yêu cầu', '⚠️', 4000);
    toast(type === 3 ? 'Đã gửi yêu cầu phát lại' : 'Đã đồng ý hoàn', '✓');
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
            <input type="text" class="form-field-input item-edit-price" value="${it.price ? formatVND(it.price) : ''}" placeholder="Giá tiền" inputmode="numeric" />
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
    name: '',
    price: 0,
    qty: 1
  });
  renderEditOrderItemsModal();
  $$('#edit-items-container .item-edit-name').pop()?.focus();
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
    // Dòng trống (chưa gõ tên, chưa gõ giá) thì bỏ; có giá mà quên tên thì gọi là "Sản phẩm".
    const items = editingOrderItemsCopy
      .filter((it) => String(it.name || '').trim() || it.price)
      .map((it) => ({ ...it, name: String(it.name || '').trim() || 'Sản phẩm' }));
    const sum = (list) => list.reduce((s, x) => s + (Number(x.price) || 0) * (Number(x.qty) || 1), 0);
    const moneyChanged = sum(items) !== sum(ord.items || []);
    // Đơn đã có vận đơn thì tiền thu hộ đã gửi Viettel Post: đổi món ở đây không đổi được số đó.
    if (moneyChanged && ord.ship?.vtpCode && ord.status !== 'done') {
      return toast(`Đơn đã có vận đơn ${ord.ship.vtpCode}, tiền thu hộ đã gửi Viettel Post. Huỷ vận đơn rồi mới sửa món.`, '⚠️', 5000);
    }
    ord.items = items;
    ord.subtotal = sum(items);
    ord.total = Math.max(0, ord.subtotal + (Number(ord.shippingFee) || 0) - (Number(ord.discount) || 0));
    const codReset = moneyChanged && clearManualCod(ord);
    save('order_items_edited');
    openOrderDetailView(currentDetailOrderId);
    $('#modal-edit-order-items')?.close();
    if (codReset) toast(`Đơn của ${ord.nickname || ord.uniqueId} vừa đổi món: đã bỏ tiền thu hộ nhập tay, tính lại theo hàng mới`, 'ℹ️', 5000);
    else toast(`Đã cập nhật${syncedWord()} sản phẩm trong đơn!`, '✓');
  }
});

$('#btn-detail-delete-order')?.addEventListener('click', () => {
  confirmDeleteOrder(state.orders.find((o) => o.id === currentDetailOrderId));
});

$('#btn-detail-comments')?.addEventListener('click', () => {
  openOrderComments(state.orders.find((o) => o.id === currentDetailOrderId));
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
  if (!name) return fieldError('#new-ord-name', 'Nhập tên khách hàng');

  const handle = ($('#new-ord-handle')?.value.trim() || name.toLowerCase().replace(/\s+/g, '')).replace(/^@/, '');
  const phone = $('#new-ord-phone')?.value.trim() || '';
  const address = $('#new-ord-address')?.value.trim() || '';
  const prodName = $('#new-ord-product-name')?.value.trim() || 'Sản phẩm';
  const priceRaw = $('#new-ord-price')?.value.trim() || '';
  const price = parsePriceInput(priceRaw, Number(S().multiplier || 1000));
  const note = $('#new-ord-note')?.value.trim() || '';
  if (!price) return fieldError('#new-ord-price', 'Nhập giá sản phẩm, ví dụ 150 hoặc 150000');

  const { order } = addOrMergeOrder({
    uniqueId: handle,
    nickname: name,
    productName: prodName,
    price,
    qty: 1,
    forceNew: true
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

$('#btn-order-filter-icon')?.addEventListener('click', openOrderTimeFilter);

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
      <div class="empty-box">
        Chưa có tài khoản TikTok nào. Bấm <b>+ Thêm tài khoản</b> bên dưới để liên kết shop của bạn.
      </div>
    `;
    return;
  }

  accountsContainer.innerHTML = accounts
    .map(
      (acc, idx) => `
      <div class="account-item-box" data-account-card="${acc.id}" role="button" tabindex="0">
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
  if (!name) return fieldError('#input-new-acc-name', 'Nhập tên shop');
  if (!handle) return fieldError('#input-new-acc-handle', 'Nhập username TikTok');

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

$('#menu-row-printer')?.addEventListener('click', () => openSettingsPane('printer'));
$('#btn-sidebar-printer')?.addEventListener('click', () => openSettingsPane('printer'));
$('#btn-header-printer-status')?.addEventListener('click', () => openSettingsPane('printer'));

// Đồng bộ Web & App IPA Modal
function openSyncSetupModal() {
  if ($('#input-sync-server-url')) {
    $('#input-sync-server-url').value = S().serverUrl || getServerBaseUrl();
  }
  updateSyncUI(syncStatus);
  renderSyncGuide();
  openSettingsPane('sync');
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
  if ($('#cfg-kw-triggers')) $('#cfg-kw-triggers').value = S().triggers || 'chốt, lấy';
  openSettingsPane('keywords');
});

$('#btn-save-keyword-setup')?.addEventListener('click', () => {
  S().multiplier = $('#cfg-kw-multiplier')?.value || '1000';
  S().autoPrint = $('#cfg-kw-autoprint')?.checked;
  S().triggers = $('#cfg-kw-triggers')?.value.trim() || 'chốt, lấy';
  save('settings_keywords');
  $('#modal-keyword-setup')?.close();
  toast('Đã lưu cấu hình bắt giá tự động!', '✓');
});

$('#menu-row-notify')?.addEventListener('click', () => {
  if ($('#cfg-notify-sound')) $('#cfg-notify-sound').checked = S().sound !== false;
  if ($('#cfg-notify-voice')) $('#cfg-notify-voice').checked = S().voiceEnabled === true;
  openSettingsPane('notify');
});

// Công tắc thông báo: gạt là lưu ngay.
['#cfg-notify-sound', '#cfg-notify-voice'].forEach((sel) =>
  $(sel)?.addEventListener('change', () => {
    S().sound = $('#cfg-notify-sound')?.checked;
    S().voiceEnabled = $('#cfg-notify-voice')?.checked;
    save('settings_notify');
  })
);

$('#menu-row-account')?.addEventListener('click', () => openSettingsPane('account'));
$('#menu-row-tiktok')?.addEventListener('click', () => openSettingsPane('tiktok'));
$('#btn-sidebar-shop-profile')?.addEventListener('click', () => openSettingsPane('tiktok'));
$('#menu-row-admin')?.addEventListener('click', () => switchTab('admin'));
$('#btn-settings-back')?.addEventListener('click', () => $('#settings-md')?.classList.remove('has-pane'));
$('#btn-expired-help')?.addEventListener('click', () => {
  $('#modal-access-expired')?.close();
  openSupportChat();
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

/* ===== Chat với quản trị viên (khách) ===== */
let supportUnread = 0;

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

function renderSupportUnread() {
  for (const id of ['#help-unread-badge']) {
    const el = $(id);
    if (!el) continue;
    el.textContent = String(supportUnread);
    el.style.display = supportUnread > 0 ? 'inline-block' : 'none';
  }
}

async function refreshSupportUnread() {
  const cur = getCurrentUser();
  if (!cur || cur.role === 'admin' || !getAuthToken()) return;
  try {
    const res = await apiFetch('/api/support/sessions');
    const data = await res.json();
    if (res.ok && data.ok) {
      supportUnread = data.unread || 0;
      renderSupportUnread();
    }
  } catch {}
}

const supportChatIsOpen = () => activeTab === 'settings' && settingsPane === 'help';
let supportView = null; // null = danh sách, 'new' = phiên mới chưa gửi, còn lại = id phiên
let supportThreads = [];

const supportDay = (ts) => new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
const supportClock = (ts) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

function renderMySupportList() {
  const hasOpen = supportThreads.some((s) => s.open);
  $('#support-new-session').style.display = hasOpen ? 'none' : '';
  $('#support-toolbar').style.display = '';
  $('#support-cards').innerHTML = supportThreads.length
    ? supportThreads
        .map((s) => {
          const last = s.messages[s.messages.length - 1];
          return `<button type="button" class="support-row2" data-support-open="${esc(s.id)}">
            <i class="support-dot ${s.open ? '' : 'off'}"></i>
            <span class="support-row2-main"><b>Phiên ${esc(supportDay(s.createdAt))}</b>
              <span>${last ? (last.sender === 'admin' ? 'Quản trị viên: ' : 'Bạn: ') + esc(last.text) : 'Chưa có tin nhắn'}</span></span>
            <span class="support-row2-side"><b class="${s.open ? 'on' : ''}">${s.open ? 'Đang mở' : 'Đã đóng'}</b>
              <small>${esc(supportClock(last ? last.ts : s.lastAt))}</small></span></button>`;
        })
        .join('')
    : '<p class="support-empty">Chưa có phiên chat nào. Bấm “Phiên mới” để nhắn cho quản trị viên.</p>';
}

function renderMySupportThread() {
  const s = supportThreads.find((x) => x.id === supportView);
  const canType = supportView === 'new' || (s && s.open);
  $('#support-toolbar').style.display = 'none';
  const msgs = s
    ? s.messages
        .map(
          (m) => `<div class="support-msg ${m.sender === 'user' ? 'mine' : ''}">${esc(m.text)}<small>${m.sender === 'admin' ? 'Quản trị viên · ' : ''}${esc(supportClock(m.ts))}</small></div>`
        )
        .join('')
    : '';
  $('#support-cards').innerHTML = `<div class="support-thread-wrap">
    <div class="support-thread-head"><button type="button" class="support-back" id="support-back">‹ Các phiên</button>
      <b>${s ? 'Phiên ' + esc(supportDay(s.createdAt)) : 'Phiên mới'}</b>
      ${s && s.open ? '<button type="button" class="support-end" id="support-end">Kết thúc</button>' : '<span style="width:70px"></span>'}</div>
    <div class="support-thread-body support-user-body" id="support-user-body">${msgs || '<p class="support-empty">Nhắn cho quản trị viên nếu bạn cần hỗ trợ. Khi có trả lời, bạn sẽ được báo ngay.</p>'}</div>
    ${
      canType
        ? `<div class="support-reply"><textarea id="support-user-text" rows="2" maxlength="2000" placeholder="Nhập tin nhắn… (Enter để gửi)"></textarea>
           <button type="button" class="btn-orange-pill" id="support-user-send" style="height:44px;padding:0 20px">Gửi</button></div>`
        : '<div class="support-reply-closed">Phiên này đã đóng. Quay lại danh sách và bấm “Phiên mới” để nhắn tiếp.</div>'
    }</div>`;
  const body = $('#support-user-body');
  if (body) body.scrollTop = body.scrollHeight;
}

let supportSig = '';
async function loadSupportChat(quiet = false) {
  const box = $('#support-cards');
  if (!box) return;
  const draft = $('#support-user-text')?.value || '';
  const hadFocus = document.activeElement?.id === 'support-user-text';
  try {
    const res = await apiFetch('/api/support/sessions?full=1');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error();
    const sig = JSON.stringify(data.sessions) + '|' + supportView;
    if (quiet && sig === supportSig) return; // không đổi: khỏi vẽ lại, giữ nguyên con trỏ đang gõ
    supportSig = sig;
    supportThreads = data.sessions;
    if (supportView === null) renderMySupportList();
    else renderMySupportThread();
    if (draft && $('#support-user-text')) $('#support-user-text').value = draft;
    if (hadFocus) $('#support-user-text')?.focus();
    if (supportView !== null && supportView !== 'new') {
      await apiFetch('/api/support/read', jsonPost({}));
      supportUnread = 0;
      renderSupportUnread();
    }
  } catch {
    box.innerHTML = '<p class="support-empty">Không tải được tin nhắn, thử lại sau.</p>';
  }
}

async function sendSupportMessage() {
  const input = $('#support-user-text');
  const text = (input?.value || '').trim();
  if (!text) return;
  const btn = $('#support-user-send');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/support/messages', jsonPost({ text }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) toast(data.error || 'Không gửi được', '⚠️');
    else {
      input.value = '';
      supportView = data.message.sessionId;
      await loadSupportChat();
    }
  } catch {
    toast('Không gửi được, thử lại sau', '⚠️');
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

function openSupportChat() {
  supportView = null;
  openSettingsPane('help');
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  loadSupportChat();
}

$('#menu-row-help')?.addEventListener('click', openSupportChat);
setInterval(() => {
  if (supportChatIsOpen() && !document.hidden) loadSupportChat(true);
}, 3000);
$('#support-new-session')?.addEventListener('click', () => {
  supportView = 'new';
  renderMySupportThread();
  $('#support-user-text')?.focus();
});
$('#support-cards')?.addEventListener('click', async (e) => {
  const row = e.target.closest('[data-support-open]');
  if (row) {
    supportView = row.dataset.supportOpen;
    return loadSupportChat();
  }
  if (e.target.closest('#support-back')) {
    supportView = null;
    return loadSupportChat();
  }
  if (e.target.closest('#support-user-send')) return sendSupportMessage();
  if (e.target.closest('#support-end')) {
    await apiFetch('/api/support/end', jsonPost({})).catch(() => {});
    loadSupportChat();
  }
});
$('#support-cards')?.addEventListener('keydown', (e) => {
  if (e.target.id === 'support-user-text' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendSupportMessage();
  }
});

onSupportMessage((msg) => {
  const cur = getCurrentUser();
  if (!cur || cur.role === 'admin' || msg.message.sender !== 'admin') return;
  if (supportChatIsOpen() && supportView !== null && supportView !== 'new') {
    loadSupportChat();
    return;
  }
  supportUnread = msg.unread ?? supportUnread + 1;
  renderSupportUnread();
  toast(`Admin: ${msg.message.text.slice(0, 60)}`, '💬', 4000);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('Admin đã trả lời', { body: msg.message.text.slice(0, 120) });
    } catch {}
  }
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
  $$('#auth-screen-overlay .field-error.auto').forEach((p) => p.remove());
  $$('#auth-screen-overlay [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
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

$$('[data-admin-tab]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const tab = btn.dataset.adminTab;
    $$('[data-admin-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    $('#admin-tab-users').hidden = tab !== 'users';
    $('#admin-tab-support').hidden = tab !== 'support';
  })
);

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
    if ($('#admin-support-panel')) $('#admin-support-panel').style.display = 'none';
    if ($('#nav-btn-admin-shortcut')) $('#nav-btn-admin-shortcut').style.display = 'none';
    return;
  }

  overlay?.classList.add('hidden');
  const isAdmin = user.role === 'admin';
  loadVtpStatus();

  if ($('#current-auth-avatar')) {
    $('#current-auth-avatar').textContent = avatarInitial(user.username);
  }
  if ($('#current-auth-username')) {
    $('#current-auth-username').textContent = user.username;
  }
  if ($('#current-auth-role-badge')) {
    $('#current-auth-role-badge').textContent = isAdmin ? 'Quản trị viên' : 'Thành viên';
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

  if ($('#admin-support-panel')) $('#admin-support-panel').style.display = isAdmin ? 'block' : 'none';
  if ($('#menu-row-admin')) $('#menu-row-admin').hidden = !isAdmin;
  if (!isAdmin && activeTab === 'admin') switchTab('live');
  if (isAdmin) {
    loadAdminUsers();
    loadSupportList();
  } else {
    refreshSupportUnread();
  }
}

/* ===== Hỗ trợ khách (Admin): danh sách khách, xem lịch sử các phiên, trả lời ===== */
let supportRows = [];
let supportOpenUserId = null;

const supportTime = (ts) =>
  new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

async function loadSupportList() {
  const cur = getCurrentUser();
  if (!cur || cur.role !== 'admin') return;
  try {
    const res = await apiFetch('/api/admin/support/sessions');
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    supportRows = data.sessions;
    renderSupportList(data.unread);
  } catch {}
}

function renderSupportList(unread) {
  const box = $('#support-admin-list');
  if (!box) return;
  const total = unread ?? supportRows.reduce((n, s) => n + s.unread, 0);
  if ($('#admin-support-unread')) $('#admin-support-unread').textContent = `${total} tin mới`;
  if (!supportRows.length) {
    box.innerHTML = '<p class="support-empty">Chưa có khách nào nhắn.</p>';
    return;
  }
  box.innerHTML = supportRows
    .map(
      (s) => `<button type="button" class="support-row ${s.userId === supportOpenUserId ? 'is-active' : ''}" data-support-user="${esc(s.userId)}">
        <span class="support-row-top"><span>${esc(s.username || s.userId)}</span>${s.unread ? `<span class="support-badge">${s.unread}</span>` : ''}</span>
        <span class="support-row-last">${s.lastSender === 'admin' ? 'Bạn: ' : ''}${esc(s.lastText)}</span>
        <span class="support-state ${s.open ? '' : 'closed'}">${s.open ? 'Đang mở' : 'Đã đóng'} · ${esc(supportTime(s.lastAt))}</span>
      </button>`
    )
    .join('');
}

async function openSupportThread(userId, { markRead = true } = {}) {
  supportOpenUserId = userId;
  const thread = $('#support-admin-thread');
  if (!thread) return;
  try {
    const res = await apiFetch(`/api/admin/support/history?userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    const sessions = [...data.sessions].reverse(); // cũ trước, mới sau
    const latest = data.sessions[0];
    const body = sessions
      .map(
        (s) =>
          `<div class="support-sep">Phiên ${esc(supportTime(s.createdAt))} · ${s.open ? 'đang mở' : 'đã đóng'}</div>` +
          s.messages
            .map(
              (m) => `<div class="support-msg ${m.sender === 'admin' ? 'admin' : ''}">${esc(m.text)}<small>${esc(supportTime(m.ts))}</small></div>`
            )
            .join('')
      )
      .join('');
    const footer =
      latest && latest.open
        ? `<div class="support-reply"><textarea id="support-reply-text" rows="2" maxlength="2000" placeholder="Nhập trả lời…"></textarea>
             <button type="button" class="btn-orange-pill" id="support-reply-send" data-session="${esc(latest.id)}" style="height:40px;padding:0 18px">Gửi</button></div>`
        : '<div class="support-reply-closed">Phiên đã đóng (quá 24 giờ không có tin mới). Khi khách nhắn lại sẽ mở phiên mới.</div>';
    thread.innerHTML = `<div class="support-thread-title">${esc(data.username || userId)}</div>
      <div class="support-thread-body" id="support-thread-body">${body || '<p class="support-empty">Chưa có tin nhắn.</p>'}</div>${footer}`;
    const tb = $('#support-thread-body');
    if (tb) tb.scrollTop = tb.scrollHeight;
    if (markRead) {
      await apiFetch('/api/admin/support/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
    }
    loadSupportList();
  } catch {}
}

$('#support-admin-list')?.addEventListener('click', (e) => {
  const row = e.target.closest('[data-support-user]');
  if (row) openSupportThread(row.dataset.supportUser);
});

$('#support-admin-thread')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('#support-reply-send');
  if (!btn) return;
  const input = $('#support-reply-text');
  const text = (input?.value || '').trim();
  if (!text) return;
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/support/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: btn.dataset.session, text })
    });
    const data = await res.json();
    if (!res.ok) toast(data.error || 'Không gửi được', '⚠️');
    else await openSupportThread(supportOpenUserId, { markRead: false });
  } catch {
    toast('Không gửi được, thử lại sau', '⚠️');
  }
});

onSupportMessage((msg) => {
  const cur = getCurrentUser();
  if (!cur || cur.role !== 'admin' || msg.message.sender !== 'user') return;
  if (msg.message.userId === supportOpenUserId) openSupportThread(supportOpenUserId);
  else {
    toast(`${msg.username || 'Khách'}: ${msg.message.text.slice(0, 60)}`, '💬', 4000);
    loadSupportList();
  }
});

// Xử lý Form Đăng nhập
$('#form-auth-login')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#auth-login-username')?.value.trim();
  const password = $('#auth-login-password')?.value || '';
  if (!username || !password) {
    return fieldError(!username ? '#auth-login-username' : '#auth-login-password', !username ? 'Nhập tên tài khoản' : 'Nhập mật khẩu');
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
    return fieldError('#auth-reg-username', 'Nhập tên tài khoản');
  }
  if (password.length < 6) {
    return fieldError('#auth-reg-password', 'Mật khẩu phải có ít nhất 6 ký tự');
  }
  if (password !== confirmPassword) {
    return fieldError('#auth-reg-confirm', 'Hai ô mật khẩu không giống nhau');
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
    return fieldError(!currentPassword ? '#own-pass-current' : '#own-pass-new', !currentPassword ? 'Nhập mật khẩu hiện tại' : 'Nhập mật khẩu mới');
  }
  if (newPassword !== confirmPassword) {
    return fieldError('#own-pass-confirm', 'Hai ô mật khẩu mới không giống nhau');
  }

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return fieldError('#own-pass-current', data.error || 'Không thể đổi mật khẩu');
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
  const short = access.status === 'plan' ? `Gói đến ${accessDate(access.endsAt)}` : adminAccessText(access);
  return `<span class="status-pill-badge ${access.status === 'expired' ? 'locked' : access.status}">${esc(short)}</span>`;
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

$('#btn-revoke-admin-plan')?.addEventListener('click', async () => {
  const user = adminUsersList.find((u) => u.id === targetPlanUserId);
  if (!user) return;
  if (!(await askConfirm({ title: 'Thu hồi gói?', message: `Thu hồi gói của tài khoản "${user.username}". Tài khoản quay về trạng thái hết hạn.`, ok: 'Thu hồi gói', danger: true }))) return;
  submitPlanChange({ method: 'DELETE' }, (u) => `Đã thu hồi gói của "${u.username}"`);
});

function renderAdminUsersTable() {
  const container = $('#admin-users-list');
  if (!container) return;

  if ($('#admin-tab-users-count')) $('#admin-tab-users-count').textContent = String(adminUsersList.length);
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
          ? `<span class="online-on">Online (${u.onlineCount} thiết bị)</span>`
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
                  ${u.role === 'admin' ? 'Admin' : 'Thành viên'}
                </span>
                <span class="status-pill-badge ${u.locked ? 'locked' : 'active'}">
                  ${u.locked ? 'Đã khoá' : 'Hoạt động'}
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
                    Cấp gói
                  </button>`
                : ''
            }
            ${
              !isPrimaryAdmin && !isSelf
                ? `<button type="button" class="btn-admin-act ${u.locked ? 'unlock-btn' : 'lock-btn'}" data-admin-lock-id="${esc(u.id)}" data-admin-locked="${u.locked ? '1' : '0'}">
                    ${u.locked ? 'Mở khoá' : 'Khoá'}
                  </button>`
                : ''
            }
            <button type="button" class="btn-admin-act pass-btn" data-admin-pass-id="${esc(u.id)}" data-admin-pass-name="${esc(u.username)}">
              Đổi mật khẩu
            </button>
            ${
              !isPrimaryAdmin && !isSelf
                ? `<button type="button" class="btn-admin-act del-btn" data-admin-delete-id="${esc(u.id)}" data-admin-delete-name="${esc(u.username)}">
                    Xoá
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
    if (nextLocked) {
      const target = adminUsersList.find((u) => u.id === userId);
      const yes = await askConfirm({
        title: `Khoá tài khoản ${target?.username || ''}?`,
        message: 'Tài khoản bị thoát khỏi mọi thiết bị ngay lập tức và không đăng nhập lại được cho tới khi mở khoá.',
        ok: 'Khoá tài khoản',
        danger: true
      });
      if (!yes) return;
    }
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
    if (!(await askConfirm({ title: `Xoá tài khoản ${uname}?`, message: 'Xoá vĩnh viễn tài khoản và dữ liệu của tài khoản này. Không khôi phục được.', ok: 'Xoá tài khoản', danger: true }))) return;
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
    return fieldError('#admin-input-new-pass', 'Mật khẩu mới phải có ít nhất 6 ký tự');
  }
  if (newPassword !== confirmPassword) {
    return fieldError('#admin-input-confirm-pass', 'Hai ô mật khẩu mới không giống nhau');
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

  if (!username) return fieldError('#admin-create-username', 'Nhập tên tài khoản');
  if (password.length < 6) return fieldError('#admin-create-password', 'Mật khẩu phải có ít nhất 6 ký tự');
  if (password !== confirmPassword) return fieldError('#admin-create-confirm', 'Hai ô mật khẩu không giống nhau');

  try {
    const res = await apiFetch('/api/admin/users/create', {
      method: 'POST',
      body: JSON.stringify({ username, password, confirmPassword, role })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return fieldError('#admin-create-username', data.error || 'Không thể tạo tài khoản');
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
  if (await askConfirm({ title: 'Đăng xuất?', message: 'Bạn sẽ thoát khỏi tài khoản này trên máy đang dùng. Dữ liệu vẫn nằm trên máy chủ.', ok: 'Đăng xuất', danger: true })) {
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

$$('[data-goto-orders]').forEach((row) =>
  row.addEventListener('click', () => {
    switchTab('orders');
    $(`[data-order-filter="${row.dataset.gotoOrders}"]`)?.click();
  })
);

$('#btn-export-sales-report')?.addEventListener('click', () => {
  try {
    exportOrdersToCSV(state.orders);
    toast('Đã xuất file báo cáo đơn hàng Excel (CSV UTF-8)', '📥');
  } catch (err) {
    toast(err.message || 'Lỗi khi xuất file', '⚠️');
  }
});

/** Số tiền viết gọn để ghi trên đầu cột biểu đồ: 4,9tr, 850k. */
function shortMoney(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',').replace(/,0$/, '')}tr`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

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
              ${b.amount > 0 ? `<span class="barchart-tooltip-val">${esc(shortMoney(b.amount))}</span>` : ''}
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
  if (!c) return toast('Không tìm thấy bình luận này', '⚠️');
  const hasPrice = c.price > 0;

  const { order, newItem, isDuplicate, codReset } = addOrMergeOrder({
    uniqueId: c.uniqueId,
    userId: c.userId || '',
    nickname: c.nickname,
    // Bình luận không có giá vẫn lưu lại được: lấy chính nội dung làm tên món, giá 0.
    productName: (hasPrice && c.productName) || String(c.comment || '').trim().slice(0, 60) || 'Sản phẩm',
    price: hasPrice ? c.price : 0,
    qty: c.qty || 1,
    comment: c.comment,
    commentId: c.id,
    sessionId: c.sessionId || ''
  });
  const item = newItem || order.items.find((it) => it.commentId === c.id);
  if (!item) return toast('Không lưu được bình luận vào khách', '⚠️');
  if (isDuplicate) toast('Bình luận này đã lưu trước đó, in lại tem', 'ℹ️');
  if (codReset) toast(`Đơn của ${order.nickname} có thêm món: đã bỏ tiền thu hộ nhập tay, tính lại theo hàng mới`, 'ℹ️', 5000);

  c.printed = true;
  state.selectedCustomerUniqueId = c.uniqueId;
  handlePrintOrder(order, false, item);
}

async function handlePrintOrder(order, isRemoteTrigger = false, onlyItem = null) {
  toast(`Đang in tem cho ${order.nickname}...`, '🖨');
  order.printCount = (order.printCount || 0) + 1;
  // In lại tem của đơn đã duyệt, đang giao hay đã giao thì không kéo đơn lùi về "Đã in".
  if (!order.status || order.status === 'new') order.status = 'printed';
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
          <button class="btn-outline-pill btn-print-sys-sm">In qua máy tính</button>
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
  // In thử trên bản sao: không đổi trạng thái, số lần in của đơn thật và không ghi vào lịch sử in.
  const testOrder = state.orders[0] ? { ...state.orders[0] } : {
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
  handlePrintOrder(testOrder, true);
});

$('#btn-clear-tray')?.addEventListener('click', () => {
  const tray = $('#printer-paper-tray');
  if (tray) {
    tray.innerHTML =
      '<p class="form-hint" id="tray-empty-hint">Tem in sẽ hiện ở đây khi in</p>';
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
      ? `Đồng bộ · ${count} thiết bị`
      : `Đang kết nối lại...${waitingText}`;
  }
  if ($('#lbl-sync-conn-state')) {
    $('#lbl-sync-conn-state').textContent = connected
      ? `Đang đồng bộ (${count})`
      : `Đang kết nối...${waitingText}`;
  }
  if ($('#modal-sync-status-title')) {
    $('#modal-sync-status-title').textContent = connected
      ? 'Đã kết nối máy chủ'
      : 'Đang kết nối tới máy chủ...';
  }
  if ($('#modal-sync-devices-sub')) {
    $('#modal-sync-devices-sub').textContent =
      count > 1
        ? `${count} thiết bị đang cùng đồng bộ`
        : 'Mới có 1 thiết bị. Nếu điện thoại đang mở app mà số này không tăng thì điện thoại đang dùng server hoặc tài khoản khác.';
  }
}

onSyncStatusChange(updateSyncUI);
window.addEventListener('chotlive-sync-error', (e) => toast(String(e.detail || ''), '⚠️', 6000));

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
