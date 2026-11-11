/**
 * Đổ dữ liệu ẢO để thử tính năng Giao hàng / Xuất Excel Viettel Post.
 * Chỉ dùng với máy chủ thử (DATA_DIR riêng), không chạy vào tài khoản thật vì nó GHI ĐÈ toàn bộ đơn và khách.
 *
 *   node scripts/vtp-test-data.mjs http://localhost:4990 <tài khoản thử> <mật khẩu>
 *
 * Tài khoản chưa có thì tự đăng ký. Tên, số điện thoại, số nhà đều là bịa; phường/tỉnh lấy đúng danh mục Viettel Post.
 */
import { VTP_PROVINCES, vtpWardsOf } from '../public/js/vtp-address.js';

const [base = 'http://localhost:4990', username = 'shopthu', password = ''] = process.argv.slice(2);
if (!password) {
  console.error('Thiếu mật khẩu: node scripts/vtp-test-data.mjs <url> <tài khoản> <mật khẩu>');
  process.exit(1);
}

const DAY = 86400000;
const now = Date.now();
const prov = (name) => VTP_PROVINCES.find(([, n]) => n === name);
const ward = (provName, wardName) => {
  const p = prov(provName);
  if (!p || !vtpWardsOf(p[0]).includes(wardName)) throw new Error(`Không có ${wardName}, ${provName} trong danh mục`);
  return { province: provName, ward: wardName };
};

// Khách ảo. Hai khách cuối cố ý thiếu thông tin để thấy màn xuất chặn lại.
const people = [
  { uid: 'lananh.test', name: 'Nguyễn Lan Anh', phone: '0912000101', street: '12 Trần Quang Khải', ...ward('TP.Hồ Chí Minh', 'Phường Tân Định'), note: 'Gọi trước khi giao' },
  { uid: 'minhthu.test', name: 'Trần Minh Thư', phone: '0987000202', street: 'Số 5 ngõ 10 Trần Thái Tông', ...ward('TP.Hà Nội', 'Phường Cầu Giấy') },
  { uid: 'hoangnam.test', name: 'Lê Hoàng Nam', phone: '0905000303', street: '20 Bạch Đằng', ...ward('TP.Đà Nẵng', 'Phường Hải Châu') },
  { uid: 'thaovy.test', name: 'Phạm Thảo Vy', phone: '0934000404', street: '88 Lê Lợi', ...ward('T.Thanh Hoá', 'Phường Hạc Thành'), note: 'Giao giờ hành chính' },
  { uid: 'ngoctram.test', name: 'Võ Ngọc Trâm', phone: '0977000505', street: '45 Nguyễn Văn Cừ', ...ward('TP.Cần Thơ', 'Phường Ninh Kiều') },
  { uid: 'ducanh.test', name: 'Đỗ Đức Anh', phone: '0966000606', street: 'Thôn 3', ...ward('T.Nghệ An', 'Xã Diễn Châu') },
  { uid: 'kimchi.test', name: 'Bùi Kim Chi', phone: '', street: '7 Hai Bà Trưng', ...ward('TP.Hải Phòng', 'Phường Lê Chân') },
  // Địa chỉ cũ 3 cấp viết kiểu app điện thoại: xuất ra đúng tên cũ Viettel Post "P.Bến Nghé, Q.1, TP.Hồ Chí Minh".
  { uid: 'cobasg.test', name: 'Cô Ba Sài Gòn', phone: '0909000808', street: '25 Lê Lợi', province: 'TP. Hồ Chí Minh', district: 'Quận 1', ward: 'Phường Bến Nghé' },
  // Địa chỉ cũ chọn trong bảng chọn web (tên Viettel Post). Phường mới Hải Châu gộp 13 phường cũ: chọn phường cũ thì Viettel Post khỏi hỏi.
  { uid: 'haichau.test', name: 'Hồ Thu Hà', phone: '0935000909', street: '31 Lê Duẩn', province: 'TP.Đà Nẵng', district: 'Q.Hải Châu', ward: 'P.Hải Châu 1' },
  { uid: 'locha.test', name: 'Lý Văn Tâm', phone: '0945001010', street: 'Thôn Kim Đôi', province: 'T.Hà Tĩnh', district: 'H.Lộc Hà', ward: 'X.Thạch Kim', note: 'Gọi trước khi giao' }
];

let seq = 0;
const code = (ts) => {
  const d = new Date(ts);
  seq += 1;
  return `HD${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(seq).padStart(2, '0')}`;
};
const hm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const dm = (ts) => `${String(new Date(ts).getDate()).padStart(2, '0')}/${String(new Date(ts).getMonth() + 1).padStart(2, '0')}`;

function makeOrder(p, daysAgo, items, ship, status = 'new') {
  const ts = now - daysAgo * DAY - Math.floor(Math.random() * 3600000);
  const its = items.map(([c, price, qty = 1], i) => ({
    id: `it_test_${p.uid}_${daysAgo}_${i}`,
    name: `Mã ${c}`,
    code: String(c),
    price,
    qty,
    comment: `chốt ${c}`,
    ts,
    timeStr: hm(ts)
  }));
  const total = its.reduce((s, it) => s + it.price * it.qty, 0);
  return {
    id: `o_test_${p.uid}_${daysAgo}`,
    code: code(ts),
    uniqueId: p.uid,
    userId: '',
    nickname: p.name,
    receiver: p.name,
    phone: p.phone,
    street: p.street,
    ward: p.ward,
    district: p.district || '',
    province: p.province,
    address: [p.street, p.ward, p.district, p.province].filter(Boolean).join(', '),
    deliveryNote: p.note || '',
    status,
    ts,
    timeStr: hm(ts),
    dateStr: dm(ts),
    createdDesc: `Tạo lúc ${hm(ts)} · ${dm(ts)}`,
    printCount: status === 'new' ? 0 : 1,
    items: its,
    total,
    ...(ship ? { ship } : {})
  };
}

