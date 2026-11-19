import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLimiter } from '../rate-limit.js';

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
