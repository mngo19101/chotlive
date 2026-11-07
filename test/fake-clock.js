/**
 * Đồng hồ giả khi chạy thử: tua server tới 3 ngày sau mà không phải chờ và không cần cửa hậu trong server.js.
 * Lệch ban đầu lấy từ FAKE_CLOCK_OFFSET_MS; test gửi { clockOffset } qua IPC để tua tiếp.
 */
const realNow = Date.now.bind(Date);
let offset = Number(process.env.FAKE_CLOCK_OFFSET_MS) || 0;

Date.now = () => realNow() + offset;

process.on('message', (msg) => {
  if (typeof msg?.clockOffset !== 'number') return;
  offset = msg.clockOffset;
  process.send?.({ clockSet: offset });
});