const [lan, thu, nam, vy, tram, ducanh, kimchi, coba, haichau, locha] = people;
const orders = [
  // Lan Anh: chốt 4 ngày trước, hẹn gom; hôm nay chốt thêm, chưa hỏi -> nhãn "Còn 1 đơn cũ".
  makeOrder(lan, 4, [[24, 150000], [31, 90000]], { state: 'hold', pay: 'cod', weightG: 1000 }, 'printed'),
  makeOrder(lan, 0, [[12, 200000]], null),
  // Minh Thư: 2 đơn cũ đã sẵn sàng gửi chung, đã bank đủ -> 1 vận đơn COD 0đ.
  makeOrder(thu, 3, [[8, 120000, 2]], { state: 'ready', pay: 'paid', weightG: 1000 }, 'printed'),
  makeOrder(thu, 1, [[15, 180000]], { state: 'ready', pay: 'paid', weightG: 1000 }, 'printed'),
  // Hoàng Nam: sẵn sàng gửi, khách trả ship, cân 1,5kg.
  makeOrder(nam, 1, [[40, 350000]], { state: 'ready', pay: 'cod', weightG: 1500 }, 'printed'),
  // Thảo Vy: đơn hôm nay sẵn sàng gửi...
  makeOrder(vy, 0, [[5, 99000], [6, 99000]], { state: 'ready', pay: 'cod', weightG: 1000 }, 'printed'),
  // ...và một đơn dồn 3 ngày trước đã bank: gộp chung 1 vận đơn, chỉ thu hộ đơn hôm nay.
  makeOrder(vy, 3, [[14, 130000]], { state: 'hold', pay: 'paid', weightG: 1000 }, 'printed'),
  // Ngọc Trâm: đơn hôm nay chưa hỏi.
  makeOrder(tram, 0, [[18, 250000]], null),
  // Đức Anh: hẹn gom 2 ngày trước.
  makeOrder(ducanh, 2, [[22, 160000]], { state: 'hold', pay: 'cod', weightG: 1000 }, 'printed'),
  // Kim Chi: sẵn sàng nhưng thiếu số điện thoại -> màn xuất báo đỏ.
  makeOrder(kimchi, 1, [[9, 140000]], { state: 'ready', pay: 'cod', weightG: 1000 }, 'printed'),
  // Cô Ba, Thu Hà, Văn Tâm: địa chỉ cũ 3 cấp, sẵn sàng gửi.
  makeOrder(coba, 2, [[3, 300000]], { state: 'ready', pay: 'cod', weightG: 1000 }, 'printed'),
  // Cô Ba đã có vận đơn xuất hôm qua: màn xuất nhắc để khỏi thành 2 lần ship.
  makeOrder(coba, 1, [[4, 120000]], { state: 'exported', pay: 'cod', weightG: 1000, exportedAt: now - DAY }, 'shipping'),
  makeOrder(haichau, 1, [[27, 210000]], { state: 'ready', pay: 'cod', weightG: 1000 }, 'printed'),
  makeOrder(locha, 0, [[11, 175000], [19, 95000]], { state: 'ready', pay: 'paid', weightG: 2000 }, 'printed'),
  // Một đơn đã gửi từ tuần trước để thấy không bị gộp nhầm.
  makeOrder(nam, 6, [[2, 80000]], { state: 'exported', pay: 'cod', weightG: 1000, exportedAt: now - 5 * DAY }, 'shipping')
].sort((a, b) => b.ts - a.ts);

const customers = people.map((p) => {
  const mine = orders.filter((o) => o.uniqueId === p.uid);
  return {
    id: `c_test_${p.uid}`,
    uniqueId: p.uid,
    userId: '',
    name: p.name,
    phone: p.phone,
    street: p.street,
    ward: p.ward,
    district: p.district || '',
    province: p.province,
    address: [p.street, p.ward, p.district, p.province].filter(Boolean).join(', '),
    deliveryNote: p.note || '',
    totalSpent: mine.reduce((s, o) => s + o.total, 0),
    orderCount: mine.length,
    tag: 'Khách thử',
    lastBuy: dm(Math.max(...mine.map((o) => o.ts))),
    timeDesc: hm(Math.max(...mine.map((o) => o.ts)))
  };
});

async function post(path, body, token) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

let res = await post('/api/auth/login', { username, password });
if (res.status !== 200) {
  res = await post('/api/auth/register', { username, password, confirmPassword: password });
  if (res.status >= 300) {
    console.error('Không đăng nhập / đăng ký được:', res.status, res.data);
    process.exit(1);
  }
  console.log(`Đã tạo tài khoản thử "${username}".`);
}
const token = res.data.token;
const sync = await post('/api/sync', { state: { orders, customers }, action: 'update', clientId: 'vtp-test-data' }, token);
if (sync.status !== 200) {
  console.error('Đổ dữ liệu lỗi:', sync.status, sync.data);
  process.exit(1);
}
console.log(`Đã đổ ${orders.length} đơn ảo của ${customers.length} khách vào "${username}" trên ${base}.`);
