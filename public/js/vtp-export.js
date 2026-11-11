/**
 * Gom đơn chờ gửi theo khách và xuất file Excel đúng mẫu nhập đơn của Viettel Post
 * (VTP_mau_excel_don_hang_o.xlsx: tiêu đề cột ở dòng 7, dữ liệu từ dòng 8, 22 cột A–V).
 *
 * Mỗi đơn có thêm `ship`:
 *   state: 'ask'      chưa hỏi khách gửi luôn hay gom (mặc định cho đơn mới)
 *          'hold'     khách hẹn gom gửi sau
 *          'ready'    sẵn sàng gửi, sẽ nằm trong file xuất
 *          'exported' đã xuất file Viettel Post
 *   pay:   'cod'  khách trả ship, thu hộ tiền hàng
 *          'paid' khách đã chuyển khoản đủ, thu hộ 0đ, shop trả ship
 *   deposit: tiền khách đã cọc/đã chuyển, trừ vào tiền thu hộ
 *   payer: 'receiver' (mặc định) | 'sender' người trả cước; đơn dưới 17.000đ luôn xuất người gửi trả và cộng phí ship vào COD
 *   shipFee: phí ship cộng vào thu hộ khi shop ứng trước (mặc định 17.000đ)
 *   codOverride: nhập tay tiền thu hộ, đè lên mọi cách tính
 *   weightG: cân nặng cả kiện (gram), mặc định 1000
 *   lengthCm, widthCm, heightCm: kích thước kiện (cm), app điện thoại bắt buộc nhập khi nặng từ 10kg
 */
import { buildXlsx } from './xlsx-writer.js';
import { resolveVtpAddress } from './vtp-address-old.js';

export const DEFAULT_WEIGHT_G = 1000;
/** Đơn thu hộ dưới mức này thì shop trả ship và cộng đúng khoản này vào tiền thu hộ. */
export const SMALL_ORDER_LIMIT = 17000;
export const SMALL_ORDER_SHIP_FEE = 17000;
export const PENDING_STATES = ['ask', 'hold', 'ready'];

const lower = (s) => String(s ?? '').trim().toLowerCase();

/** Cùng cách nhận khách với máy chủ (native-sync.customerKey). */
export function shipKeyOf(rec) {
  const u = lower(rec?.uniqueId);
  if (u) return u;
  if (rec?.userId) return String(rec.userId);
  const nick = rec?.nickname || rec?.name;
  return nick ? `manual-${lower(nick)}` : '';
}

/** Trạng thái giao của một đơn; đơn cũ chưa có `ship` được suy ra từ trạng thái đơn. */
export function shipStateOf(o) {
  if (!o || o.status === 'cancelled') return 'none';
  // Đã chuyển Đang giao / Đã giao (kể cả từ app điện thoại) thì không còn chờ gửi nữa.
  if (o.status === 'shipping' || o.status === 'done') return o.ship?.state === 'exported' ? 'exported' : 'gone';
  return o.ship?.state || 'ask';
}

export const isPending = (o) => PENDING_STATES.includes(shipStateOf(o));

export function goodsTotal(o) {
  const sub = (o.items || []).reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
  return Math.max(0, sub - (Number(o.discount) || 0));
}

export function itemQty(o) {
  return (o.items || []).reduce((s, it) => s + (Number(it.qty) || 1), 0);
}

