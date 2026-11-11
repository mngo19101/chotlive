/**
 * THÊM 20 khách ảo (mỗi khách có đơn hôm nay, một số có thêm đơn gom cũ) vào tài khoản, KHÔNG xoá dữ liệu có sẵn.
 * SĐT, địa chỉ để trống cho bạn tự nhập. Chạy lại sẽ thay đúng 20 khách này, không nhân đôi.
 *
 *   node scripts/add-fake-customers.mjs <url> <tài khoản> <mật khẩu>
 */
const [base = 'http://localhost:3000', username = 'admin1', password = ''] = process.argv.slice(2);
if (!password) {
  console.error('Thiếu mật khẩu: node scripts/add-fake-customers.mjs <url> <tài khoản> <mật khẩu>');
  process.exit(1);
}

const DAY = 86400000;
const now = Date.now();
const names = [
  'Nguyễn Thu Hằng', 'Trần Bảo Ngọc', 'Lê Quỳnh Anh', 'Phạm Khánh Linh', 'Hoàng Mai Phương',
  'Vũ Diệu Hiền', 'Đặng Thanh Tâm', 'Bùi Ngọc Hân', 'Đỗ Phương Thảo', 'Ngô Hà My',
  'Dương Tuyết Nhi', 'Lý Gia Hân', 'Trịnh Minh Châu', 'Đinh Thuỳ Dương', 'Mai Yến Nhi',
  'Phan Kim Ngân', 'Võ Cẩm Tú', 'Huỳnh Bích Trâm', 'Tô Hải Yến', 'Chu Lan Chi'
];
const slug = ['hang', 'ngoc', 'quynhanh', 'khanhlinh', 'maiphuong', 'dieuhien', 'thanhtam', 'ngochan', 'phuongthao', 'hamy',
  'tuyetnhi', 'giahan', 'minhchau', 'thuyduong', 'yennhi', 'kimngan', 'camtu', 'bichtram', 'haiyen', 'lanchi'];

const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const dm = (ts) => `${pad(new Date(ts).getDate())}/${pad(new Date(ts).getMonth() + 1)}`;
const price = (i, k) => (60 + ((i * 37 + k * 53) % 18) * 10) * 1000;

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
const cur = login.data.state || {};
const keepOrders = (cur.orders || []).filter((o) => !String(o.id).startsWith('o_x20_'));
const keepCustomers = (cur.customers || []).filter((c) => !String(c.id).startsWith('c_x20_'));

let seq = 50;
const code = (ts) => {
  const d = new Date(ts);
  seq += 1;
  return `HD${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(seq)}`;
};

function makeOrder(uid, name, daysAgo, i, hold) {
  const ts = now - daysAgo * DAY - i * 90000;
  const items = [0, 1].slice(0, 1 + ((i + daysAgo) % 2)).map((k) => {
    const c = 1 + ((i * 7 + k * 11 + daysAgo) % 60);
    return { id: `it_x20_${uid}_${daysAgo}_${k}`, name: `Mã ${c}`, code: String(c), price: price(i, k + daysAgo), qty: 1, comment: `chốt ${c}`, ts, timeStr: hm(ts) };
  });
  return {
    id: `o_x20_${uid}_${daysAgo}`,
    code: code(ts),
    uniqueId: uid,
    userId: '',
    nickname: name,
    receiver: name,
    phone: '',
    street: '',
    ward: '',
    district: '',
    province: '',
    address: '',
    deliveryNote: '',
    status: hold || daysAgo > 0 ? 'printed' : 'new',
    ts,
    timeStr: hm(ts),
    dateStr: dm(ts),
    createdDesc: `Tạo lúc ${hm(ts)} · ${dm(ts)}`,
    printCount: hold || daysAgo > 0 ? 1 : 0,
    items,
    total: items.reduce((s, it) => s + it.price * it.qty, 0),
    ...(hold ? { ship: { state: 'hold', pay: 'cod', weightG: 1000 } } : {})
  };
}

const newOrders = [];
const newCustomers = [];
names.forEach((name, i) => {
  const uid = `${slug[i]}.x20`;
  const mine = [makeOrder(uid, name, 0, i, false)];
  if (i % 5 < 2) mine.push(makeOrder(uid, name, 2 + (i % 3), i, true)); // 8 khách có đơn gom cũ
  newOrders.push(...mine);
  const last = Math.max(...mine.map((o) => o.ts));
  newCustomers.push({
    id: `c_x20_${uid}`, uniqueId: uid, userId: '', name, phone: '', street: '', ward: '', district: '', province: '', address: '',
    deliveryNote: '', totalSpent: mine.reduce((s, o) => s + o.total, 0), orderCount: mine.length, tag: 'Khách thử',
    lastBuy: dm(last), timeDesc: hm(last)
  });
});

const orders = [...newOrders, ...keepOrders].sort((a, b) => b.ts - a.ts);
const customers = [...newCustomers, ...keepCustomers];
const sync = await post('/api/sync', { state: { orders, customers }, action: 'update', clientId: 'add-fake-customers' }, login.data.token);
if (sync.status !== 200) {
  console.error('Đổ dữ liệu lỗi:', sync.status, sync.data);
  process.exit(1);
}
console.log(`Đã thêm ${newCustomers.length} khách và ${newOrders.length} đơn ảo vào "${username}" (giữ nguyên ${keepOrders.length} đơn, ${keepCustomers.length} khách cũ).`);
