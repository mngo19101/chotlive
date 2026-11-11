/**
 * Dò vì sao Viettel Post trả "System error" khi tạo vận đơn.
 * Dùng token + điểm lấy hàng đã lưu ở máy chủ (data/vtp-connections.json), không in token ra.
 *
 * Mỗi lần thử tạo 1 đơn GỬI CHO CHÍNH SHOP (thu hộ 0đ, 200g). Tạo được là HUỶ NGAY rồi dừng.
 * Thử lần lượt: mã có dấu "+" + gói VSL9  →  mã không dấu "+" + VSL9  →  mã không dấu "+" + STK.
 *
 *   node scripts/vtp-create-debug.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://partner.viettelpost.vn';
const all = JSON.parse(fs.readFileSync(path.join(root, 'data', 'vtp-connections.json'), 'utf8'));
const conn = Object.values(all).find((c) => c.siteToken && c.sender);
if (!conn) {
  console.log('Chưa có tài khoản nào kết nối Viettel Post và chọn điểm lấy hàng.');
  process.exit(1);
}

async function call(method, p, token, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', Token: token },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, error: true, message: text.slice(0, 200) };
  }
}

// Đăng nhập lại để có token Partner còn hạn.
const lg = await call('POST', '/v2/user/LoginVTP', '', { token: conn.siteToken });
if (lg.error || !lg.data?.token) {
  console.log('Token không dùng được:', lg.message);
  process.exit(1);
}
const T = lg.data.token;
const s = conn.sender;
console.log(`Điểm lấy hàng: ${s.name} · ${s.address}\n`);

const stamp = Date.now().toString(36).toUpperCase();
const tries = [
  { label: 'Mã có dấu "+", gói VSL9', ref: `TEST${stamp}+A`, service: 'VSL9' },
  { label: 'Mã không có "+", gói VSL9', ref: `TEST${stamp}-B`, service: 'VSL9' },
  { label: 'Mã không có "+", gói STK', ref: `TEST${stamp}-C`, service: 'STK' }
];

for (const t of tries) {
  const product = { PRODUCT_NAME: 'Don thu API', PRODUCT_QUANTITY: 1, PRODUCT_PRICE: 10000, PRODUCT_WEIGHT: 200 };
  const body = {
    ORDER_NUMBER: t.ref,
    SENDER_FULLNAME: s.name,
    SENDER_ADDRESS: s.address,
    SENDER_PHONE: s.phone,
    RECEIVER_FULLNAME: s.name,
    RECEIVER_ADDRESS: s.address,
    RECEIVER_PHONE: s.phone,
    ...product,
    PRODUCT_LENGTH: 0,
    PRODUCT_WIDTH: 0,
    PRODUCT_HEIGHT: 0,
    PRODUCT_TYPE: 'HH',
    ORDER_PAYMENT: 1,
    ORDER_SERVICE: t.service,
    ORDER_SERVICE_ADD: null,
    ORDER_NOTE: 'DON THU API - HUY NGAY, KHONG LAY HANG',
    MONEY_COLLECTION: 0,
    EXTRA_MONEY: 0,
    CHECK_UNIQUE: true,
    PRODUCT_DETAIL: [product]
  };
  const r = await call('POST', '/v2/order/createOrderNlp', T, body);
  if (r.error || !r.data?.ORDER_NUMBER) {
    console.log(`✗ ${t.label}: ${r.status} ${r.message}`);
    continue;
  }
  const code = r.data.ORDER_NUMBER;
  console.log(`✓ ${t.label}: tạo được vận đơn ${code} (cước ${r.data.MONEY_TOTAL}đ)`);
  const c = await call('POST', '/v2/order/UpdateOrder', T, { TYPE: 4, ORDER_NUMBER: code, NOTE: 'Don thu API', DATE: '' });
  console.log(c.error ? `  ⚠ HUỶ KHÔNG ĐƯỢC: ${c.message}. Vào viettelpost.vn huỷ tay vận đơn ${code}.` : `  Đã huỷ vận đơn ${code}.`);
  break;
}