/** Các đơn chưa gửi của cùng khách, cũ nhất trước. */
export function pendingOrdersOfCustomer(orders, rec) {
  const key = shipKeyOf(rec);
  if (!key) return [];
  return (orders || [])
    .filter((o) => isPending(o) && shipKeyOf(o) === key)
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

/** Đơn chưa gửi khác của khách, cũ hơn đơn đang xem: để hiện nhãn "Còn N đơn cũ chưa gửi". */
export function olderPendingOf(orders, order) {
  return pendingOrdersOfCustomer(orders, order).filter(
    (o) => o.id !== order.id && (Number(o.ts) || 0) <= (Number(order.ts) || 0)
  );
}

/**
 * Nhóm theo khách các khách có đơn ở trạng thái `state`. Mỗi nhóm thành một vận đơn khi xuất.
 * `orders`: các đơn đang xem (ví dụ hôm nay); `allOrders`: đơn mọi ngày.
 * Với 'ready': gộp mọi đơn ĐÃ DUYỆT (ready) của khách ở mọi ngày thành một vận đơn. Đơn chưa duyệt / hẹn gom
 * KHÔNG tự kéo vào (bạn đã bỏ tick hoặc chưa duyệt thì phải giữ đúng lựa chọn), chỉ báo ở `otherPending`.
 */
export function groupByCustomer(orders, customers, state, allOrders = orders) {
  const groups = new Map();
  for (const o of orders || []) {
    if (shipStateOf(o) !== state) continue;
    const key = shipKeyOf(o);
    if (!key) continue;
    if (!groups.has(key)) {
      const cust = (customers || []).find((c) => shipKeyOf(c) === key) || null;
      groups.set(key, { key, customer: cust, orders: [] });
    }
    groups.get(key).orders.push(o);
  }
  for (const g of groups.values()) {
    if (state === 'ready') {
      const all = pendingOrdersOfCustomer(allOrders, g.orders[0]);
      const inScope = new Set(g.orders.map((o) => o.id));
      g.orders = all.filter((o) => shipStateOf(o) === 'ready');
      // Đơn đã duyệt của ngày trước được gộp thêm vào vận đơn này.
      g.addedPending = g.orders.filter((o) => !inScope.has(o.id));
      g.otherPending = all.filter((o) => shipStateOf(o) !== 'ready');
    } else {
      g.orders.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
      g.addedPending = [];
      g.otherPending = pendingOrdersOfCustomer(allOrders, g.orders[0]).filter((o) => shipStateOf(o) !== state);
    }
    g.recentExported = recentExportedOf(allOrders, g.key);
    Object.assign(g, summarizeGroup(g));
  }
  return [...groups.values()].sort((a, b) => (Number(a.orders[0].ts) || 0) - (Number(b.orders[0].ts) || 0));
}

/** Đơn của khách đã xuất Viettel Post trong 3 ngày qua mà chưa giao xong: dễ thành 2 vận đơn. */
export function recentExportedOf(orders, key, now = Date.now()) {
  return (orders || []).filter(
    (o) =>
      shipKeyOf(o) === key &&
      o.status === 'shipping' &&
      o.ship?.state === 'exported' &&
      now - (Number(o.ship?.exportedAt) || 0) < 3 * 86400000
  );
}

/** Giá trị cuối cùng khác rỗng của một trường ship, đơn mới nhất thắng. */
const lastShipField = (orders, key) => {
  for (let i = orders.length - 1; i >= 0; i--) {
    const v = orders[i].ship?.[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
const moneyOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));

/** Tiền, cân nặng, cách trả cước và địa chỉ của một vận đơn gộp. */
export function summarizeGroup({ orders, customer }) {
  // Đơn đã bank đủ hoặc chỉ còn thiếu ship thì không thu tiền hàng nữa.
  const goodsPaid = (o) => o.ship?.pay === 'paid' || o.ship?.pay === 'shipOnly'; // 'shipOnly': dữ liệu cũ, coi như đã bank
  const allPaid = orders.length > 0 && orders.every(goodsPaid);
  const goods = orders.reduce((s, o) => s + goodsTotal(o), 0);
  const unpaidRaw = orders.filter((o) => !goodsPaid(o)).reduce((s, o) => s + goodsTotal(o), 0);
  const deposit = Math.min(unpaidRaw, orders.reduce((s, o) => s + (moneyOrNull(o.ship?.deposit) || 0), 0));
  const unpaid = unpaidRaw - deposit;
  const fee = moneyOrNull(lastShipField(orders, 'shipFee')) ?? SMALL_ORDER_SHIP_FEE;
  const payerRaw = lastShipField(orders, 'payer');
  // Không chọn thì người nhận trả; riêng đơn đã bank đủ / chỉ thiếu ship (dữ liệu cũ) shop trả.
  const payer = payerRaw === 'sender' || payerRaw === 'receiver' ? payerRaw : allPaid ? 'sender' : 'receiver';
  const override = moneyOrNull(lastShipField(orders, 'codOverride'));

  // Đơn thu hộ dưới 17.000đ (kể cả đơn 0đ) mà shop trả cước: khách trả lại phí ship qua tiền thu hộ.
  const small = !allPaid && unpaid < SMALL_ORDER_LIMIT;
  // Đã bank đủ mà chọn người nhận trả ship: Viettel Post báo lỗi khi COD 0đ + người nhận trả,
  // nên xuất thành người gửi trả cước và thu hộ đúng phí ship (17.000đ) của khách.
  const bankShipByReceiver = allPaid && payer === 'receiver';
  // Đơn dưới 17.000đ: Viettel Post báo lỗi nếu người nhận trả cước, nên luôn xuất người gửi trả
  // và cộng phí ship vào thu hộ, kể cả khi bảng Duyệt đơn chọn người nhận trả.
  const senderPays = payer === 'sender' || bankShipByReceiver || small;
  const forcedSender = payer === 'receiver' && senderPays;
  const addFee = bankShipByReceiver || small;
  const autoCod = (allPaid ? 0 : unpaid) + (addFee ? fee : 0);
  const cod = override ?? autoCod;
  const shipFee = override === null && addFee ? fee : 0;
  const weightG = Math.max(...orders.map((o) => Number(o.ship?.weightG) || 0), 0) || DEFAULT_WEIGHT_G;
  const dims = ['lengthCm', 'widthCm', 'heightCm'].map((k) => moneyOrNull(lastShipField(orders, k)));
  const size = dims.every((v) => v > 0) ? dims : null;
  const src = customer || orders[orders.length - 1] || {};
  // Địa chỉ cũ (có quận/huyện) hay mới đều đổi về đúng tên trong danh mục Viettel Post.
  const address = resolveVtpAddress({
    province: src.province || '',
    district: src.district || '',
    ward: src.ward || '',
    street: src.street || ''
  });
  const phone = String(src.phone || '').replace(/[^\d+]/g, '');
  const problems = [];
  if (!/^(\+?84|0)\d{9,10}$/.test(phone)) problems.push('Thiếu số điện thoại');
  if (!address.ok) problems.push(address.reason);
  // Từ 10kg Viettel Post cần kích thước kiện; nhập ở bảng Duyệt đơn (web và app).
  if (weightG >= 10000 && !size) problems.push('Từ 10kg phải nhập kích thước');
  return {
    pay: allPaid ? 'paid' : 'cod',
    senderPays,
    forcedSender,
    shipFee,
    deposit,
    autoCod,
    codOverridden: override !== null,
    goods,
    cod,
    weightG,
    size,
    qty: orders.reduce((s, o) => s + itemQty(o), 0),
    receiver: cleanName(src.receiver || src.name || src.nickname || ''),
    phone,
    address,
    note: src.deliveryNote || '',
    problems
  };
}

/** Viettel Post không nhận emoji/ký tự lạ trong tên người nhận. */
export function cleanName(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const vtpAddressLine = ({ street, ward, district, province }) =>
  [street, ward, district, province].filter(Boolean).join(', ');

/** Tên hàng hoá ghi trên vận đơn: shop bán quần áo, không lấy tên/mã từ bình luận. */
export const DEFAULT_GOODS_NAME = 'Quần áo';

export const VTP_HEADERS = [
  'STT', 'Mã đơn hàng ', 'Tên người nhận (*)', 'Số ĐT người nhận (*)', 'Địa chỉ nhận (*)', 'Tên hàng hóa (*)',
  'Số lượng', 'Trọng lượng (gram)  (*)', 'Giá trị hàng (VND) (*)', 'Tiền thu hộ COD (VND)', 'Loại hàng hóa (*)',
  'Tính chất hàng hóa đặc biệt', 'Dịch vụ  (*)', 'Dịch vụ cộng thêm ', 'Thu tiền xem hàng', 'Dài (cm)', 'Rộng (cm)',
  'Cao (cm)', 'Người trả cước', 'Yêu cầu khác', 'Thời gian hẹn lấy', 'Thời gian giao'
];

/**
 * Gói dịch vụ. Mặc định "Flashsale thỏa thuận" (VSL9): thử trên trang Nhập excel ngày 09/11/2026,
 * 121/121 dòng (mọi tỉnh, địa chỉ cũ và mới) hợp lệ, phần lớn 16.800đ so với ~37–41 nghìn của STK.
 * Cột "Dịch vụ cộng thêm" luôn để trống: không SMS; Viettel Post chỉ tự cộng phí bắt buộc
 * (xăng dầu, COD, phụ phí kết nối, biển đảo).
 */
export const VTP_SERVICES = [
  ['VSL9', 'Flashsale thỏa thuận'],
  ['STK', 'Chuyển phát tiêu chuẩn'],
  ['SCN', 'Chuyển phát nhanh']
];
export const DEFAULT_VTP_SERVICE = 'VSL9';

/** Các dòng của trang tính, bố cục giống hệt file mẫu của Viettel Post. */
export function buildVtpRows(groups, { service = DEFAULT_VTP_SERVICE, goodsName = DEFAULT_GOODS_NAME } = {}) {
  const rows = [
    [],
    [null, null, null, 'TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI'],
    [null, null, null, 'TỔNG CÔNG TY CỔ PHẦN BƯU CHÍNH VIETTEL'],
    [],
    [null, null, null, null, null, 'DANH SÁCH ĐƠN HÀNG'],
    ['(*) là các trường bắt buộc nhập'],
    VTP_HEADERS
  ];
  groups.forEach((g, i) => {
    const codes = g.orders.map((o) => o.code).filter(Boolean).join('+');
    rows.push([
      i + 1,
      codes.length > 50 ? codes.slice(0, 50) : codes,
      g.receiver,
      g.phone,
      vtpAddressLine(g.address),
      goodsName || DEFAULT_GOODS_NAME,
      g.qty || 1,
      g.weightG,
      g.goods,
      g.cod,
      'Bưu kiện',
      null,
      service || DEFAULT_VTP_SERVICE,
      null, // Dịch vụ cộng thêm: để trống, không SMS
      null,
      g.size ? g.size[0] : null,
      g.size ? g.size[1] : null,
      g.size ? g.size[2] : null,
      g.senderPays ? 'Người gửi trả' : 'Người nhận trả',
      g.note ? String(g.note).slice(0, 150) : null,
      null,
      null
    ]);
  });
  return rows;
}

export function buildVtpXlsx(groups, opts) {
  return buildXlsx(buildVtpRows(groups, opts), {
    sheetName: 'Danh sách',
    colWidths: [6, 16, 22, 15, 48, 30, 9, 12, 14, 14, 12, 12, 14, 12, 10, 8, 8, 8, 16, 24, 16, 12]
  });
}

export function vtpFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `ViettelPost_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}.xlsx`;
}
