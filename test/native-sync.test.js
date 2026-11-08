import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyNativeUpdate,
  mergeNativeSessions,
  sessionName,
  toNativeSnapshot
} from '../native-sync.js';

const webOrder = (over = {}) => ({
  id: 'o_web',
  code: 'HD26110701',
  uniqueId: 'Linh.Nguyen',
  userId: '71928419201',
  nickname: 'Linh',
  status: 'new',
  ts: 1794000000000,
  shippingFee: 20000,
  items: [{ id: 'it_1', commentId: 'c1', name: 'Mã 150', price: 150000, qty: 2, comment: 'chốt 150', ts: 1794000000000 }],
  total: 320000,
  ...over
});

const baseState = () => ({
  seq: 1,
  settings: {},
  orders: [webOrder()],
  customers: [
    {
      id: 'c_1',
      uniqueId: 'linh.nguyen',
      userId: '71928419201',
      name: 'Linh',
      phone: '0905123456',
      street: '25 Lê Lợi',
      ward: 'Bến Nghé',
      district: 'Quận 1',
      province: 'TP.HCM',
      deliveryNote: 'Gọi trước',
      tag: 'Mua nhiều'
    }
  ],
  comments: [{ id: 'c1', printed: true }, { id: 'c2' }],
  sessions: [],
  accounts: [{ id: 'acc1', name: 'Shop', handle: '@shop.live', active: true }]
});

test('đơn web hiện đúng bên app: gom vào khách, đúng trạng thái và địa chỉ', () => {
  const snap = toNativeSnapshot(baseState());
  assert.equal(snap.customers.length, 1);
  const c = snap.customers[0];
  assert.equal(c.id, 'linh.nguyen');
  assert.equal(c.items[0].id, 'it_1');
  assert.equal(c.items[0].code, '150');
  assert.equal(c.items[0].groupId, 'o_web');
  assert.equal(c.items[0].printed, false);
  assert.deepEqual(c.address, {
    receiver: 'Linh',
    phone: '0905123456',
    street: '25 Lê Lợi',
    region: 'Bến Nghé, Quận 1, TP.HCM',
    note: 'Gọi trước'
  });
  assert.deepEqual(snap.printedCommentIds, ['c1']);
  assert.deepEqual(snap.accounts, [{ id: 'shop.live', uniqueId: 'shop.live', displayName: 'Shop' }]);
  assert.equal(snap.activeAccountId, 'shop.live');
});

test('trạng thái đơn web quyết định cờ giao hàng bên app', () => {
  const st = baseState();
  st.orders[0].status = 'shipping';
  let it = toNativeSnapshot(st).customers[0].items[0];
  assert.deepEqual([it.printed, it.shipping, it.delivered], [true, true, false]);
  st.orders[0].status = 'done';
  it = toNativeSnapshot(st).customers[0].items[0];
  assert.deepEqual([it.shipping, it.delivered], [false, true]);
});

test('đơn đã huỷ trên web không hiện bên app', () => {
  const st = baseState();
  st.orders[0].status = 'cancelled';
  assert.deepEqual(toNativeSnapshot(st).customers[0].items, []);
});

const nativeCustomer = (items, over = {}) => ({
  id: 'mai.pham',
  uniqueId: 'mai.pham',
  userId: '72538194012',
  nickname: 'Mai Phạm',
  items,
  ...over
});
const nativeItem = (over = {}) => ({
  id: 'cmt9',
  comment: 'Chốt 120',
  price: 120000,
  ts: 1794000500000,
  printed: false,
  delivered: false,
  shipping: false,
  qty: 1,
  sessionId: 's1',
  groupId: 's1',
  code: '120',
  commentId: 'cmt9',
  ...over
});

