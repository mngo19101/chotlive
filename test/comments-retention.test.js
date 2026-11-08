import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertComments, listComments, purgeOldComments } from '../db.js';

const DAY = 86400000;
const YEAR = 365 * DAY;
const NOW = Date.UTC(2027, 10, 8);
const ids = (db) => listComments(db, 'u', { limit: 10000 }).map((c) => c.id).sort();

/** Đủ bình luận gần đây để một lần dọn bình thường không chạm ngưỡng 20%. */
function recent(n, now = NOW) {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, ts: now - (i % 300) * DAY, comment: 'hi' }));
}

test('xóa bình luận quá hạn, giữ bình luận đã chốt', () => {
  const db = openDb(':memory:');
  const old = NOW - 400 * DAY;
  insertComments(db, 'u', [
    ...recent(20),
    { id: 'a', ts: old, comment: 'xin chào' },
    { id: 'b', ts: old, comment: 'chốt', price: 120 },
    { id: 'c', ts: old, comment: 'x', printed: true },
    { id: 'd', ts: old, comment: 'y' }
  ]);
  assert.deepEqual(purgeOldComments(db, 'u', YEAR, new Set(['d']), NOW), { deleted: 1 });
  assert.ok(!ids(db).includes('a'));
  assert.ok(['b', 'c', 'd'].every((id) => ids(db).includes(id)));
});

test('mốc thời gian lỗi (0, tính bằng giây) không bị xóa', () => {
  const db = openDb(':memory:');
  insertComments(db, 'u', [
    ...recent(20),
    { id: 'zero', ts: 0, comment: 'x' },
    { id: 'seconds', ts: Math.floor((NOW - 10 * DAY) / 1000), comment: 'x' }
  ]);
  assert.deepEqual(purgeOldComments(db, 'u', YEAR, new Set(), NOW), { deleted: 0 });
  assert.ok(ids(db).includes('zero') && ids(db).includes('seconds'));
});

test('đồng hồ máy nhảy tới tương lai cũng không xóa', () => {
  const db = openDb(':memory:');
  insertComments(db, 'u', recent(50));
  const wrongClock = Date.UTC(2035, 0, 1);
  assert.deepEqual(purgeOldComments(db, 'u', YEAR, new Set(), wrongClock), { deleted: 0 });
  assert.equal(ids(db).length, 50);
});

test('một lần mà phải xóa quá nhiều thì dừng lại', () => {
  const db = openDb(':memory:');
  // Bình luận đều ghi sai năm (vd. 2 năm trước), chỉ một cái đúng giờ.
  const wrong = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, ts: NOW - 2 * YEAR + i, comment: 'x' }));
  insertComments(db, 'u', [...wrong, { id: 'ok', ts: NOW, comment: 'x' }]);
  const r = purgeOldComments(db, 'u', YEAR, new Set(), NOW);
  assert.equal(r.deleted, 0);
  assert.equal(r.blocked, 30);
  assert.equal(ids(db).length, 31);
});
