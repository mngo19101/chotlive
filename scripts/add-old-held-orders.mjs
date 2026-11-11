/**
 * THÊM đơn cũ (ngày trước) cho khách ảo đang có để thử gom / gộp, KHÔNG xoá dữ liệu có sẵn.
 * Phần lớn là đơn hẹn gom (hold), vài đơn đã duyệt từ trước mà chưa xuất (ready).
 * Chạy lại sẽ thay đúng các đơn này (id bắt đầu bằng o_old2_), không nhân đôi.
 *
 *   node scripts/add-old-held-orders.mjs <url> <tài khoản> <mật khẩu>
 */
const [base = 'http://localhost:3000', username = 'admin1', password = ''] = process.argv.slice(2);
if (!password) {
  console.error('Thiếu mật khẩu: node scripts/add-old-held-orders.mjs <url> <tài khoản> <mật khẩu>');
  process.exit(1);
}

const DAY = 86400000;
const now = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const dm = (ts) => `${pad(new Date(ts).getDate())}/${pad(new Date(ts).getMonth() + 1)}`;

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
const keepOrders = (cur.orders || []).filter((o) => !String(o.id).startsWith('o_old2_'));
const customers = cur.customers || [];
// Khách ảo (tag "Khách thử"), bỏ khách thật nếu có
const fake = customers.filter((c) => c.tag === 'Khách thử').slice(0, 14);

// [số ngày trước, trạng thái, giá các món]
const plan = [
  [1, 'hold', [50000]],
  [2, 'hold', [90000, 120000]],
  [3, 'hold', [60000]],
  [1, 'ready', [80000]], // đã duyệt hôm qua, chưa xuất
  [4, 'hold', [150000]],
  [2, 'hold', [45000, 55000]],
  [5, 'hold', [70000]],
  [2, 'ready', [130000]], // đã duyệt 2 ngày trước, chưa xuất
  [1, 'hold', [15000]], // đơn nhỏ dưới 17k
  [3, 'hold', [200000]],
  [6, 'hold', [99000]],
  [1, 'ready', [110000]], // đã duyệt hôm qua, chưa xuất
  [2, 'hold', [65000, 65000]],
  [4, 'hold', [120000]]
];

let seq = 70;
const added = fake.map((c, i) => {
  const [daysAgo, st, prices] = plan[i % plan.length];
  const ts = now - daysAgo * DAY - (i + 1) * 420000;
  const d = new Date(ts);
  seq += 1;
  const items = prices.map((price, k) => {
    const code = String(1 + ((i * 13 + k * 7) % 60));
    return { id: `it_old2_${c.uniqueId}_${k}`, name: `Mã ${code}`, code, price, qty: 1, comment: `chốt ${code}`, ts, timeStr: hm(ts) };
  });
  return {
    id: `o_old2_${c.uniqueId}`,
    code: `HD${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(seq)}`,
    uniqueId: c.uniqueId,
    userId: '',
    nickname: c.name,
    receiver: c.name,
    phone: c.phone || '',
    street: c.street || '',
    ward: c.ward || '',
    district: c.district || '',
    province: c.province || '',
    address: c.address || '',
    deliveryNote: c.deliveryNote || '',
    status: 'printed',
    ts,
    timeStr: hm(ts),
    dateStr: dm(ts),
    createdDesc: `Tạo lúc ${hm(ts)} · ${dm(ts)}`,
    printCount: 1,
    items,
    total: items.reduce((s, it) => s + it.price, 0),
    ship: { state: st, pay: 'cod', payer: 'receiver', weightG: 1000 }
  };
});

const orders = [...added, ...keepOrders].sort((a, b) => b.ts - a.ts);
const sync = await post('/api/sync', { state: { orders, customers }, action: 'update', clientId: 'add-old-held-orders' }, login.data.token);
if (sync.status !== 200) {
  console.error('Đổ dữ liệu lỗi:', sync.status, sync.data);
  process.exit(1);
}
for (const o of added) console.log(`${o.code}  ${o.nickname.padEnd(18)} ${dm(o.ts)}  ${o.ship.state === 'hold' ? 'Gom sau ' : 'Đã duyệt'}  ${o.total.toLocaleString('vi-VN')}đ`);
console.log(`\nĐã thêm ${added.length} đơn cũ vào "${username}" (giữ nguyên ${keepOrders.length} đơn có sẵn).`);
