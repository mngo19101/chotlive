/**
 * Đổ đơn ẢO để thử cơ chế GOM/GỘP đơn: mỗi khách có 1 đơn gom cũ (ship.state = 'hold') + 1 đơn hôm nay chưa hỏi.
 * SĐT, địa chỉ, ghi chú giao của khách và của đơn để TRỐNG: bạn tự nhập trong app.
 * GHI ĐÈ toàn bộ đơn và khách của tài khoản.
 *
 *   node scripts/merge-test-data.mjs <url> <tài khoản> <mật khẩu>
 */
const [base = 'http://localhost:3000', username = 'admin1', password = ''] = process.argv.slice(2);
if (!password) {
  console.error('Thiếu mật khẩu: node scripts/merge-test-data.mjs <url> <tài khoản> <mật khẩu>');
  process.exit(1);
}

const DAY = 86400000;
const now = Date.now();
const people = [
  { uid: 'lananh.test', name: 'Nguyễn Lan Anh' },
  { uid: 'minhthu.test', name: 'Trần Minh Thư' },
  { uid: 'hoangnam.test', name: 'Lê Hoàng Nam' },
  { uid: 'thaovy.test', name: 'Phạm Thảo Vy' },
  { uid: 'ngoctram.test', name: 'Võ Ngọc Trâm' }
];

let seq = 0;
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const dm = (ts) => `${pad(new Date(ts).getDate())}/${pad(new Date(ts).getMonth() + 1)}`;
const code = (ts) => {
  const d = new Date(ts);
  seq += 1;
  return `HD${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(seq)}`;
};

function makeOrder(p, daysAgo, items, ship, status = 'printed') {
  const ts = now - daysAgo * DAY - seq * 60000;
  const its = items.map(([c, price, qty = 1], i) => ({
    id: `it_mt_${p.uid}_${daysAgo}_${i}`,
    name: `Mã ${c}`,
    code: String(c),
    price,
    qty,
    comment: `chốt ${c}`,
    ts,
    timeStr: hm(ts)
  }));
  return {
    id: `o_mt_${p.uid}_${daysAgo}`,
    code: code(ts),
    uniqueId: p.uid,
    userId: '',
    nickname: p.name,
    receiver: p.name,
    phone: '',
    street: '',
    ward: '',
    district: '',
    province: '',
    address: '',
    deliveryNote: '',
    status: ship || daysAgo > 0 ? status : 'new',
    ts,
    timeStr: hm(ts),
    dateStr: dm(ts),
    createdDesc: `Tạo lúc ${hm(ts)} · ${dm(ts)}`,
    printCount: status === 'new' ? 0 : 1,
    items: its,
    total: its.reduce((s, it) => s + it.price * it.qty, 0),
    ...(ship ? { ship } : {})
  };
}

const [lan, thu, nam, vy, tram] = people;
const orders = [
  // Đơn gom cũ (hold) + đơn hôm nay chưa hỏi -> cùng khách, thử gộp.
  makeOrder(lan, 4, [[24, 150000], [31, 90000]], { state: 'hold', pay: 'cod', weightG: 1000 }),
  makeOrder(lan, 0, [[12, 200000]], null, 'new'),
  makeOrder(thu, 3, [[8, 120000, 2]], { state: 'hold', pay: 'paid', weightG: 1000 }),
  makeOrder(thu, 0, [[15, 180000]], null, 'new'),
  makeOrder(nam, 5, [[40, 350000]], { state: 'hold', pay: 'cod', weightG: 1500 }),
  makeOrder(nam, 0, [[2, 80000], [7, 110000]], null, 'new'),
  makeOrder(vy, 2, [[14, 130000]], { state: 'hold', pay: 'paid', weightG: 1000 }),
  makeOrder(vy, 0, [[5, 99000], [6, 99000]], null, 'new'),
  // Chỉ có đơn hôm nay, không có đơn cũ: thử trường hợp không có gì để gộp.
  makeOrder(tram, 0, [[18, 250000]], null, 'new')
].sort((a, b) => b.ts - a.ts);

const customers = people.map((p) => {
  const mine = orders.filter((o) => o.uniqueId === p.uid);
  const last = Math.max(...mine.map((o) => o.ts));
  return {
    id: `c_mt_${p.uid}`,
    uniqueId: p.uid,
    userId: '',
    name: p.name,
    phone: '',
    street: '',
    ward: '',
    district: '',
    province: '',
    address: '',
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
const sync = await post('/api/sync', { state: { orders, customers }, action: 'update', clientId: 'merge-test-data' }, login.data.token);
if (sync.status !== 200) {
  console.error('Đổ dữ liệu lỗi:', sync.status, sync.data);
  process.exit(1);
}
console.log(`Đã đổ ${orders.length} đơn ảo của ${customers.length} khách vào "${username}" trên ${base}.`);
