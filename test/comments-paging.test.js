/**
 * Xem lại bình luận cũ theo từng trang: không được sót hay lặp bình luận,
 * kể cả khi nhiều bình luận trùng mốc thời gian (TikTok có thể chỉ trả thời gian theo giây).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { insertComments, listComments, openDb } from '../db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susu-paging-'));
let db;

before(() => {
  db = openDb(path.join(dir, 'test.db'));
});

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Đi hết các trang như nút "xem thêm": mỗi trang bắt đầu sau bình luận cuối của trang trước. */
function readAllPages(userId, { sessionId = '', limit }) {
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 1000; guard++) {
    const rows = listComments(db, userId, {
      sessionId,
      before: cursor?.ts || 0,
      beforeId: cursor?.id || '',
      limit: limit + 1
    });
    const page = rows.slice(0, limit);
    seen.push(...page.map((c) => c.id));
    if (rows.length <= limit) return seen;
    const last = page[page.length - 1];
    cursor = { ts: last.ts, id: last.id };
  }
  assert.fail('Không đi hết được các trang');
}

test('nhiều bình luận cùng một giây: đi hết các trang không sót, không lặp', () => {
  const ts = 1794000000000;
  const comments = [];
  // 25 bình luận mỗi giây, trang 10 bình luận luôn cắt giữa một giây.
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 25; i++) comments.push({ id: `c${s}_${i}`, ts: ts + s * 1000, sessionId: 's1', comment: 'x' });
  }
  insertComments(db, 'tie', comments);

  const seen = readAllPages('tie', { limit: 10 });
  assert.equal(new Set(seen).size, seen.length, 'không lặp');
  assert.equal(seen.length, comments.length, 'không sót');
});

test('chỉ lấy đúng phiên đang xem', () => {
  const ts = 1794000000000;
  insertComments(db, 'scope', [
    { id: 'a1', ts, sessionId: 'a', comment: 'x' },
    { id: 'b1', ts, sessionId: 'b', comment: 'x' },
    { id: 'a2', ts: ts - 1000, sessionId: 'a', comment: 'x' },
    { id: 'b2', ts: ts - 1000, sessionId: 'b', comment: 'x' }
  ]);
  assert.deepEqual(readAllPages('scope', { sessionId: 'a', limit: 1 }), ['a1', 'a2']);
});

test('chỉ có mốc thời gian (thiết bị cũ) vẫn lấy được phần cũ hơn', () => {
  const ts = 1794000000000;
  insertComments(db, 'legacy', [
    { id: 'n', ts, comment: 'x' },
    { id: 'o', ts: ts - 1000, comment: 'x' }
  ]);
  assert.deepEqual(listComments(db, 'legacy', { before: ts }).map((c) => c.id), ['o']);
});
