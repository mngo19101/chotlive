/**
 * Kết nối Viettel Post bằng token shop tự tạo trên viettelpost.vn (Cấu hình tài khoản › Thêm mới token).
 * Trình duyệt không gọi thẳng được partner.viettelpost.vn, nên máy chủ giữ token và gọi thay.
 * Token chỉ nằm ở máy chủ (data/vtp-connections.json), không bao giờ gửi ngược về trình duyệt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VTP_BASE = process.env.VTP_BASE || 'https://partner.viettelpost.vn';

/** Trạng thái cuối hoặc cần shop xử lý, theo bảng mã trạng thái của Viettel Post. */
export const VTP_DELIVERED = [501];
export const VTP_CANCELLED = [101, 107, 201, 503];
export const VTP_RETURNED = [504];
export const VTP_ATTENTION = [502, 505, 506, 507, 515];

export const vtpStatusKind = (code) => {
  const n = Number(code) || 0;
  if (VTP_DELIVERED.includes(n)) return 'delivered';
  if (VTP_CANCELLED.includes(n)) return 'cancelled';
  if (VTP_RETURNED.includes(n)) return 'returned';
  if (VTP_ATTENTION.includes(n)) return 'attention';
  return n ? 'moving' : 'created';
};

export function createVtpStore(dataDir) {
  const file = path.join(dataDir, 'vtp-connections.json');
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {}
  const persist = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
    } catch (e) {
      console.warn('[vtp] Không ghi được file kết nối:', e.message);
    }
  };
  return {
    get: (userId) => all[userId] || null,
    set(userId, patch) {
      all[userId] = { ...(all[userId] || {}), ...patch };
      persist();
      return all[userId];
    },
    remove(userId) {
      delete all[userId];
      persist();
    },
    byHook(hookId) {
      for (const [userId, c] of Object.entries(all)) if (c.hookId && c.hookId === hookId) return { userId, conn: c };
      return null;
    }
  };
}

