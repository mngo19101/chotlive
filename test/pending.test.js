/**
 * Thay đổi lúc mất mạng: chạy đúng store.js của web với localStorage giả,
 * giả lập máy mất kết nối rồi nhận lại dữ liệu từ server.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { emptyPending, overlayPending, recordChanges, snapshotOf } from '../public/js/pending.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saved = new Map();
globalThis.localStorage = {
  getItem: (k) => (saved.has(k) ? saved.get(k) : null),
  setItem: (k, v) => saved.set(k, String(v)),
  removeItem: (k) => saved.delete(k)
};

let store;
const pushes = [];
let owner = 'u1';
const SETTLE = 90; // lớn hơn thời gian chờ ghi của store.save()

before(async () => {
  store = await import('../public/js/store.js');
  store.registerSyncPushHandler((_s, action) => pushes.push(action), () => owner);
});

beforeEach(async () => {
  owner = 'u1';
  await sleep(SETTLE);
  store.clearPendingChanges();
  store.applyRemoteState({ orders: [], customers: [], accounts: [], comments: [], seq: 0 }, 'reset');
  pushes.length = 0;
});

const serverOrder = (id, over = {}) => ({ id, uniqueId: id, nickname: id, status: 'new', ts: 1, total: 100, items: [{ id: `i_${id}`, price: 100, qty: 1 }], ...over });
const ids = (list) => list.map((o) => o.id);

test('đơn tạo lúc mất mạng không bị dữ liệu server xoá khi có mạng lại', async () => {
  const { order } = store.addOrMergeOrder({ uniqueId: 'khach_offline', nickname: 'Khách', productName: 'Mã 1', price: 300000 });
  await sleep(SETTLE);
  assert.ok(store.pendingChangeCount() > 0);

  // Trong lúc đó iPhone tạo một đơn khác.
  store.applyRemoteState({ orders: [serverOrder('tu_iphone')], customers: [] }, 'hello');

  assert.deepEqual(ids(store.state.orders), [order.id, 'tu_iphone'], 'có cả hai đơn');
  assert.ok(store.state.customers.some((c) => c.uniqueId === 'khach_offline'), 'khách mới cũng còn');
});

test('server đã nhận thì không còn giữ lại, thiết bị khác xoá đơn đó được', async () => {
  const { order } = store.addOrMergeOrder({ uniqueId: 'k2', nickname: 'K2', productName: 'Mã 2', price: 100000 });
  await sleep(SETTLE);
  store.markPendingSynced();
  assert.equal(store.pendingChangeCount(), 0);

  store.applyRemoteState({ orders: [], customers: [] }, 'remote_sync');
  assert.ok(!store.state.orders.some((o) => o.id === order.id));
});

test('xoá đơn lúc mất mạng: đơn không quay lại khi nhận dữ liệu server', async () => {
  store.applyRemoteState({ orders: [serverOrder('a'), serverOrder('b')] }, 'hello');
  store.removeOrder('a');
  await sleep(SETTLE);
  store.applyRemoteState({ orders: [serverOrder('a'), serverOrder('b'), serverOrder('c')] }, 'hello');
  assert.deepEqual(ids(store.state.orders), ['b', 'c']);
});

test('sửa đơn lúc mất mạng: giữ bản đã sửa, đơn khác theo server', async () => {
  store.applyRemoteState({ orders: [serverOrder('a'), serverOrder('b')] }, 'hello');
  store.updateOrderStatus('a', 'done');
  await sleep(SETTLE);
  store.applyRemoteState({ orders: [serverOrder('a'), serverOrder('b', { status: 'shipping' })] }, 'hello');
  assert.equal(store.state.orders.find((o) => o.id === 'a').status, 'done');
  assert.equal(store.state.orders.find((o) => o.id === 'b').status, 'shipping');
});

test('vừa bấm xong, chưa tới lượt ghi mà dữ liệu server về: thay đổi vẫn còn', () => {
  store.addOrMergeOrder({ uniqueId: 'k3', nickname: 'K3', productName: 'Mã 3', price: 100000 });
  store.applyRemoteState({ orders: [], customers: [] }, 'remote_sync');
  assert.ok(store.state.orders.some((o) => o.uniqueId === 'k3'));
});

test('đổi sang tài khoản khác: thay đổi của tài khoản cũ không lọt sang', async () => {
  store.addOrMergeOrder({ uniqueId: 'k4', nickname: 'K4', productName: 'Mã 4', price: 100000 });
  await sleep(SETTLE);
  assert.equal(store.getPendingOwner(), 'u1');
  // setAuthSession trong sync.js gọi hàm này khi đăng nhập người khác.
  store.clearPendingChanges();
  owner = 'u2';
  store.applyRemoteState({ orders: [serverOrder('cua_u2')], customers: [] }, 'initial_fetch');
  assert.deepEqual(ids(store.state.orders), ['cua_u2']);
});

test('đặt lại dữ liệu từ server thì bỏ các thay đổi đang chờ', async () => {
  store.addOrMergeOrder({ uniqueId: 'k5', nickname: 'K5', productName: 'Mã 5', price: 100000 });
  await sleep(SETTLE);
  store.applyRemoteState({ orders: [], customers: [] }, 'reset');
  assert.equal(store.pendingChangeCount(), 0);
  assert.equal(store.state.orders.length, 0);
});

test('bình luận đã in lúc mất mạng vẫn giữ dấu đã in', async () => {
  store.state.comments = [{ id: 'c1', printed: true }];
  store.addOrMergeOrder({ uniqueId: 'k6', nickname: 'K6', productName: 'Mã 6', price: 100000, commentId: 'c1' });
  await sleep(SETTLE);
  store.applyRemoteState({ orders: [], comments: [{ id: 'c1' }, { id: 'c2' }] }, 'hello');
  assert.equal(store.state.comments.find((c) => c.id === 'c1').printed, true);
  assert.ok(!store.state.comments.find((c) => c.id === 'c2').printed);
});

test('hai đơn riêng của cùng một khách không còn bị tự gộp, không mất phí ship', async () => {
  store.applyRemoteState(
    { orders: [serverOrder('nhom1', { uniqueId: 'khach' }), serverOrder('nhom2', { uniqueId: 'khach', shippingFee: 30000 })] },
    'hello'
  );
  store.addOrMergeOrder({ uniqueId: 'khac', nickname: 'Khác', productName: 'M', price: 1000 });
  await sleep(SETTLE);
  assert.deepEqual(ids(store.state.orders).filter((id) => id.startsWith('nhom')), ['nhom1', 'nhom2']);
  assert.equal(store.state.orders.find((o) => o.id === 'nhom2').shippingFee, 30000);
});

test('bình luận mới của khách đang có đơn mở vẫn được gom vào đơn đó', async () => {
  const first = store.addOrMergeOrder({ uniqueId: 'quen', nickname: 'Quen', productName: 'A', price: 1000 });
  const second = store.addOrMergeOrder({ uniqueId: 'quen', nickname: 'Quen', productName: 'B', price: 2000 });
  assert.equal(second.order.id, first.order.id);
  assert.equal(second.order.items.length, 2);
  await sleep(SETTLE);
});

test('recordChanges và overlayPending: thêm rồi xoá lại trên máy thì không gửi gì sai', () => {
  const pending = emptyPending('u');
  const empty = snapshotOf({ orders: [] });
  const withA = snapshotOf({ orders: [{ id: 'a' }] });
  recordChanges(pending, empty, withA);
  recordChanges(pending, withA, empty);
  assert.deepEqual(pending.changes.orders, { upsert: [], remove: ['a'] });
  assert.deepEqual(overlayPending('orders', [{ id: 'b' }, { id: 'a' }], [], pending), [{ id: 'b' }]);
});
