/**
 * Cầu nối Telegram cho chat hỗ trợ.
 * - Khách nhắn: bot gửi tin vào chat Telegram của Admin (tên khách + nội dung).
 * - Admin bấm "Trả lời" (reply) đúng tin đó: bot chuyển câu trả lời về đúng phiên của khách đó.
 *   Mỗi tin bot gửi được ghi nhớ mã tin Telegram → khách + phiên, nên không thể trả lời nhầm người.
 * - Dùng long polling (getUpdates), không cần địa chỉ công khai. Chỉ nhận lệnh từ đúng chat Admin.
 */
const MAX_TG_TEXT = 3500;
const POLL_SECONDS = 30;

const dayLabel = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
};

export function createTelegramBridge({ token, adminChatId, db, onReply, fetchImpl = fetch, log = console }) {
  if (!token) return null;
  const adminId = String(adminChatId || '');
  const api = `https://api.telegram.org/bot${token}`;

  db.exec(`
    CREATE TABLE IF NOT EXISTS support_tg (
      tg_message_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
  `);

  async function call(method, body, signal) {
    const res = await fetchImpl(`${api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(json.description || `Telegram ${method} lỗi ${res.status}`);
    return json.result;
  }

  const remember = (tgMessageId, userId, sessionId, username) =>
    db
      .prepare('INSERT OR REPLACE INTO support_tg (tg_message_id, user_id, session_id, username, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tgMessageId, userId, sessionId, username, Date.now());

  async function send(chatId, text, extra = {}) {
    return call('sendMessage', { chat_id: chatId, text: String(text).slice(0, MAX_TG_TEXT), ...extra });
  }

  /** Báo Admin có tin mới của khách. Lỗi mạng chỉ ghi log, không làm hỏng việc gửi tin của khách. */
  async function notifyUserMessage({ userId, username, session, message }) {
    if (!adminId) return;
    try {
      const name = username || userId;
      const head = `💬 ${name} · phiên ${dayLabel(session.createdAt)}`;
      const sent = await send(adminId, `${head}\n\n${message.text}\n\n↩️ Bấm Trả lời (reply) vào tin này để nhắn lại cho ${name}.`);
      remember(sent.message_id, userId, session.id, name);
    } catch (e) {
      log.warn?.(`[telegram] không báo được Admin: ${e.message}`);
    }
  }

  async function handleUpdate(update) {
    const msg = update?.message;
    if (!msg || typeof msg.text !== 'string') return;
    const chatId = String(msg.chat?.id ?? '');
    const text = msg.text.trim();

    // Chưa cấu hình Admin: chỉ cho biết mã chat của chính người đang nhắn để họ điền vào .env.
    if (!adminId) {
      if (/^\/(start|id)\b/.test(text)) {
        await send(chatId, `Mã chat của bạn: ${chatId}\nĐặt TELEGRAM_ADMIN_CHAT_ID=${chatId} trong file .env rồi khởi động lại server.`);
      }
      return;
    }
    if (chatId !== adminId) return; // người lạ nhắn bot: bỏ qua hoàn toàn

    if (/^\/(start|id)\b/.test(text)) {
      await send(adminId, 'Bot chat hỗ trợ đang chạy. Khi khách nhắn, bạn sẽ nhận tin ở đây — bấm Trả lời vào tin đó để nhắn lại đúng khách.');
      return;
    }
    const replyTo = msg.reply_to_message?.message_id;
    if (!replyTo) {
      await send(adminId, '⚠️ Hãy bấm Trả lời (reply) vào tin của khách để mình biết nhắn cho ai.', { reply_parameters: { message_id: msg.message_id } });
      return;
    }
    const target = db.prepare('SELECT * FROM support_tg WHERE tg_message_id = ?').get(replyTo);
    if (!target) {
      await send(adminId, '⚠️ Không tìm thấy khách của tin này (tin quá cũ hoặc không phải tin khách). Hãy trả lời vào tin khách mới nhất.', {
        reply_parameters: { message_id: msg.message_id }
      });
      return;
    }
    const result = await onReply({ userId: target.user_id, sessionId: target.session_id, text });
    const note = result.ok
      ? `✅ Đã gửi cho ${target.username}`
      : `⚠️ Chưa gửi được cho ${target.username}: ${result.error}`;
    const confirm = await send(adminId, note, { reply_parameters: { message_id: msg.message_id } });
    // Trả lời tiếp vào dòng xác nhận cũng đi đúng khách này.
    if (result.ok) remember(confirm.message_id, target.user_id, target.session_id, target.username);
  }

  let stopped = false;
  let controller = null;

  async function poll() {
    let offset = 0;
    while (!stopped) {
      try {
        controller = new AbortController();
        const updates = await call('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] }, controller.signal);
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await handleUpdate(u);
          } catch (e) {
            log.warn?.(`[telegram] lỗi xử lý tin: ${e.message}`);
          }
        }
      } catch (e) {
        if (stopped) break;
        log.warn?.(`[telegram] mất kết nối, thử lại sau 5 giây: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000).unref?.());
      }
    }
  }

  return {
    notifyUserMessage,
    handleUpdate,
    start() {
      // Chỉ nhận cập nhật qua getUpdates: gỡ webhook cũ nếu có, rồi bắt đầu hỏi tin.
      call('deleteWebhook', {}).catch(() => {}).finally(() => poll());
      log.info?.(adminId ? '[telegram] bot hỗ trợ đang chạy' : '[telegram] chưa có TELEGRAM_ADMIN_CHAT_ID: nhắn /start cho bot để lấy mã');
    },
    stop() {
      stopped = true;
      controller?.abort();
    }
  };
}
