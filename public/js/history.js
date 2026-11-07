/**
 * Lịch sử bình luận các phiên live (lưu IndexedDB – chứa được hàng trăm nghìn comment)
 * - sessions: mỗi lần kết nối live = 1 phiên
 * - comments: mọi bình luận, gắn sessionId
 * - Giao diện: nhóm theo ngày → phiên, tìm theo tên/nội dung, lọc khung giờ, chỉ tin chốt đơn
 */
const DB_NAME = 'susu_history';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('comments')) {
        const s = db.createObjectStore('comments', { keyPath: 'key' });
        s.createIndex('sessionId', 'sessionId');
        s.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx(stores, mode, fn) {
  const db = await openDB();
  const t = db.transaction(stores, mode);
  const out = fn(t);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return out;
}

/* ---------------- Ghi dữ liệu ---------------- */
let current = null; // phiên đang chạy
let pending = [];
let flushTimer = null;

export async function startSession(username) {
  if (current) await endSession();
  const now = Date.now();
  current = { id: 's_' + now.toString(36), username, startTs: now, endTs: now, count: 0, priceCount: 0 };
  try { await tx(['sessions'], 'readwrite', (t) => t.objectStore('sessions').put(current)); } catch {}
  return current;
}

export async function endSession() {
  if (!current) return;
  await flush();
  const s = current;
  current = null;
  try { await tx(['sessions'], 'readwrite', (t) => t.objectStore('sessions').put(s)); } catch {}
}

/** Phiên do server tạo: nhiều live ghi cùng lúc, mỗi bình luận vào đúng phiên của nó. */
const serverSessions = new Map();

function serverSessionOf(c, ts) {
  let s = serverSessions.get(c.sessionId);
  if (!s) {
    s = { id: c.sessionId, username: c.live || 'live', startTs: ts, endTs: ts, count: 0, priceCount: 0 };
    serverSessions.set(c.sessionId, s);
  }
  return s;
}

export function saveComment(c) {
  const ts = c.ts || Date.now();
  let s;
  if (c.sessionId) {
    s = serverSessionOf(c, ts);
  } else {
    if (!current) {
      // Chưa có phiên (vd. mất kết nối rồi tự nối lại) -> tạo phiên ngầm
      startSession(c.live || 'live');
    }
    s = current;
  }
  if (!s) return;
  s.count += 1;
  if (c.price) s.priceCount += 1;
  s.endTs = Math.max(s.endTs || 0, ts);
  pending.push({
    key: s.id + '|' + (c.id || ts + Math.random()),
    sessionId: s.id,
    ts,
    uniqueId: c.uniqueId || '',
    userId: c.userId || '',
    nickname: c.nickname || '',
    comment: c.comment || '',
    price: c.price || 0,
    productName: c.productName || '',
    phone: c.phone || '',
    quantity: c.quantity || 1,
  });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 1500);
}

async function flush() {
  clearTimeout(flushTimer);
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  const s = current;
  const touched = [...serverSessions.values()].map((x) => ({ ...x }));
  for (const x of serverSessions.values()) {
    x.count = 0;
    x.priceCount = 0;
  }
  try {
    await tx(['comments', 'sessions'], 'readwrite', (t) => {
      const cs = t.objectStore('comments');
      batch.forEach((r) => cs.put(r));
      const ss = t.objectStore('sessions');
      if (s) ss.put(s);
      // Mở lại trang vẫn cộng dồn vào phiên đã có, không ghi đè số đếm cũ.
      touched.forEach((x) => {
        const req = ss.get(x.id);
        req.onsuccess = () => {
          const old = req.result;
          ss.put({
            ...x,
            startTs: old ? Math.min(old.startTs, x.startTs) : x.startTs,
            endTs: old ? Math.max(old.endTs, x.endTs) : x.endTs,
            count: (old?.count || 0) + x.count,
            priceCount: (old?.priceCount || 0) + x.priceCount
          });
        };
      });
    });
  } catch {
    pending = batch.concat(pending);
    for (const x of touched) {
      const live = serverSessions.get(x.id);
      if (live) {
        live.count += x.count;
        live.priceCount += x.priceCount;
      }
    }
  }
}

