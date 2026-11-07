import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createTelegramBridge } from '../telegram.js';

function setup(adminChatId = '111') {
  const db = new DatabaseSync(':memory:');
  const sent = [];
  let nextId = 100;
  const replies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ method: url.split('/').pop(), ...body });
    return { json: async () => ({ ok: true, result: { message_id: nextId++ } }), status: 200 };
  };
  const bridge = createTelegramBridge({
    token: 'T', adminChatId, db, fetchImpl, log: {},
    onReply: async (r) => { replies.push(r); return r.sessionId === 'closed' ? { ok: false, error: 'đã đóng' } : { ok: true }; }
  });
  return { bridge, sent, replies, db };
}
const adminMsg = (text, replyId, chat = 111) => ({ message: { message_id: 7, chat: { id: chat }, text, ...(replyId ? { reply_to_message: { message_id: replyId } } : {}) } });
const notify = (bridge, userId, username, text, sid = 's1') =>
  bridge.notifyUserMessage({ userId, username, session: { id: sid, createdAt: Date.UTC(2026, 10, 8, 12) }, message: { text } });

test('không có token thì không bật bot', () => {
  assert.equal(createTelegramBridge({ token: '', db: new DatabaseSync(':memory:') }), null);
});

test('khách nhắn: báo Admin kèm tên khách và nội dung', async () => {
  const { bridge, sent } = setup();
  await notify(bridge, 'u1', 'Lan', 'cần hỗ trợ');
  assert.equal(sent[0].chat_id, '111');
  assert.match(sent[0].text, /Lan/);
  assert.match(sent[0].text, /cần hỗ trợ/);
});

test('Admin trả lời đúng tin của khách nào thì tin đi đúng khách đó', async () => {
  const { bridge, sent, replies } = setup();
  await notify(bridge, 'u1', 'Lan', 'hỏi A'); // message_id 100
  await notify(bridge, 'u2', 'Mai', 'hỏi B', 's2'); // message_id 101
  await bridge.handleUpdate(adminMsg('trả lời Lan', 100));
  await bridge.handleUpdate(adminMsg('trả lời Mai', 101));
  assert.deepEqual(replies.map((r) => [r.userId, r.sessionId, r.text]), [['u1', 's1', 'trả lời Lan'], ['u2', 's2', 'trả lời Mai']]);
  assert.match(sent.at(-1).text, /Đã gửi cho Mai/);
});

test('trả lời vào dòng xác nhận cũng đúng khách; gõ không reply thì không gửi ai', async () => {
  const { bridge, replies } = setup();
  await notify(bridge, 'u1', 'Lan', 'hỏi'); // 100
  await bridge.handleUpdate(adminMsg('câu 1', 100)); // xác nhận = 101
  await bridge.handleUpdate(adminMsg('câu 2', 101));
  await bridge.handleUpdate(adminMsg('gõ lung tung'));
  assert.deepEqual(replies.map((r) => r.text), ['câu 1', 'câu 2']);
});

test('người lạ nhắn bot bị bỏ qua; phiên đã đóng thì báo Admin', async () => {
  const { bridge, sent, replies } = setup();
  await notify(bridge, 'u1', 'Lan', 'x', 'closed'); // 100
  const before = sent.length;
  await bridge.handleUpdate(adminMsg('hack', 100, 999));
  assert.equal(replies.length, 0);
  assert.equal(sent.length, before);
  await bridge.handleUpdate(adminMsg('alo', 100));
  assert.match(sent.at(-1).text, /Chưa gửi được cho Lan/);
});

test('chưa có mã Admin: /start trả về mã chat, không lộ gì khác', async () => {
  const { bridge, sent } = setup('');
  await notify(bridge, 'u1', 'Lan', 'x');
  assert.equal(sent.length, 0);
  await bridge.handleUpdate(adminMsg('/start', null, 555));
  assert.match(sent[0].text, /555/);
});
