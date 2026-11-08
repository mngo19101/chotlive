import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOnlyCodes } from '../public/js/price.js';

test('chỉ ghi mã mới tính là chốt đơn, có số thôi thì không', () => {
  for (const text of ['280', 'mã 150, 180', '150k', 'Mã 120 và 180']) assert.equal(isOnlyCodes(text), true, text);
  for (const text of ['Mã 130 giá sao', '35 tuổi', 'Cho em xem mã 25 với', '0905123456', 'sz 38 mã 250', '', 'hello'])
    assert.equal(isOnlyCodes(text), false, text);
});
