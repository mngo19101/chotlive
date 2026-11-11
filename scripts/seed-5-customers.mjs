/**
 * Đổ bộ dữ liệu ẢO gọn: 5 khách có sẵn SĐT + địa chỉ (đúng danh mục Viettel Post), có đơn gom cũ và đơn hôm nay.
 * GHI ĐÈ toàn bộ đơn và khách của tài khoản.
 *
 *   node scripts/seed-5-customers.mjs <url> <tài khoản> <mật khẩu>
 */
import { VTP_PROVINCES, vtpWardsOf } from '../public/js/vtp-address.js';

const [base = 'http://localhost:3000', username = 'admin1', password = ''] = process.argv.slice(2);
if (!password) {
  console.error('Thiếu mật khẩu: node scripts/seed-5-customers.mjs <url> <tài khoản> <mật khẩu>');
  process.exit(1);
}

const DAY = 86400000;
const now = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const dm = (ts) => `${pad(new Date(ts).getDate())}/${pad(new Date(ts).getMonth() + 1)}`;
const ward = (provName, wardName) => {
  const p = VTP_PROVINCES.find(([, n]) => n === provName);
  if (!p || !vtpWardsOf(p[0]).includes(wardName)) throw new Error(`Không có ${wardName}, ${provName} trong danh mục`);
  return { province: provName, ward: wardName, district: '' };
};

const people = [
  { uid: 'lananh.test', name: 'Nguyễn Lan Anh', phone: '0912000101', street: '12 Trần Quang Khải', ...ward('TP.Hồ Chí Minh', 'Phường Tân Định') },
  { uid: 'minhthu.test', name: 'Trần Minh Thư', phone: '0987000202', street: 'Số 5 ngõ 10 Trần Thái Tông', ...ward('TP.Hà Nội', 'Phường Cầu Giấy') },
  { uid: 'hoangnam.test', name: 'Lê Hoàng Nam', phone: '0905000303', street: '20 Bạch Đằng', ...ward('TP.Đà Nẵng', 'Phường Hải Châu') },
  { uid: 'thaovy.test', name: 'Phạm Thảo Vy', phone: '0934000404', street: '88 Lê Lợi', ...ward('T.Thanh Hoá', 'Phường Hạc Thành') },
  // Địa chỉ cũ 3 cấp (tên Viettel Post)
  { uid: 'cobasg.test', name: 'Cô Ba Sài Gòn', phone: '0909000808', street: '25 Lê Lợi', province: 'TP.Hồ Chí Minh', district: 'Q.1', ward: 'P.Bến Nghé' }
];

let seq = 0;
function makeOrder(p, daysAgo, prices, ship) {
  const ts = now - daysAgo * DAY - (seq + 1) * 300000;
  const d = new Date(ts);
  seq += 1;
  const items = prices.map((price, k) => {
    const code = String(((seq * 7 + k * 5) % 60) + 1);
    return { id: `it_s5_${p.uid}_${daysAgo}_${k}`, name: `Mã ${code}`, code, price, qty: 1, comment: `chốt ${code}`, ts, timeStr: hm(ts) };
  });
  const address = [p.street, p.ward, p.district, p.province].filter(Boolean).join(', ');
  return {
    id: `o_s5_${p.uid}_${daysAgo}`,
    code: `HD${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(seq)}`,
    uniqueId: p.uid,
    userId: '',
    nickname: p.name,
    receiver: p.name,
    phone: p.phone,
    street: p.street,
    ward: p.ward,
    district: p.district || '',
    province: p.province,
    address,
    deliveryNote: '',
    status: daysAgo > 0 ? 'printed' : 'new',
    ts,
    timeStr: hm(ts),
    dateStr: dm(ts),
    createdDesc: `Tạo lúc ${hm(ts)} · ${dm(ts)}`,
    printCount: daysAgo > 0 ? 1 : 0,
    items,
    total: items.reduce((s, it) => s + it.price, 0),
    ...(ship ? { ship: { pay: 'cod', payer: 'receiver', weightG: 1000, ...ship } } : {})
  };
}

const [lan, thu, nam, vy, coba] = people;
const orders = [
  // Lan Anh: đơn gom 2 ngày trước 50k + hôm nay 40k -> duyệt ra 90k
  makeOrder(lan, 2, [50000], { state: 'hold' }),
  makeOrder(lan, 0, [40000]),
  // Minh Thư: 2 đơn gom (3 ngày, 1 ngày trước) + hôm nay
  makeOrder(thu, 3, [120000], { state: 'hold' }),
  makeOrder(thu, 1, [80000, 60000], { state: 'hold' }),
  makeOrder(thu, 0, [150000]),
  // Hoàng Nam: đã duyệt hôm qua chưa xuất + hôm nay chưa duyệt
  makeOrder(nam, 1, [200000], { state: 'ready' }),
  makeOrder(nam, 0, [90000]),
  // Thảo Vy: chỉ đơn hôm nay, đơn nhỏ 15k
  makeOrder(vy, 0, [15000]),
  // Cô Ba: đơn gom 4 ngày trước + hôm nay, địa chỉ cũ 3 cấp
  makeOrder(coba, 4, [120000], { state: 'hold' }),
  makeOrder(coba, 0, [200000, 99000])
].sort((a, b) => b.ts - a.ts);

const customers = people.map((p) => {
  const mine = orders.filter((o) => o.uniqueId === p.uid);
  const last = Math.max(...mine.map((o) => o.ts));
  return {
    id: `c_s5_${p.uid}`,
    uniqueId: p.uid,
    userId: '',
    name: p.name,
    phone: p.phone,
    street: p.street,
    ward: p.ward,
    district: p.district || '',
    province: p.province,
    address: [p.street, p.ward, p.district, p.province].filter(Boolean).join(', '),
    deliveryNote: '',
    totalSpent: mine.reduce((s, o) => s + o.total, 0),
    orderCount: mine.length,
    tag: 'Khách thử',
    lastBuy: dm(last),
    timeDesc: hm(last)
  };
});

async function post(path, body, token) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const login = await post('/api/auth/login', { username, password });
if (login.status !== 200) {
  console.error('Không đăng nhập được:', login.status, login.data);
  process.exit(1);
}
const sync = await post('/api/sync', { state: { orders, customers }, action: 'update', clientId: 'seed-5-customers' }, login.data.token);
if (sync.status !== 200) {
  console.error('Đổ dữ liệu lỗi:', sync.status, sync.data);
  process.exit(1);
}
for (const o of [...orders].reverse()) {
  console.log(`${o.code}  ${o.nickname.padEnd(15)} ${dm(o.ts)}  ${(o.ship?.state || 'mới').padEnd(5)}  ${o.total.toLocaleString('vi-VN')}đ`);
}
console.log(`\nĐã đổ ${orders.length} đơn của ${customers.length} khách vào "${username}".`);