async function call(method, p, { token, body, timeoutMs = 20000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Token = token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(VTP_BASE + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { http: res.status, json, text: text.slice(0, 300) };
  } catch (e) {
    return { http: 0, json: null, text: e.name === 'AbortError' ? 'Viettel Post không phản hồi' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const ok = (r) => r.http === 200 && r.json && r.json.error === false;
const why = (r) => r.json?.message || (r.http ? `Viettel Post báo lỗi (HTTP ${r.http})` : r.text);
const looksExpired = (r) => r.http === 401 || /token/i.test(String(r.json?.message || ''));

export const maskPhone = (p) => {
  const s = String(p || '');
  return s.length > 5 ? `${s.slice(0, 3)}•••${s.slice(-3)}` : s;
};

/** Đổi token web thành token Partner. */
export async function vtpLogin(siteToken) {
  const r = await call('POST', '/v2/user/LoginVTP', { body: { token: siteToken } });
  if (!ok(r) || !r.json.data?.token) return { ok: false, error: why(r) };
  return { ok: true, token: r.json.data.token, phone: String(r.json.data.phone || ''), userId: r.json.data.userId ?? null };
}

/** Gọi API bằng token Partner đang lưu; hết hạn thì đăng nhập lại bằng token web một lần. */
export async function vtpCall(store, userId, method, p, body) {
  const conn = store.get(userId);
  if (!conn?.siteToken) return { http: 0, json: null, text: 'Chưa kết nối Viettel Post' };
  let r = await call(method, p, { token: conn.partnerToken, body });
  if (looksExpired(r) && !ok(r)) {
    const lg = await vtpLogin(conn.siteToken);
    if (!lg.ok) return { http: 401, json: { error: true, message: 'Token Viettel Post đã hết hạn hoặc bị xoá. Kết nối lại.' }, text: '' };
    store.set(userId, { partnerToken: lg.token });
    r = await call(method, p, { token: lg.token, body });
  }
  return r;
}

export async function vtpInventory(store, userId) {
  const r = await vtpCall(store, userId, 'GET', '/v2/user/listInventory');
  if (!ok(r) || !Array.isArray(r.json.data)) return { ok: false, error: why(r) };
  return {
    ok: true,
    list: r.json.data.map((k) => ({
      id: k.groupaddressId ?? k.GROUPADDRESS_ID ?? k.id,
      cusId: k.cusId ?? k.CUS_ID ?? null,
      name: k.name ?? k.NAME ?? '',
      phone: k.phone ?? k.PHONE ?? '',
      address: k.address ?? k.ADDRESS ?? '',
      provinceId: k.provinceId ?? k.PROVINCE_ID ?? null,
      districtId: k.districtId ?? k.DISTRICT_ID ?? null,
      wardsId: k.wardsId ?? k.WARDS_ID ?? null
    }))
  };
}

const clip = (s, n) => String(s ?? '').slice(0, n);
// Viettel Post giới hạn chuỗi theo BYTE (150), chữ có dấu tốn 2-3 byte: cắt theo byte, không cắt giữa ký tự.
export function clipBytes(s, maxBytes = 150) {
  const str = String(s ?? '');
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let out = '';
  for (const ch of str) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * Tạo một vận đơn. `g` do trình duyệt gom sẵn (cùng cách tính với file Excel):
 * { ref, receiver, phone, address, goodsName, qty, weightG, goods, cod, senderPays, note, size:[d,r,c]|null }
 */
export async function vtpCreateOrder(store, userId, g, service, wards = null) {
  const conn = store.get(userId);
  const s = conn?.sender;
  if (!s?.address) return { ok: false, error: 'Chưa chọn điểm lấy hàng (mở Kết nối Viettel Post)' };
  const product = {
    PRODUCT_NAME: clipBytes(g.goodsName || 'Quần áo', 150),
    PRODUCT_QUANTITY: Math.max(1, Number(g.qty) || 1),
    PRODUCT_PRICE: Math.max(0, Math.round(Number(g.goods) || 0)),
    PRODUCT_WEIGHT: Math.max(1, Math.round(Number(g.weightG) || 1000))
  };
  // Đúng mẫu createOrderNlp trong tài liệu partner2: địa chỉ dạng chữ, danh sách hàng là PRODUCT_DETAIL.
  // KHÔNG gửi ORDER_NUMBER (mã đơn riêng của shop): tài khoản shop thường gửi kèm là Viettel Post trả "System error",
  // bỏ đi thì tạo được. Mã đơn ChốtLive chỉ dùng trong log; ghi chú trên vận đơn là ghi chú giao hàng của khách (nếu có).
  const ref = clip(String(g.ref || '').replace(/[^A-Za-z0-9_+-]+/g, '-'), 50);
  const note = clipBytes(g.note || '', 150);
  const body = {
    SENDER_FULLNAME: clipBytes(s.name, 150),
    SENDER_ADDRESS: clipBytes(s.address, 150),
    SENDER_PHONE: clip(s.phone, 20),
    RECEIVER_FULLNAME: clipBytes(g.receiver, 150),
    RECEIVER_ADDRESS: clipBytes(g.address, 150),
    RECEIVER_PHONE: clip(g.phone, 20),
    ...product,
    PRODUCT_LENGTH: g.size ? Number(g.size[0]) || 0 : 0,
    PRODUCT_WIDTH: g.size ? Number(g.size[1]) || 0 : 0,
    PRODUCT_HEIGHT: g.size ? Number(g.size[2]) || 0 : 0,
    PRODUCT_TYPE: 'HH',
    // 1: không thu hộ; 2: thu hộ tiền hàng + cước (người nhận trả); 3: thu hộ tiền hàng; 4: chỉ thu hộ cước
    ORDER_PAYMENT: g.senderPays ? 3 : 2,
    ORDER_SERVICE: service || 'VSL9',
    ORDER_SERVICE_ADD: null,
    ORDER_NOTE: note,
    MONEY_COLLECTION: Math.max(0, Math.round(Number(g.cod) || 0)),
    EXTRA_MONEY: 0,
    PRODUCT_DETAIL: [product],
    ENABLE_SORT_CODE: true
  };
  // Thu hộ 0đ: shop trả cước thì "không thu hộ" (1), khách trả cước thì chỉ thu cước (4).
  if (!body.MONEY_COLLECTION) body.ORDER_PAYMENT = g.senderPays ? 1 : 4;
  const r = await vtpCall(store, userId, 'POST', '/v2/order/createOrderNlp', body);
  if (!ok(r) || !r.json.data?.ORDER_NUMBER) {
    // Ghi phản hồi của Viettel Post (không có token) để dò lỗi.
    console.warn(`[vtp] Tạo vận đơn ${ref} lỗi: HTTP ${r.http} ${r.json ? JSON.stringify(r.json).slice(0, 400) : r.text}`);
    return { ok: false, error: why(r) };
  }
  const d = r.json.data;
  const code = String(d.ORDER_NUMBER);
  const out = { ok: true, code, fee: Number(d.MONEY_TOTAL) || 0, sortCode: d.SORT_CODE || '' };
  // Viettel Post đọc địa chỉ bằng NLP rồi trả về mã phường họ hiểu: đối chiếu với phường/tỉnh app gửi.
  // Hiểu sai thì huỷ ngay vận đơn vừa tạo, báo lỗi để shop sửa địa chỉ, không để hàng đi nhầm nơi.
  if (wards) {
    await wards.get().catch(() => null);
    const chk = checkParsedAddress(wards, d, g);
    if (chk.checked) out.parsed = chk.parsed;
    // Không tra được mã phường: ghi lại phần Viettel Post trả về (không có token) để dò tên trường.
    else console.log(`[vtp] Không đối chiếu được địa chỉ vận đơn ${code}: ${JSON.stringify(d).slice(0, 500)}`);
    if (chk.checked && !chk.ok) {
      const c = await vtpCancel(store, userId, code, 'Viettel Post hiểu địa chỉ khác với địa chỉ shop nhập');
      console.warn(`[vtp] Vận đơn ${code} (${ref}): Viettel Post hiểu "${chk.parsed}", app gửi "${chk.expected}" → ${c.ok ? 'đã huỷ' : 'KHÔNG huỷ được: ' + c.error}`);
      return {
        ok: false,
        code,
        cancelled: c.ok,
        error: `Viettel Post hiểu địa chỉ là "${chk.parsed}", khác với "${chk.expected}" trong app. ${
          c.ok ? `Đã huỷ vận đơn ${code}.` : `Chưa huỷ được vận đơn ${code}, huỷ trên viettelpost.vn.`
        } Kiểm tra lại địa chỉ rồi gửi lại.`
      };
    }
  }
  return out;
}

/**
 * Cước dự tính và địa chỉ Viettel Post hiểu cho một nháp, KHÔNG tạo đơn:
 * getPriceNlp cho cước gói đang chọn, getPriceAllNlp cho mã phường họ đọc ra từ dòng địa chỉ.
 * Trả { ok, fee, parsed, addrOk, error }; addrOk=false khi phường/tỉnh họ hiểu khác app.
 */
export async function vtpQuote(store, userId, g, service, wards = null) {
  const conn = store.get(userId);
  const s = conn?.sender;
  if (!s?.address) return { ok: false, error: 'Chưa chọn điểm lấy hàng' };
  const cod = Math.max(0, Math.round(Number(g.cod) || 0));
  const base = {
    SENDER_ADDRESS: clipBytes(s.address, 150),
    RECEIVER_ADDRESS: clipBytes(g.address, 150),
    PRODUCT_TYPE: 'HH',
    PRODUCT_WEIGHT: Math.max(1, Math.round(Number(g.weightG) || 1000)),
    PRODUCT_PRICE: Math.max(0, Math.round(Number(g.goods) || 0)),
    MONEY_COLLECTION: cod,
    PRODUCT_LENGTH: g.size ? Number(g.size[0]) || 0 : 0,
    PRODUCT_WIDTH: g.size ? Number(g.size[1]) || 0 : 0,
    PRODUCT_HEIGHT: g.size ? Number(g.size[2]) || 0 : 0
  };
  const [price, all] = await Promise.all([
    vtpCall(store, userId, 'POST', '/v2/order/getPriceNlp', { ...base, NATIONAL_TYPE: 1, ORDER_SERVICE: service || 'VSL9', ORDER_SERVICE_ADD: '' }),
    vtpCall(store, userId, 'POST', '/v2/order/getPriceAllNlp', { ...base, TYPE: 1 })
  ]);
  const out = { ok: ok(price), fee: ok(price) ? Number(price.json.data?.MONEY_TOTAL) || 0 : 0 };
  if (!out.ok) out.error = why(price);
  const ra = all.json?.RECEIVER_ADDRESS ?? all.json?.data?.RECEIVER_ADDRESS;
  if (wards && ra?.WARD_ID != null) {
    await wards.get().catch(() => null);
    const chk = checkParsedAddress(wards, { RECEIVER_WARDS: ra.WARD_ID }, g);
    if (chk.checked) {
      out.parsed = chk.parsed;
      out.addrOk = chk.ok;
      if (!chk.ok) out.expected = chk.expected;
    }
  }
  return out;
}

/** Khoá so địa danh: bỏ dấu, chữ thường; dropPrefix bỏ "TP./Thành phố/Tỉnh/T." để "TP.Huế" = "Thành phố Huế". */
export function placeKey(s, dropPrefix = false) {
  let k = String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (dropPrefix) k = k.replace(/^(thanh pho|tinh|tp|t)\s+/, '');
  return k;
}

/**
 * Địa chỉ app định gửi tới: web gửi expect { province, ward } (tên mới theo danh mục Viettel Post);
 * app iOS chỉ gửi dòng địa chỉ "số nhà, phường, tỉnh" (mới) hoặc "số nhà, phường, quận, tỉnh" (cũ).
 */
export function expectedPlace(g) {
  const ex = g?.expect || {};
  const parts = String(g?.address || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    province: String(ex.province || (parts.length >= 2 ? parts[parts.length - 1] : '')),
    ward: String(ex.ward || (parts.length === 3 ? parts[1] : '')),
    oldWard: parts.length >= 4 ? parts[parts.length - 3] : ''
  };
}

/** So mã phường Viettel Post trả về khi tạo đơn với địa chỉ app gửi. Không tra được thì checked=false. */
export function checkParsedAddress(wards, data, g) {
  // Tài liệu ghi RECEIVER_WARD nhưng máy chủ Viettel Post trả RECEIVER_WARDS (thử ngày 10/11/2026).
  const hit = wards?.lookup?.(data?.RECEIVER_WARDS ?? data?.RECEIVER_WARD);
  if (!hit) return { checked: false };
  const want = expectedPlace(g);
  const same = (a, b, drop) => placeKey(a, drop) === placeKey(b, drop);
  const provOk = !want.province || same(hit.province, want.province, true);
  // Không có expect mà dòng địa chỉ từ 4 phần trở lên thì không biết phần nào là phường: số nhà có
  // dấu phẩy ("12 Lê Lợi, Tổ 5, Phường B, Tỉnh C") cũng ra 4 phần như địa chỉ cũ có quận. Khi đó
  // phường Viettel Post hiểu (tên mới hoặc tên cũ) chỉ cần trùng một phần nằm giữa số nhà và tỉnh.
  const middle = g?.expect?.ward ? [] : String(g?.address || '').split(',').map((s) => s.trim()).filter(Boolean).slice(1, -1);
  let wardOk = true;
  if (want.ward) wardOk = same(hit.ward, want.ward);
  else if (middle.length >= 2) {
    wardOk = middle.some((p) => same(hit.ward, p) || (hit.oldWard && same(hit.oldWard, p))) || !hit.oldWard;
  }
  return {
    checked: true,
    ok: provOk && wardOk,
    parsed: [hit.ward, hit.province].filter(Boolean).join(', '),
    expected: [want.ward || (wardOk ? want.oldWard : middle.join(', ')), want.province].filter(Boolean).join(', ')
  };
}

const VTP_WARDS_URL = 'https://api.viettelpost.vn/api/setting/listallwards';

/**
 * Danh mục phường/xã của Viettel Post (mã phường cũ và mới → phường/tỉnh mới), tải công khai,
 * lưu data/vtp-wards.json và làm mới mỗi 30 ngày. Dùng để kiểm tra địa chỉ Viettel Post hiểu khi tạo đơn.
 */
export function createVtpWardCatalog(dataDir, { url = process.env.VTP_WARDS_URL || VTP_WARDS_URL, maxAgeMs = 30 * 86400000 } = {}) {
  const file = path.join(dataDir, 'vtp-wards.json');
  let cache = null;
  let loading = null;
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const fresh = () => !!cache?.wards && Date.now() - (Number(cache.at) || 0) < maxAgeMs;
  async function refresh() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      const list = await res.json();
      if (!Array.isArray(list) || list.length < 1000) throw new Error('danh mục trả về rỗng');
      const wards = {};
      for (const w of list) {
        const v = [Number(w.PROVINCE_ID_NEW) || 0, String(w.PROVINCE_NAME_NEW || ''), String(w.WARDS_NAME_NEW || ''), String(w.WARDS_NAME || '')];
        if (w.WARDS_ID != null) wards[w.WARDS_ID] = v;
        // Mã phường mới (từ 49163) không trùng mã cũ; không có tên phường cũ.
        if (w.WARDS_ID_NEW != null && !wards[w.WARDS_ID_NEW]) wards[w.WARDS_ID_NEW] = [v[0], v[1], v[2], ''];
      }
      cache = { at: Date.now(), wards };
      try {
        fs.writeFileSync(file, JSON.stringify(cache));
      } catch {}
      console.log(`[vtp] Đã tải danh mục phường/xã Viettel Post (${list.length} phường cũ)`);
    } catch (e) {
      console.warn('[vtp] Không tải được danh mục phường/xã Viettel Post:', e.message);
    } finally {
      clearTimeout(timer);
      loading = null;
    }
  }
  return {
    async get() {
      if (!fresh()) {
        if (!loading) loading = refresh();
        await loading;
      }
      return cache?.wards || null;
    },
    lookup(wardId) {
      const w = cache?.wards?.[String(wardId ?? '')];
      return w ? { provinceId: w[0], province: w[1], ward: w[2], oldWard: w[3] } : null;
    },
    warm() {
      if (!fresh() && !loading) loading = refresh();
    }
  };
}

/** Mã in tem cho nhiều vận đơn; trả về các link in theo khổ giấy. */
export async function vtpPrintLinks(store, userId, codes) {
  const body = { EXPIRY_TIME: Date.now() + 24 * 3600 * 1000, ORDER_ARRAY: codes.map(String) };
  let r = await vtpCall(store, userId, 'POST', '/v2/order/printing-code', body);
  // Vận đơn vừa tạo vài giây thì Viettel Post trả lỗi cụt lủn "order": đợi rồi thử lại một lần.
  if (!ok(r) && /^order$/i.test(String(r.json?.message || ''))) {
    await new Promise((res) => setTimeout(res, 4000));
    r = await vtpCall(store, userId, 'POST', '/v2/order/printing-code', body);
  }
  if (!ok(r) || !r.json.message) {
    const msg = /^order$/i.test(String(r.json?.message || '')) ? 'Viettel Post chưa cho lấy link in tem qua API với tài khoản này (báo "order"). Tạm thời in tem trên viettelpost.vn › Quản lý đơn hàng.' : why(r);
    return { ok: false, error: msg };
  }
  const bill = encodeURIComponent(r.json.message);
  const u = (type) => `https://digitalize.viettelpost.vn/DigitalizePrint/report.do?type=${type}&bill=${bill}&showPostage=1`;
  return { ok: true, links: { a5: u(1), a6: u('a6_1'), k100: u(100) } };
}

/** Huỷ vận đơn (chỉ được khi bưu tá chưa lấy hàng). */
export async function vtpCancel(store, userId, code, note = 'Shop huỷ đơn') {
  const body = { TYPE: 4, ORDER_NUMBER: String(code), NOTE: clipBytes(note, 150) };
  let r = await vtpCall(store, userId, 'POST', '/v2/order/UpdateOrder', body);
  // Vừa tạo xong huỷ ngay thì Viettel Post có lúc chưa thấy đơn ("không tồn tại"): đợi vài giây thử lại một lần.
  if (!ok(r) && /không tồn tại|not exist/i.test(String(r.json?.message || ''))) {
    await new Promise((res) => setTimeout(res, 4000));
    r = await vtpCall(store, userId, 'POST', '/v2/order/UpdateOrder', body);
  }
  if (ok(r)) return { ok: true };
  console.warn(`[vtp] Huỷ vận đơn ${code} lỗi: HTTP ${r.http} ${r.json ? JSON.stringify(r.json).slice(0, 400) : r.text}`);
  // Viettel Post trả lỗi "Đơn hàng đã hủy!" khi vận đơn đã huỷ từ trước (vd. huỷ trên web Viettel Post lúc
  // chưa nối webhook): coi như huỷ xong để đơn trong app không kẹt ở Đang giao.
  if (VTP_ALREADY_CANCELLED.test(String(r.json?.message || ''))) return { ok: true, already: true };
  return { ok: false, error: why(r) };
}

export const VTP_ALREADY_CANCELLED = /^\s*(đơn hàng\s+)?(đã|da)\s+(hủy|huỷ|huy)\s*!?\s*$|already\s+cancel/i;

/** Phát tiếp (3) hoặc duyệt hoàn (2) đơn đang tồn. */
export async function vtpResolve(store, userId, code, type, note = '') {
  const r = await vtpCall(store, userId, 'POST', '/v2/order/UpdateOrder', {
    TYPE: Number(type),
    ORDER_NUMBER: String(code),
    NOTE: clipBytes(note, 150)
  });
  return ok(r) ? { ok: true } : { ok: false, error: why(r) };
}

export const newHookId = () => crypto.randomBytes(18).toString('base64url');

/** Đọc một bản tin webhook (chấp nhận cả `DATA` lồng nhau hoặc phẳng). */
export function parseVtpWebhook(body) {
  const d = body?.DATA && typeof body.DATA === 'object' ? body.DATA : body || {};
  const code = String(d.ORDER_NUMBER || '').trim();
  if (!code) return null;
  return {
    code,
    ref: String(d.ORDER_REFERENCE || '').trim(),
    status: Number(d.ORDER_STATUS) || 0,
    statusName: String(d.STATUS_NAME || '').trim(),
    at: String(d.ORDER_STATUSDATE || '').trim(),
    location: String(d.LOCATION_CURRENTLY || '').trim(),
    note: String(d.NOTE || '').trim(),
    employee: [d.EMPLOYEE_NAME, d.EMPLOYEE_PHONE].filter(Boolean).join(' · '),
    fee: Number(d.MONEY_TOTAL) || 0,
    secret: String(body?.TOKEN || '')
  };
}

/** Ghi trạng thái webhook vào các đơn của vận đơn; trả về số đơn đã cập nhật. */
// Trạng thái cuối: Viettel Post không gửi thêm gì nữa; bản tin đến sau thì bỏ qua.
export const VTP_FINAL = new Set([101, 107, 201, 501, 503, 504]);

/** "22/01/2026 09:36:53" (giờ Việt Nam) -> mili giây; không đọc được thì 0. */
export function vtpEventTime(at) {
  const m = String(at || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return 0;
  const t = Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0) - 7, +(m[5] || 0), +(m[6] || 0));
  return Number.isFinite(t) ? t : 0;
}

/** Các trường vận đơn trong order.ship chỉ máy chủ ghi (tạo đơn, huỷ, webhook). */
const VTP_SHIP_FIELDS = ['vtpCode', 'vtpOldCode', 'vtpFee', 'vtpService', 'vtpStatus', 'vtpStatusName', 'vtpStatusAt', 'vtpEventAt', 'vtpKind', 'vtpNote', 'vtpError', 'vtpErrorAt'];

/**
 * Web gửi lên cả danh sách đơn, có thể là bản chụp từ trước khi máy chủ ghi mã vận đơn hoặc trạng thái
 * Viettel Post mới. Giữ các trường vận đơn theo bản của máy chủ; nếu web chưa thấy lần ghi mới nhất thì
 * giữ luôn trạng thái đơn và trạng thái gửi đi kèm, để vận đơn vừa tạo/huỷ/giao xong không bị lùi lại.
 */
export function keepServerVtp(current, incoming) {
  const byId = new Map();
  for (const o of current || []) {
    if (o?.id != null && o.ship && VTP_SHIP_FIELDS.some((k) => o.ship[k] != null && o.ship[k] !== '')) byId.set(String(o.id), o);
  }
  if (!byId.size) return incoming;
  return incoming.map((o) => {
    const cur = o && byId.get(String(o.id));
    if (!cur) return o;
    const ship = { ...(o.ship || {}) };
    const seen = ['vtpCode', 'vtpStatus', 'vtpStatusAt'].every((k) => (ship[k] ?? null) === (cur.ship[k] ?? null));
    for (const k of VTP_SHIP_FIELDS) {
      if (cur.ship[k] === undefined) delete ship[k];
      else ship[k] = cur.ship[k];
    }
    if (seen) return { ...o, ship };
    for (const k of ['state', 'exportedAt', 'batchId']) {
      if (cur.ship[k] === undefined) delete ship[k];
      else ship[k] = cur.ship[k];
    }
    return { ...o, ship, status: cur.status };
  });
}

export function applyVtpStatus(state, ev) {
  let n = 0;
  const evAt = vtpEventTime(ev.at);
  for (const o of state.orders || []) {
    if (o.ship?.vtpCode !== ev.code) continue;
    // Đơn đã ở trạng thái cuối, hoặc bản tin cũ hơn bản đã ghi (đến lệch thứ tự): bỏ qua.
    if (VTP_FINAL.has(Number(o.ship.vtpStatus))) continue;
    if (evAt && Number(o.ship.vtpEventAt) > evAt) continue;
    const kind = vtpStatusKind(ev.status);
    if (kind === 'cancelled') {
      // Vận đơn bị huỷ: đơn quay về Chờ gửi để tạo lại, giữ mã cũ để tra.
      const { vtpCode, ...rest } = o.ship;
      o.ship = { ...rest, state: 'ready', vtpOldCode: vtpCode, vtpKind: 'cancelled', vtpStatus: ev.status,
        vtpStatusName: ev.statusName || 'Đã huỷ', vtpStatusAt: Date.now(), exportedAt: null, batchId: null };
      o.status = Number(o.printCount) > 0 ? 'printed' : 'new';
      n += 1;
      continue;
    }
    o.ship = {
      ...o.ship,
      vtpStatus: ev.status,
      vtpStatusName: ev.statusName || o.ship.vtpStatusName || '',
      vtpStatusAt: Date.now(),
      vtpEventAt: evAt || o.ship.vtpEventAt || 0,
      vtpNote: [ev.note, ev.location].filter(Boolean).join(' · ').slice(0, 200),
      vtpKind: kind
    };
    if (ev.fee) o.ship.vtpFee = ev.fee;
    if (kind === 'delivered') o.status = 'done';
    else if (o.status !== 'done') o.status = 'shipping';
    n += 1;
  }
  return n;
}