test('đơn chốt trên app xuất hiện thành đơn và khách trên web', () => {
  const st = baseState();
  applyNativeUpdate(st, { customers: [nativeCustomer([nativeItem()])] });
  const order = st.orders.find((o) => o.uniqueId === 'mai.pham');
  assert.ok(order, 'có đơn mới');
  assert.match(order.code, /^HD\d{8}$/);
  assert.equal(order.status, 'new');
  assert.equal(order.total, 120000);
  assert.equal(order.items[0].name, 'Mã 120');
  assert.equal(order.items[0].commentId, 'cmt9');
  const cust = st.customers.find((c) => c.uniqueId === 'mai.pham');
  assert.equal(cust.name, 'Mai Phạm');
  assert.equal(cust.totalSpent, 120000);
  assert.equal(cust.orderCount, 1);
  assert.equal(st.orders.length, 2);
});

test('gửi lại cùng một thay đổi không tạo đơn trùng', () => {
  const st = baseState();
  const update = { customers: [nativeCustomer([nativeItem()])] };
  applyNativeUpdate(st, update);
  applyNativeUpdate(st, update);
  applyNativeUpdate(st, update);
  assert.equal(st.orders.filter((o) => o.uniqueId === 'mai.pham').length, 1);
  assert.equal(st.orders.find((o) => o.uniqueId === 'mai.pham').items.length, 1);
  assert.equal(st.customers.filter((c) => c.uniqueId === 'mai.pham').length, 1);
});

test('món cùng nhóm vào cùng một đơn, nhóm khác thành đơn khác', () => {
  const st = baseState();
  applyNativeUpdate(st, {
    customers: [
      nativeCustomer([
        nativeItem(),
        nativeItem({ id: 'cmt10', commentId: 'cmt10', code: '130', price: 130000 }),
        nativeItem({ id: 'cmt11', commentId: 'cmt11', groupId: 'manual-1', sessionId: null })
      ])
    ]
  });
  const mine = st.orders.filter((o) => o.uniqueId === 'mai.pham');
  assert.equal(mine.length, 2);
  assert.equal(mine.find((o) => o.items.length === 2).total, 250000);
});

test('sửa trên app giữ nguyên mã đơn và phí ship của web', () => {
  const st = baseState();
  const snap = toNativeSnapshot(st);
  const c = snap.customers[0];
  c.items[0].qty = 3;
  c.items[0].printed = true;
  applyNativeUpdate(st, { customers: [c] });
  const o = st.orders[0];
  assert.equal(o.id, 'o_web');
  assert.equal(o.code, 'HD26110701');
  assert.equal(o.shippingFee, 20000);
  assert.equal(o.total, 150000 * 3 + 20000);
  assert.equal(o.status, 'printed');
  assert.equal(o.printCount, 1);
  assert.equal(st.customers[0].tag, 'Mua nhiều');
});

test('chuyển trạng thái giao hàng từ app cập nhật đơn web', () => {
  const st = baseState();
  const c = toNativeSnapshot(st).customers[0];
  c.items[0].shipping = true;
  applyNativeUpdate(st, { customers: [c] });
  assert.equal(st.orders[0].status, 'shipping');
  c.items[0].shipping = false;
  c.items[0].delivered = true;
  applyNativeUpdate(st, { customers: [c] });
  assert.equal(st.orders[0].status, 'done');
});

test('xoá món trên app: xoá món, hết món thì xoá đơn, còn thông tin thì giữ khách', () => {
  const st = baseState();
  applyNativeUpdate(st, { customers: [nativeCustomer([nativeItem()])] });
  applyNativeUpdate(st, { deletedItemIds: ['cmt9'] });
  assert.equal(st.orders.some((o) => o.uniqueId === 'mai.pham'), false);
  assert.equal(st.customers.some((c) => c.uniqueId === 'mai.pham'), false, 'khách rỗng bị bỏ');

  applyNativeUpdate(st, { deletedItemIds: ['it_1'] });
  assert.equal(st.orders.length, 0);
  assert.equal(st.customers[0].uniqueId, 'linh.nguyen', 'khách có SĐT vẫn còn');
  assert.equal(st.customers[0].orderCount, 0);
});

