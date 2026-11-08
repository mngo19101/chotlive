import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapCollections, snapScalars } from '../delta.js';
import { restoreState, stateBytes } from '../limits.js';
import { createLimiter } from '../rate-limit.js';

test('trả dữ liệu về như cũ kể cả khi đối tượng bị sửa tại chỗ', () => {
  const state = { orders: [{ id: 'a', items: [{ id: 'i1' }] }], customers: [], settings: { shopName: 'A' }, seq: 1 };
  const cols = snapCollections(state);
  const scalars = snapScalars(state);
  state.orders[0].items.push({ id: 'i2' });
  state.orders.push({ id: 'b' });
  state.settings.shopName = 'B';
  state.prints = [1];
  restoreState(state, cols, scalars);
  assert.deepEqual(state.orders, [{ id: 'a', items: [{ id: 'i1' }] }]);
  assert.equal(state.settings.shopName, 'A');
  assert.equal(state.prints, undefined);
});

test('dung lượng dữ liệu tính đủ danh sách và cài đặt', () => {
  const state = { orders: [{ id: 'a', note: 'x'.repeat(1000) }], settings: { footer: 'y'.repeat(500) } };
  const n = stateBytes(snapCollections(state), snapScalars(state));
  assert.ok(n > 1500 && n < 1700, String(n));
});

test('bộ đếm theo dung lượng: cộng đúng số lượng, hết giờ thì mở lại', () => {
  let now = 0;
  const limiter = createLimiter({ max: 100, windowMs: 1000, now: () => now });
  limiter.hit('u', 60);
  assert.equal(limiter.retryAfter('u'), 0);
  limiter.hit('u', 50);
  assert.equal(limiter.retryAfter('u'), 1);
  now = 1000;
  assert.equal(limiter.retryAfter('u'), 0);
});
