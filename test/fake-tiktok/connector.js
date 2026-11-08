/**
 * Thay thế thư viện TikTok khi chạy thử toàn bộ server (không gọi mạng thật).
 * Tên live quyết định hành vi:
 *   flaky.*   rớt kết nối sau 8 bình luận rồi nối lại được
 *   offline.* báo không live
 *   còn lại   mỗi 150ms một bình luận, mỗi 8 bình luận có một bình luận chốt đơn
 */
import { EventEmitter } from 'node:events';

export const WebcastEvent = {
  CHAT: 'chat',
  EMOTE: 'emote',
  ROOM_USER: 'roomUser',
  STREAM_END: 'streamEnd'
};
export const ControlEvent = { DISCONNECTED: 'disconnected', ERROR: 'error' };

const counters = new Map();

export class TikTokLiveConnection extends EventEmitter {
  constructor(username) {
    super();
    this.username = username;
    this.timer = null;
  }

  chat(n) {
    const u = (n % 5) + 1;
    this.emit('chat', {
      common: { msgId: `${this.username}-${n}`, createTime: String(Date.now()) },
      user: { displayId: `khach${u}`, idStr: `7000000000${u}`, nickname: `Khách ${u}` },
      content: n % 8 === 0 ? `Chốt mã ${100 + n}` : `Shop ơi cho hỏi với ${'nha '.repeat((n % 3) + 1)}`.trim()
    });
  }

  async connect() {
    if (this.username.startsWith('offline')) throw new Error("The requested user isn't online :(");
    const start = counters.get(this.username) || 0;
    // Lô bình luận gửi kèm lúc kết nối: có cả tin đã nhận trước khi rớt, phải không bị trùng.
    for (let n = Math.max(start - 3, 0); n < start; n++) this.chat(n);
    let n = start;
    let sinceConnect = 0;
    this.timer = setInterval(() => {
      this.chat(n);
      n += 1;
      sinceConnect += 1;
      counters.set(this.username, n);
      this.emit('decodedData');
      this.emit('roomUser', { viewerCount: 40 + n });
      if (this.username.startsWith('flaky') && sinceConnect === 8) {
        clearInterval(this.timer);
        this.emit('disconnected', { code: 1006, reason: 'giả lập rớt mạng' });
      }
    }, 150);
    this.timer.unref?.();
    return { roomId: `room-${this.username}` };
  }

  async disconnect() {
    clearInterval(this.timer);
  }
}
