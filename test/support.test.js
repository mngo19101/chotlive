import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as support from '../support.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  support.initSupport(db);
  return db;
}

const say = (db, userId, sender, text, now, sessionId) => support.postMessage(db, { userId, sender, text, now, sessionId });

test('khách nhắn trong 24 giờ thì cùng một phiên, quá 24 giờ thì mở phiên mới', () => {
  const db = freshDb();
  const a = say(db, 'u1', 'user', 'chào', T0);
  const b = say(db, 'u1', 'user', 'còn đó không', T0 + DAY - 1000);
  assert.equal(a.session.id, b.session.id);
  const c = say(db, 'u1', 'user', 'alo', T0 + 2 * DAY);
  assert.notEqual(c.session.id, a.session.id);

  const sessions = support.listSessions(db, 'u1', T0 + 2 * DAY);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].open, true);
  assert.equal(sessions[1].open, false);
  assert.equal(support.listMessages(db, a.session.id).length, 2); // phiên cũ vẫn xem lại được
});

test('tin của Admin cũng kéo dài phiên, và Admin không trả lời được phiên đã đóng', () => {
  const db = freshDb();
  const a = say(db, 'u1', 'user', 'giúp mình', T0);
  assert.ok(say(db, 'u1', 'admin', 'dạ', T0 + DAY - 1000, a.session.id));
  assert.ok(say(db, 'u1', 'user', 'cảm ơn', T0 + 2 * DAY - 2000)); // vẫn cùng phiên nhờ tin admin
  assert.equal(support.listSessions(db, 'u1', T0 + 2 * DAY - 2000).length, 1);
  assert.equal(say(db, 'u1', 'admin', 'muộn rồi', T0 + 4 * DAY, a.session.id), null);
  assert.equal(say(db, 'u2', 'admin', 'sai khách', T0, a.session.id), null);
});

test('tin trống bị bỏ, tin quá dài bị cắt', () => {
  const db = freshDb();
  assert.equal(say(db, 'u1', 'user', '   ', T0), null);
  const r = say(db, 'u1', 'user', 'x'.repeat(5000), T0);
  assert.equal(r.message.text.length, support.MAX_TEXT);
});

test('đếm tin chưa đọc theo từng phía và xoá khi đã đọc', () => {
  const db = freshDb();
  const a = say(db, 'u1', 'user', 'hỏi', T0);
  say(db, 'u2', 'user', 'hỏi khác', T0);
  assert.equal(support.unreadCount(db, 'u1', 'user'), 0);
  assert.equal(support.unreadCount(db, '', 'admin', { forAllUsers: true }), 2);

  say(db, 'u1', 'admin', 'trả lời 1', T0 + 1, a.session.id);
  say(db, 'u1', 'admin', 'trả lời 2', T0 + 2, a.session.id);
  assert.equal(support.unreadCount(db, 'u1', 'user'), 2);
  support.markRead(db, 'u1', 'user');
  assert.equal(support.unreadCount(db, 'u1', 'user'), 0);

  support.markRead(db, 'u1', 'admin');
  assert.equal(support.unreadCount(db, '', 'admin', { forAllUsers: true }), 1);
  const rows = support.listSessionsForAdmin(db, T0 + 3);
  assert.equal(rows.find((s) => s.userId === 'u2').unread, 1);
  assert.equal(rows.find((s) => s.userId === 'u1').unread, 0);
});

test('tin nhắn chỉ giữ 30 ngày, phiên rỗng bị xoá theo', () => {
  const db = freshDb();
  const old = say(db, 'u1', 'user', 'cũ', T0);
  const fresh = say(db, 'u1', 'user', 'mới', T0 + 29 * DAY);
  support.purgeOld(db, T0 + 31 * DAY);
  assert.equal(support.listMessages(db, old.session.id).length, 0);
  assert.equal(support.listMessages(db, fresh.session.id).length, 1);
  assert.equal(support.listSessions(db, 'u1', T0 + 31 * DAY).length, 1);

  support.purgeOld(db, T0 + 61 * DAY);
  assert.equal(support.listSessions(db, 'u1', T0 + 61 * DAY).length, 0);
});

test('xoá tài khoản xoá luôn chat của họ', () => {
  const db = freshDb();
  say(db, 'u1', 'user', 'a', T0);
  say(db, 'u2', 'user', 'b', T0);
  support.deleteUserSupport(db, 'u1');
  assert.equal(support.listSessions(db, 'u1').length, 0);
  assert.equal(support.listSessions(db, 'u2').length, 1);
});
