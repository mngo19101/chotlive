/**
 * Tính doanh số từ đơn hàng thật, theo giờ của thiết bị.
 * Một đơn có thể kéo dài qua nhiều ngày (khách chốt thêm món vào đơn đang mở) nên tiền được tính
 * theo từng món vào đúng ngày chốt món đó; phí ship và giảm giá tính vào ngày của đơn.
 */
const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const WEEK_DAYS = 7;
const PERIOD_BUCKETS = 5;
const PERIOD_BUCKET_DAYS = 6;

const startOfDay = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Cộng theo lịch, không cộng 24 giờ, để không lệch ở nơi có đổi giờ mùa hè. */
const addDays = (dayStart, n) => {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

const pad2 = (n) => String(n).padStart(2, '0');

function moneyEvents(order) {
  if (!order || order.status === 'cancelled') return [];
  const orderTs = Number(order.ts) || 0;
  const items = Array.isArray(order.items) ? order.items : [];
  const events = items.map((it) => ({
    ts: Number(it?.ts) || orderTs,
    amount: (Number(it?.price) || 0) * (Number(it?.qty) || 1)
  }));
  const itemsTotal = events.reduce((s, e) => s + e.amount, 0);
  const total = Number(order.total);
  if (order.total != null && Number.isFinite(total) && total !== itemsTotal) {
    events.push({ ts: orderTs, amount: total - itemsTotal });
  }
  return events.filter((e) => e.ts > 0);
}

function customerKeyOf(order) {
  return String(order.uniqueId || order.userId || order.nickname || '').trim().toLowerCase();
}

function growthPct(current, previous) {
  return previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
}

export function computeSales(orders = [], { now = Date.now(), sessions = [] } = {}) {
  const list = (Array.isArray(orders) ? orders : []).filter(Boolean);
  const perOrder = list.map((order) => ({ order, events: moneyEvents(order) }));
  const allEvents = perOrder.flatMap((x) => x.events);
  const revenue = (from, to) => allEvents.reduce((s, e) => (e.ts >= from && e.ts < to ? s + e.amount : s), 0);

  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  const nowDate = new Date(today);
  const year = nowDate.getFullYear();
  const month = nowDate.getMonth();
  const dayOfMonth = nowDate.getDate();
  const monthStart = new Date(year, month, 1).getTime();
  const prevMonthStart = new Date(year, month - 1, 1).getTime();
  const prevMonthDays = new Date(year, month, 0).getDate();
  // So với cùng số ngày của tháng trước: đầu tháng mà so với cả tháng trước thì lúc nào cũng giảm.
  const prevMonthSamePeriodEnd = new Date(year, month - 1, Math.min(dayOfMonth, prevMonthDays) + 1).getTime();

  const todayRevenue = revenue(today, tomorrow);
  const yesterdayRevenue = revenue(yesterday, today);
  const monthRevenue = revenue(monthStart, tomorrow);
  const prevMonthRevenue = revenue(prevMonthStart, prevMonthSamePeriodEnd);

  const todayOrders = perOrder.filter((x) => x.events.some((e) => e.ts >= today && e.ts < tomorrow));
  const firstSeen = new Map();
  for (const { order, events } of perOrder) {
    const key = customerKeyOf(order);
    if (!key) continue;
    for (const e of events) {
      if (!firstSeen.has(key) || e.ts < firstSeen.get(key)) firstSeen.set(key, e.ts);
    }
  }
  const todayGuests = new Set(todayOrders.map((x) => customerKeyOf(x.order)).filter(Boolean));
  const newGuests = [...todayGuests].filter((k) => firstSeen.get(k) >= today).length;

  const statusCounts = { new: 0, printed: 0, shipping: 0, done: 0 };
  for (const { order } of todayOrders) {
    const status = order.status || 'new';
    if (status in statusCounts) statusCounts[status] += 1;
  }

  // Tỉ lệ chốt: số bình luận có giá hôm nay đã thành món trong đơn. Không có dữ liệu thì không đoán.
  const pricedComments = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => Number(s?.startTs) >= today && Number(s?.startTs) < tomorrow)
    .reduce((sum, s) => sum + (Number(s.priceCount) || 0), 0);
  let closedComments = 0;
  for (const { order } of perOrder) {
    if (order.status === 'cancelled') continue;
    for (const it of Array.isArray(order.items) ? order.items : []) {
      const ts = Number(it?.ts) || Number(order.ts) || 0;
      if (it?.commentId && ts >= today && ts < tomorrow) closedComments += 1;
    }
  }
  const closeRatePct = pricedComments > 0 ? Math.min(100, Math.round((closedComments / pricedComments) * 100)) : null;

  const days = [];
  for (let i = WEEK_DAYS - 1; i >= 0; i--) {
    const start = addDays(today, -i);
    days.push({ label: WEEKDAY[new Date(start).getDay()], amount: revenue(start, addDays(start, 1)), isCurrent: i === 0 });
  }

  const periods = [];
  for (let i = PERIOD_BUCKETS - 1; i >= 0; i--) {
    const end = addDays(tomorrow, -i * PERIOD_BUCKET_DAYS);
    const start = addDays(end, -PERIOD_BUCKET_DAYS);
    const d = new Date(start);
    periods.push({ label: `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`, amount: revenue(start, end), isCurrent: i === 0 });
  }

  return {
    todayRevenue,
    yesterdayRevenue,
    todayGrowthPct: growthPct(todayRevenue, yesterdayRevenue),
    monthRevenue,
    prevMonthRevenue,
    monthGrowthPct: growthPct(monthRevenue, prevMonthRevenue),
    monthNumber: month + 1,
    prevMonthNumber: new Date(prevMonthStart).getMonth() + 1,
    todayOrderCount: todayOrders.length,
    todayGuests: todayGuests.size,
    newGuests,
    statusCounts,
    averageOrderValue: todayOrders.length ? Math.round(todayRevenue / todayOrders.length) : 0,
    closeRatePct,
    days,
    periods
  };
}
