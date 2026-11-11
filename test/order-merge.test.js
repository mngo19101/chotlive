/**
 * Gộp món mới vào đơn của khách trên web: chỉ gộp vào đơn còn mở,
 * không gộp vào đơn đang giao hoặc đã có vận đơn.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saved = new Map();
globalThis.localStorage = {
  getItem: (k) => (saved.has(k) ? saved.get(k) : null),
  setItem: (k, v) => saved.set(k, String(v)),
  removeItem: (k) => saved.delete(k)
};

let store;
before(async () => {
  store = await import('../public/js/store.js');
  store.registerSyncPushHandler(() => {}, () => 'u1');
});

const order = (over = {}) => ({
  id: 'o1', code: 'HD1', uniqueId: 'lan.nguyen', nickname: 'Lan', status: 'printed', ts: 1, total: 100000,
  items: [{ id: 'i1', commentId: 'c1', name: 'Mã 100', price: 100000, qty: 1 }], ...over
});
const load = async (orders) => {
  await sleep(90);
  store.clearPendingChanges();
  store.applyRemoteState({ orders, customers: [], accounts: [], comments: [], seq: 0 }, 'reset');
};
const add = (over = {}) =>
  store.addOrMergeOrder({ uniqueId: 'lan.nguyen', nickname: 'Lan', productName: 'Mã 50', price: 50000, commentId: 'c2', ...over });

beforeEach(() => load([]));

test('đơn còn mở: món mới gộp vào đơn đó', async () => {
  await load([order()]);
  const r = add();
  assert.equal(r.isMerged, true);
  assert.equal(r.order.id, 'o1');
  assert.equal(r.order.total, 150000);
  assert.equal(store.state.orders.length, 1);
});

test('đơn đang giao đã có vận đơn: món mới sang đơn riêng, đơn cũ giữ nguyên', async () => {
  await load([order({ status: 'shipping', ship: { state: 'exported', vtpCode: 'VTP1' } })]);
  const r = add();
  assert.equal(r.isMerged, false);
  assert.notEqual(r.order.id, 'o1');
  assert.equal(r.order.status, 'new');
  const old = store.state.orders.find((o) => o.id === 'o1');
  assert.equal(old.items.length, 1);
  assert.equal(old.total, 100000);
  assert.equal(store.state.orders.length, 2);
});

test('đơn đã xuất file gửi hoặc còn mã vận đơn cũng không nhận thêm món', async () => {
  await load([order({ ship: { state: 'exported' } })]);
  assert.equal(add().isMerged, false);
  await load([order({ ship: { state: 'ready', vtpCode: 'VTP2' } })]);
  assert.equal(add().isMerged, false);
});

test('thêm món vào đơn có tiền thu hộ nhập tay: bỏ số nhập tay để tính lại', async () => {
  await load([order({ ship: { state: 'ready', pay: 'cod', codOverride: 100000 } })]);
  const r = add();
  assert.equal(r.isMerged, true);
  assert.equal(r.codReset, true);
  assert.equal(r.order.ship.codOverride, null);
  assert.equal(r.order.ship.state, 'ready');
  assert.equal(r.order.total, 150000);
});

test('gộp đơn trùng không kéo đơn đang giao vào đơn mới', async () => {
  await load([
    order({ id: 'moi', status: 'new', items: [{ id: 'i9', commentId: 'c9', name: 'Mã 50', price: 50000, qty: 1 }], total: 50000 }),
    order({ status: 'shipping', ship: { state: 'exported', vtpCode: 'VTP1' } })
  ]);
  assert.equal(store.mergeDuplicateOrders(), 0);
  assert.equal(store.state.orders.length, 2);
});