window.addEventListener('beforeunload', () => { flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

/* ---------------- Đọc dữ liệu ---------------- */
async function loadAll() {
  await flush();
  const db = await openDB();
  const t = db.transaction(['sessions', 'comments'], 'readonly');
  const [sessions, comments] = await Promise.all([
    reqP(t.objectStore('sessions').getAll()),
    reqP(t.objectStore('comments').getAll()),
  ]);
  return { sessions, comments };
}

export async function importHistory({ sessions, comments }) {
  await flush();
  const db = await openDB();
  const t = db.transaction(['sessions', 'comments'], 'readwrite');
  sessions.forEach((s) => t.objectStore('sessions').put(s));
  comments.forEach((c) => t.objectStore('comments').put(c));
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

async function deleteSession(id) {
  await flush();
  const db = await openDB();
  const t = db.transaction(['sessions', 'comments'], 'readwrite');
  t.objectStore('sessions').delete(id);
  const idx = t.objectStore('comments').index('sessionId');
  const cur = idx.openKeyCursor(IDBKeyRange.only(id));
  cur.onsuccess = () => {
    const c = cur.result;
    if (c) { t.objectStore('comments').delete(c.primaryKey); c.continue(); }
  };
  await new Promise((res) => { t.oncomplete = res; t.onerror = res; });
}

/* ---------------- Giao diện ---------------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayLabel = (k) => { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}`; };
const timeStr = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const vnd = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';

let data = { sessions: [], comments: [] };
const sel = { day: '', session: '' };
let searchTimer = null;

function highlight(text, q) {
  const raw = String(text || '');
  if (!q) return esc(raw);
  const nr = norm(raw);
  const nq = norm(q);
  const i = nr.indexOf(nq);
  // norm giữ nguyên độ dài ký tự (NFD bị bỏ dấu) nên chỉ highlight khi độ dài khớp
  if (i < 0 || nr.length !== raw.length) return esc(raw);
  return esc(raw.slice(0, i)) + '<mark class="hist-mark">' + esc(raw.slice(i, i + nq.length)) + '</mark>' + esc(raw.slice(i + nq.length));
}

function filters() {
  return {
    q: ($('#hist-search')?.value || '').trim(),
    from: $('#hist-hour-from')?.value || '',
    to: $('#hist-hour-to')?.value || '',
    onlyPrice: !!$('#hist-only-price')?.checked,
  };
}

function applyFilters() {
  const f = filters();
  const nq = norm(f.q);
  return data.comments.filter((c) => {
    if (sel.session && c.sessionId !== sel.session) return false;
    if (sel.day && !sel.session && dayKey(c.ts) !== sel.day) return false;
    if (f.onlyPrice && !c.price) return false;
    if (f.from !== '' || f.to !== '') {
      const h = new Date(c.ts).getHours();
      if (f.from !== '' && h < Number(f.from)) return false;
      if (f.to !== '' && h > Number(f.to)) return false;
    }
    if (nq) {
      const hay = norm(`${c.nickname} ${c.uniqueId} ${c.userId} ${c.comment} ${c.phone}`);
      if (!hay.includes(nq)) return false;
    }
    return true;
  }).sort((a, b) => b.ts - a.ts);
}

function renderSidebar() {
  const box = $('#hist-days');
  if (!box) return;
  const byDay = new Map();
  data.sessions.slice().sort((a, b) => b.startTs - a.startTs).forEach((s) => {
    const k = dayKey(s.startTs);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  });
  if (!byDay.size) {
    box.innerHTML = '<div class="hist-empty">Chưa có phiên live nào được lưu.<br>Kết nối Live ở tab Bán hàng, comment sẽ tự động được lưu lại.</div>';
    return;
  }
  const countByS = new Map();
  data.comments.forEach((c) => countByS.set(c.sessionId, (countByS.get(c.sessionId) || 0) + 1));
  box.innerHTML = `
    <button class="hist-day-all ${!sel.day && !sel.session ? 'active' : ''}" data-hday="" data-hsess="">📚 Tất cả (${data.sessions.length} live • ${data.comments.length} cmt)</button>
  ` + [...byDay.entries()].map(([k, list]) => {
    const total = list.reduce((s, x) => s + (countByS.get(x.id) || 0), 0);
    return `
      <div class="hist-day-group">
        <button class="hist-day-head ${sel.day === k && !sel.session ? 'active' : ''}" data-hday="${k}" data-hsess="">
          <span>📅 ${dayLabel(k)}</span>
          <span class="hist-day-meta">${list.length} live • ${total} cmt</span>
        </button>
        ${list.map((s) => `
          <div class="hist-sess-row">
            <button class="hist-sess ${sel.session === s.id ? 'active' : ''}" data-hday="${k}" data-hsess="${s.id}">
              <b>@${esc(s.username)}</b>
              <span>${hm(s.startTs)} – ${hm(s.endTs)} • ${countByS.get(s.id) || 0} cmt${s.priceCount ? ` • ${s.priceCount} chốt` : ''}</span>
            </button>
            <button class="hist-sess-del" data-hdel="${s.id}" title="Xoá phiên này">🗑</button>
          </div>`).join('')}
      </div>`;
  }).join('');
}

function renderResults() {
  const box = $('#hist-results');
  const info = $('#hist-info');
  if (!box) return;
  const f = filters();
  const list = applyFilters();
  const users = new Set(list.map((c) => c.userId || c.uniqueId || c.nickname));
  const revenue = list.reduce((s, c) => s + (c.price ? c.price * (c.quantity || 1) : 0), 0);
  const sess = sel.session ? data.sessions.find((s) => s.id === sel.session) : null;
  const scope = sess ? `Phiên @${sess.username} ${dayLabel(dayKey(sess.startTs))}` : sel.day ? `Ngày ${dayLabel(sel.day)}` : 'Tất cả các phiên';
  info.innerHTML = `<b>${esc(scope)}</b> • ${list.length} bình luận • ${users.size} người${revenue ? ` • chốt ~${vnd(revenue)}` : ''}`;

  if (!list.length) {
    box.innerHTML = '<div class="hist-empty">Không có bình luận phù hợp.</div>';
    return;
  }
  const shown = list.slice(0, 300);
  let lastDay = '';
  box.innerHTML = shown.map((c) => {
    const k = dayKey(c.ts);
    const head = (!sel.session && k !== lastDay) ? `<div class="hist-date-sep">${dayLabel(k)}</div>` : '';
    lastDay = k;
    const sess2 = data.sessions.find((s) => s.id === c.sessionId);
    return `${head}
      <div class="hist-cmt ${c.price ? 'has-price' : ''}">
        <div class="hist-time"><b>${timeStr(c.ts)}</b>${sess2 && !sel.session ? `<small>@${esc(sess2.username)}</small>` : ''}</div>
        <div class="hist-body">
          <div class="hist-user">
            <a href="#" data-huser="${esc(c.nickname || c.uniqueId)}">${highlight(c.nickname || c.uniqueId, f.q)}</a>
            ${c.uniqueId && c.uniqueId !== c.nickname ? `<span class="hist-uid">@${highlight(c.uniqueId, f.q)}</span>` : ''}
          </div>
          <div class="hist-text">${highlight(c.comment, f.q)}</div>
          ${c.price ? `<div class="hist-deal">🛍 ${esc(c.productName || 'Sản phẩm')} ${c.quantity > 1 ? '×' + c.quantity : ''} • ${vnd(c.price * (c.quantity || 1))}${c.phone ? ' • 📞 ' + esc(c.phone) : ''}</div>` : ''}
        </div>
      </div>`;
  }).join('') + (list.length > shown.length ? `<div class="hist-empty">Hiển thị 300/${list.length} kết quả mới nhất – hãy thu hẹp bằng ô tìm kiếm / khung giờ.</div>` : '');
}

function exportCSV() {
  const list = applyFilters();
  if (!list.length) return;
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Ngày', 'Giờ', 'Tên', 'Username', 'Bình luận', 'Giá', 'Sản phẩm', 'SĐT'].map(q).join(',')];
  list.forEach((c) => rows.push([dayLabel(dayKey(c.ts)), timeStr(c.ts), c.nickname, c.uniqueId, c.comment, c.price || '', c.productName, c.phone].map(q).join(',')));
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lich-su-comment-${dayKey(Date.now())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  ['#hist-hour-from', '#hist-hour-to'].forEach((s) => {
    const el = $(s);
    if (el) for (let h = 0; h < 24; h++) el.insertAdjacentHTML('beforeend', `<option value="${h}">${pad(h)}h</option>`);
  });
  const rerender = () => { renderResults(); };
  $('#hist-search')?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(rerender, 120); });
  ['#hist-hour-from', '#hist-hour-to', '#hist-only-price'].forEach((s) => $(s)?.addEventListener('change', rerender));
  $('#hist-clear')?.addEventListener('click', () => {
    $('#hist-search').value = '';
    $('#hist-hour-from').value = '';
    $('#hist-hour-to').value = '';
    $('#hist-only-price').checked = false;
    sel.day = ''; sel.session = '';
    renderSidebar(); renderResults();
  });
  $('#hist-export')?.addEventListener('click', exportCSV);
  $('#hist-days')?.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-hdel]');
    if (del) {
      if (confirm('Xoá phiên live này cùng toàn bộ bình luận đã lưu?')) {
        await deleteSession(del.dataset.hdel);
        if (sel.session === del.dataset.hdel) sel.session = '';
        await renderHistoryView();
      }
      return;
    }
    const b = e.target.closest('[data-hday]');
    if (!b) return;
    sel.day = b.dataset.hday;
    sel.session = b.dataset.hsess;
    renderSidebar(); renderResults();
  });
  $('#hist-results')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-huser]');
    if (!a) return;
    e.preventDefault();
    $('#hist-search').value = a.dataset.huser;
    renderResults();
    $('#hist-results').scrollTop = 0;
  });
}

export async function renderHistoryView() {
  wire();
  try { data = await loadAll(); } catch { data = { sessions: [], comments: [] }; }
  // phiên đang chạy chưa chắc đã có trong DB
  if (current && !data.sessions.some((s) => s.id === current.id)) data.sessions.push({ ...current });
  renderSidebar();
  renderResults();
}