test('món đã xoá không bị thêm lại dù gửi kèm trong khách', () => {
  const st = baseState();
  applyNativeUpdate(st, { customers: [nativeCustomer([nativeItem()])], deletedItemIds: ['cmt9'] });
  assert.equal(st.orders.some((o) => o.uniqueId === 'mai.pham'), false);
});

test('app không gửi khách nào thì đơn web không đổi', () => {
  const st = baseState();
  const before = JSON.stringify(st.orders);
  applyNativeUpdate(st, { customers: [] });
  assert.equal(JSON.stringify(st.orders), before);
});

test('sửa địa chỉ trên app ghi vào khách và đơn web, gửi lại không đổi', () => {
  const st = baseState();
  const c = toNativeSnapshot(st).customers[0];
  c.address = { receiver: 'Chị Linh', phone: '0911', street: '1 Trần Phú', region: 'P1, Q3, Huế', note: 'Cho xem hàng' };
  applyNativeUpdate(st, { customers: [c] });
  const rec = st.customers[0];
  assert.deepEqual([rec.phone, rec.street, rec.ward, rec.district, rec.province], ['0911', '1 Trần Phú', 'P1', 'Q3', 'Huế']);
  assert.equal(rec.deliveryNote, 'Cho xem hàng');
  assert.equal(st.orders[0].street, '1 Trần Phú');
  assert.deepEqual(toNativeSnapshot(st).customers[0].address, c.address);
});

test('khách trên web chưa có đơn vẫn hiện bên app', () => {
  const st = baseState();
  st.orders = [];
  assert.deepEqual(toNativeSnapshot(st).customers[0].items, []);
});

test('ID TikTok: thêm, đổi đang chọn và xoá từ app', () => {
  const st = baseState();
  applyNativeUpdate(st, {
    accounts: [{ id: 'kho.linh', uniqueId: 'Kho.Linh', displayName: 'Kho Linh' }],
    activeAccountId: 'kho.linh'
  });
  assert.equal(st.accounts.length, 2);
  assert.equal(st.accounts.find((a) => a.active).handle, '@Kho.Linh');
  assert.equal(st.settings.accounts, st.accounts);
  applyNativeUpdate(st, { deletedAccountIds: ['shop.live'] });
  assert.deepEqual(st.accounts.map((a) => a.handle), ['@Kho.Linh']);
});

test('ID lỡ lưu nguyên link phiên live vẫn đọc đúng tên', () => {
  const st = baseState();
  st.accounts = [{ id: 'a', name: 'Shop', handle: '@https://www.tiktok.com/@shop.hai/live' }];
  assert.equal(toNativeSnapshot(st).accounts[0].id, 'shop.hai');
});

test('phiên cũ trên app được thêm vào server, không đè phiên đang ghi', () => {
  const st = baseState();
  st.sessions = [{ id: 's_live', startTs: 1794000000000, isLive: true, commentCount: 5 }];
  const changed = mergeNativeSessions(st, [
    { id: 's_live', start: 1, commentCount: 99 },
    { id: 'old', tiktok: 'shop', start: 1793000000000, end: 1793003600000, commentCount: 7 }
  ]);
  assert.equal(changed, true);
  assert.equal(st.sessions.length, 2);
  assert.equal(st.sessions[0].commentCount, 5);
  assert.equal(st.sessions[1].duration, '1g 0p');
  assert.equal(st.sessions[1].isLive, false);
  assert.equal(mergeNativeSessions(st, [{ id: 'old', start: 1 }]), false);
});

test('tên phiên theo giờ Việt Nam, không theo múi giờ máy chủ', () => {
  // 13:00 UTC = 20:00 giờ Việt Nam
  assert.equal(sessionName(Date.UTC(2026, 10, 7, 13, 0)), 'Phiên tối');
  // 02:00 UTC = 09:00 giờ Việt Nam
  assert.equal(sessionName(Date.UTC(2026, 10, 7, 2, 0)), 'Phiên sáng');
});
