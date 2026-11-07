import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSales } from '../public/js/sales.js';

// Giữa tháng, giờ địa phương, để dễ tính cùng kỳ tháng trước.
const NOW = new Date(2026, 10, 7, 15, 0, 0).getTime();
const at = (month, day, hour = 10) => new Date(2026, month, day, hour).getTime();
const order = (over) => ({
  id: over.id || 'o',
  uniqueId: 'khach',
  status: 'new',
  ts: over.ts,
  total: over.total ?? 100000,
  items: [{ id: 'i', price: over.total ?? 100000, qty: 1, ts: over.ts }],
  ...over
});

test('doanh thu hôm nay không tính đơn của ngày khác', () => {
  const s = computeSales(
    [order({ ts: at(10, 7), total: 200000 }), order({ ts: at(8, 8), total: 1000000 }), order({ ts: at(10, 6), total: 50000 })],
    { now: NOW }
  );
  assert.equal(s.todayRevenue, 200000);
  assert.equal(s.yesterdayRevenue, 50000);
  assert.equal(s.monthRevenue, 250000);
  assert.equal(s.todayOrderCount, 1);
});

test('đơn kéo dài qua hai ngày: mỗi món tính vào đúng ngày chốt món đó', () => {
  const o = {
    id: 'o1',
    uniqueId: 'khach',
    status: 'printed',
    ts: at(10, 7),
    total: 300000,
    items: [
      { id: 'a', price: 100000, qty: 1, ts: at(10, 6) },
      { id: 'b', price: 100000, qty: 2, ts: at(10, 7) }
    ]
  };
  const s = computeSales([o], { now: NOW });
  assert.equal(s.yesterdayRevenue, 100000);
  assert.equal(s.todayRevenue, 200000);
});

test('phí ship và giảm giá được tính vào doanh thu ngày của đơn', () => {
  const s = computeSales(
    [{ id: 'o', uniqueId: 'k', status: 'new', ts: at(10, 7), total: 120000, shippingFee: 30000, discount: 10000, items: [{ id: 'i', price: 100000, qty: 1, ts: at(10, 7) }] }],
    { now: NOW }
  );
  assert.equal(s.todayRevenue, 120000);
});

test('đơn đã huỷ không tính doanh thu, khách hay trạng thái', () => {
  const s = computeSales([order({ ts: at(10, 7), status: 'cancelled' })], { now: NOW });
  assert.equal(s.todayRevenue, 0);
  assert.equal(s.todayGuests, 0);
  assert.equal(s.todayOrderCount, 0);
});

test('tăng trưởng: không có số liệu kỳ trước thì không đoán', () => {
  const none = computeSales([order({ ts: at(10, 7) })], { now: NOW });
  assert.equal(none.todayGrowthPct, null);
  assert.equal(none.monthGrowthPct, null);

  const s = computeSales(
    [order({ id: 'a', ts: at(10, 7), total: 150000 }), order({ id: 'b', ts: at(10, 6), total: 100000 })],
    { now: NOW }
  );
  assert.equal(s.todayGrowthPct, 50);
});

test('so tháng với đúng số ngày tương ứng của tháng trước', () => {
  const s = computeSales(
    [
      order({ id: 'cungky', ts: at(9, 7), total: 100000 }),
      order({ id: 'saucungky', ts: at(9, 20), total: 900000 }),
      order({ id: 'nay', ts: at(10, 5), total: 200000 })
    ],
    { now: NOW }
  );
  assert.equal(s.prevMonthRevenue, 100000);
  assert.equal(s.monthGrowthPct, 100);
  assert.equal(s.monthNumber, 11);
  assert.equal(s.prevMonthNumber, 10);
});

test('tháng trước ngắn hơn: 31/3 so với hết tháng 2, tháng 1 so với tháng 12 năm trước', () => {
  const march = computeSales([order({ ts: new Date(2026, 1, 28, 10).getTime() })], { now: new Date(2026, 2, 31, 10).getTime() });
  assert.equal(march.prevMonthRevenue, 100000);
  const jan = computeSales([], { now: new Date(2026, 0, 15).getTime() });
  assert.equal(jan.prevMonthNumber, 12);
});

test('khách hôm nay và khách mới', () => {
  const s = computeSales(
    [
      order({ id: 'cu1', uniqueId: 'khachcu', ts: at(9, 1) }),
      order({ id: 'cu2', uniqueId: 'KhachCu', ts: at(10, 7) }),
      order({ id: 'moi', uniqueId: 'khachmoi', ts: at(10, 7) })
    ],
    { now: NOW }
  );
  assert.equal(s.todayGuests, 2);
  assert.equal(s.newGuests, 1);
});

test('trạng thái đơn và giá trị trung bình chỉ tính đơn hôm nay', () => {
  const s = computeSales(
    [
      order({ id: 'a', ts: at(10, 7), status: 'new', total: 100000 }),
      order({ id: 'b', ts: at(10, 7), status: 'done', total: 300000 }),
      order({ id: 'c', ts: at(8, 1), status: 'shipping', total: 999000 })
    ],
    { now: NOW }
  );
  assert.deepEqual(s.statusCounts, { new: 1, printed: 0, shipping: 0, done: 1 });
  assert.equal(s.averageOrderValue, 200000);
});

test('tỉ lệ chốt lấy theo bình luận có giá của phiên hôm nay; chưa có phiên thì để trống', () => {
  const o = order({ ts: at(10, 7), items: [{ id: 'i', commentId: 'c1', price: 100000, qty: 1, ts: at(10, 7) }] });
  assert.equal(computeSales([o], { now: NOW }).closeRatePct, null);
  assert.equal(computeSales([o], { now: NOW, sessions: [{ startTs: at(10, 7), priceCount: 4 }] }).closeRatePct, 25);
  assert.equal(computeSales([o], { now: NOW, sessions: [{ startTs: at(10, 6), priceCount: 4 }] }).closeRatePct, null);
});

test('biểu đồ: 7 ngày thật tới hôm nay, 30 ngày chia 5 cột đủ tiền', () => {
  const s = computeSales(
    [order({ id: 'nay', ts: at(10, 7), total: 100000 }), order({ id: 'tuantruoc', ts: at(10, 1), total: 70000 }), order({ id: 'cu', ts: at(9, 9), total: 40000 })],
    { now: NOW }
  );
  assert.equal(s.days.length, 7);
  assert.equal(s.days[6].label, 'T7', '7/11/2026 là thứ Bảy');
  assert.equal(s.days[6].amount, 100000);
  assert.equal(s.days[6].isCurrent, true);
  assert.equal(s.days[0].label, 'CN');
  assert.equal(s.days[0].amount, 70000, '1/11 nằm trong 7 ngày gần nhất');

  assert.equal(s.periods.length, 5);
  assert.equal(s.periods.reduce((sum, p) => sum + p.amount, 0), 210000);
  assert.equal(s.periods[4].isCurrent, true);
  assert.equal(s.periods[4].amount, 100000);
});

test('dữ liệu thiếu hay sai không làm hỏng màn hình doanh số', () => {
  const s = computeSales([null, { id: 'x' }, { id: 'y', ts: 'abc', items: 5 }, { id: 'z', ts: NOW, total: 'abc', items: [null] }], { now: NOW, sessions: [null] });
  assert.equal(s.todayRevenue, 0);
  assert.deepEqual(computeSales(undefined, { now: NOW }).days.length, 7);
});
