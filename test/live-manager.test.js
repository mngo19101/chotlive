import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { LiveManager } from '../live-manager.js';

const events = {
  chat: 'chat',
  emote: 'emote',
  roomUser: 'roomUser',
  streamEnd: 'streamEnd',
  disconnected: 'disconnected',
  error: 'error',
  rawData: 'decodedData'
};

class FakeConn extends EventEmitter {
  constructor(username, behaviour) {
    super();
    this.username = username;
    this.behaviour = behaviour;
    this.disconnected = false;
  }
  async connect() {
    const b = this.behaviour();
    if (b instanceof Error) throw b;
    return { roomId: 'room-' + this.username };
  }
  async disconnect() {
    this.disconnected = true;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ behaviour = () => null, retryDelays = [1, 1, 1], staleAfterMs = 1000 } = {}) {
  const conns = [];
  const log = { comments: [], ended: [], changes: [], sessions: [] };
  let clock = 1000;
  const mgr = new LiveManager({
    events,
    retryDelays,
    staleAfterMs,
    now: () => clock,
    createConnection: (u) => {
      const c = new FakeConn(u, behaviour);
      conns.push(c);
      return c;
    },
    onComment: (userId, entry, data, kind) => log.comments.push({ userId, live: entry.username, data, kind }),
    onViewers: () => {},
    onChange: (_u, e) => log.changes.push(`${e.username}:${e.state}`),
    onSessionNeeded: (_u, e) => {
      e.sessionId = e.sessionId || 's_' + e.key;
      log.sessions.push(e.username);
    },
    onEnded: (_u, e, reason) => log.ended.push(`${e.username}:${reason}`),
    friendlyError: (e) => e.message
  });
  return { mgr, conns, log, setClock: (v) => (clock = v) };
}

test('theo dõi nhiều live cùng lúc: mỗi live một kết nối, không dừng live khác', async () => {
  const { mgr, conns, log } = setup();
  mgr.start('u1', 'shop.a');
  mgr.start('u1', 'shop.b');
  await tick();
  assert.equal(conns.length, 2);
  assert.equal(conns[0].disconnected, false);
  assert.deepEqual(mgr.list('u1').map((l) => [l.username, l.state]), [
    ['shop.a', 'connected'],
    ['shop.b', 'connected']
  ]);
  conns[0].emit('chat', { comment: 'a' });
  conns[1].emit('chat', { comment: 'b' });
  assert.deepEqual(log.comments.map((c) => c.live), ['shop.a', 'shop.b']);
  mgr.stopAll();
});

test('bấm lại live đang theo dõi không tạo kết nối trùng (không phân biệt hoa thường)', async () => {
  const { mgr, conns } = setup();
  mgr.start('u1', 'Shop.A');
  mgr.start('u1', 'shop.a');
  await tick();
  assert.equal(conns.length, 1);
  mgr.stopAll();
});

test('dữ liệu tài khoản nào đi về tài khoản đó', async () => {
  const { mgr, conns, log } = setup();
  mgr.start('u1', 'shop.a');
  mgr.start('u2', 'shop.a');
  await tick();
  assert.equal(conns.length, 2);
  conns[1].emit('chat', { comment: 'x' });
  assert.equal(log.comments[0].userId, 'u2');
  assert.equal(mgr.list('u1').length, 1);
  mgr.stopAll();
});

test('dừng một live chỉ dừng đúng live đó', async () => {
  const { mgr, conns, log } = setup();
  mgr.start('u1', 'shop.a');
  mgr.start('u1', 'shop.b');
  await tick();
  mgr.stop('u1', 'SHOP.A');
  assert.equal(conns[0].disconnected, true);
  assert.equal(conns[1].disconnected, false);
  assert.deepEqual(log.ended, ['shop.a:stopped']);
  assert.deepEqual(mgr.list('u1').map((l) => l.username), ['shop.b']);
  mgr.stop('u1');
  assert.deepEqual(log.ended, ['shop.a:stopped', 'shop.b:stopped']);
  mgr.stopAll();
});

test('rớt kết nối thì tự nối lại, phiên vẫn giữ nguyên và không báo kết thúc', async () => {
  const { mgr, conns, log } = setup();
  const entry = mgr.start('u1', 'shop.a');
  await tick();
  const sessionId = entry.sessionId;
  conns[0].emit('disconnected');
  assert.equal(mgr.list('u1')[0].state, 'reconnecting');
  await wait(10);
  assert.equal(conns.length, 2);
  assert.equal(mgr.list('u1')[0].state, 'connected');
  assert.equal(entry.sessionId, sessionId);
  assert.deepEqual(log.ended, []);
  conns[1].emit('chat', { comment: 'sau khi nối lại' });
  assert.equal(log.comments.length, 1);
  // Kết nối cũ phát sự kiện muộn thì không tính.
  conns[0].emit('chat', { comment: 'muộn' });
  assert.equal(log.comments.length, 1);
  mgr.stopAll();
});

test('nối lại thất bại nhiều lần thì thử tiếp, hết lượt mới dừng và báo lỗi', async () => {
  let calls = 0;
  const { mgr, conns, log } = setup({
    retryDelays: [1, 1],
    behaviour: () => (calls++ === 0 ? null : new Error('mạng lỗi'))
  });
  mgr.start('u1', 'shop.a');
  await tick();
  conns[0].emit('disconnected');
  await wait(20);
  assert.equal(conns.length, 3);
  assert.deepEqual(log.ended, ['shop.a:error']);
  assert.equal(mgr.list('u1').length, 0);
  mgr.stopAll();
});

test('nối lại mà streamer đã tắt live thì kết thúc phiên, không thử nữa', async () => {
  let calls = 0;
  const { mgr, conns, log } = setup({
    behaviour: () => (calls++ === 0 ? null : new Error("The requested user isn't online :("))
  });
  mgr.start('u1', 'shop.a');
  await tick();
  conns[0].emit('disconnected');
  await wait(10);
  assert.deepEqual(log.ended, ['shop.a:ended']);
  assert.equal(conns.length, 2);
  mgr.stopAll();
});

test('lần đầu không kết nối được thì báo lỗi ngay, không tự thử lại', async () => {
  const { mgr, conns, log } = setup({ behaviour: () => new Error('sai tên') });
  const entry = mgr.start('u1', 'shop.a');
  await tick();
  assert.deepEqual(log.ended, ['shop.a:error']);
  assert.equal(entry.message, 'sai tên');
  assert.equal(conns.length, 1);
  assert.deepEqual(log.sessions, [], 'không tạo phiên rỗng');
  mgr.stopAll();
});

test('live kết thúc thật thì đóng ngay', async () => {
  const { mgr, conns, log } = setup();
  mgr.start('u1', 'shop.a');
  await tick();
  conns[0].emit('streamEnd');
  assert.deepEqual(log.ended, ['shop.a:ended']);
  conns[0].emit('disconnected');
  await wait(5);
  assert.equal(conns.length, 1, 'không nối lại sau khi đã kết thúc');
  mgr.stopAll();
});

test('kết nối mở nhưng im lặng quá lâu thì được nối lại; còn dữ liệu thì không', async () => {
  const { mgr, conns, setClock } = setup({ staleAfterMs: 1000 });
  mgr.start('u1', 'shop.a');
  await tick();
  setClock(1500);
  conns[0].emit('roomUser', { viewerCount: 3 });
  setClock(2000);
  mgr.checkStale();
  await wait(5);
  assert.equal(conns.length, 1, 'mới có dữ liệu 500ms trước');
  setClock(5000);
  mgr.checkStale();
  await wait(10);
  assert.equal(conns.length, 2);
  assert.equal(conns[0].disconnected, true);
  assert.equal(mgr.list('u1')[0].state, 'connected');
  mgr.stopAll();
});

test('số người xem tính riêng cho từng live', async () => {
  const { mgr, conns } = setup();
  mgr.start('u1', 'shop.a');
  mgr.start('u1', 'shop.b');
  await tick();
  conns[0].emit('roomUser', { viewerCount: 12 });
  conns[1].emit('roomUser', { viewerCount: 34 });
  assert.deepEqual(mgr.list('u1').map((l) => l.viewers), [12, 34]);
  mgr.stopAll();
});

test('sticker cũng được chuyển tiếp như bình luận', async () => {
  const { mgr, conns, log } = setup();
  mgr.start('u1', 'shop.a');
  await tick();
  conns[0].emit('emote', { emoteList: [{}] });
  assert.equal(log.comments[0].kind, 'emote');
  mgr.stopAll();
});
