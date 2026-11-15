/** Địa chỉ server trong mạng nội bộ và in thẳng tới máy in nhiệt qua LAN. */
import net from 'node:net';
import os from 'node:os';
import express from 'express';
import { LAN_MODE, PORT } from '../config.js';
import { requireAuth, syncJson } from '../middleware.js';

const router = express.Router();

/** Địa chỉ trong mạng nội bộ để nhập trên điện thoại khi chạy server ở máy tính. */
function lanAddresses() {
  if (!LAN_MODE) return [];
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vmware|virtual|vethernet|vbox|wsl|docker|loopback|hyper-v|tailscale|zerotier/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address)) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

router.get('/api/server-info', requireAuth, (req, res) => {
  res.json({ ok: true, lanUrls: lanAddresses(), account: req.user.displayName || req.user.username });
});

// Endpoint in trực tiếp qua mạng LAN/WiFi tới máy in nhiệt cổng 9100
const isPrivateIPv4 = (ip) => {
  if (net.isIPv4(ip) !== true) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
};
// Máy in nhiệt nghe ở cổng 9100 (máy nhiều cổng dùng tới 9109); không cho gửi dữ liệu tới cổng dịch vụ khác.
const isPrinterPort = (p) => Number.isInteger(p) && p >= 9100 && p <= 9109;

router.post('/api/print-lan', requireAuth, syncJson, (req, res) => {
  if (!LAN_MODE) {
    return res.status(403).json({
      error: 'Máy chủ trên Internet không nối được máy in trong mạng của shop. Vui lòng in qua Bluetooth hoặc USB.',
      code: 'LAN_PRINT_DISABLED'
    });
  }
  const { ip, port = 9100, bytes } = req.body || {};
  if (!ip || !Array.isArray(bytes) || bytes.length === 0) {
    return res.status(400).json({ error: 'Thiếu ip hoặc bytes in' });
  }
  // Địa chỉ 127.x chỉ để test tự động (máy in giả chạy cùng máy); bình thường bị chặn.
  const loopbackForTest = process.env.PRINT_LAN_TEST_LOOPBACK === '1' && String(ip) === '127.0.0.1';
  if (!isPrivateIPv4(String(ip)) && !loopbackForTest) {
    return res.status(400).json({ error: 'IP máy in phải là địa chỉ mạng nội bộ (LAN)' });
  }
  const printerPort = Number(port);
  if (!isPrinterPort(printerPort)) {
    return res.status(400).json({ error: 'Cổng máy in phải từ 9100 đến 9109' });
  }

  const client = new net.Socket();
  client.setTimeout(5000);
  let done = false;
  const reply = (status, body) => {
    if (done) return;
    done = true;
    client.destroy();
    res.status(status).json(body);
  };

  client.connect(printerPort, String(ip), () => {
    client.write(Buffer.from(bytes), (err) => {
      if (err) return reply(500, { error: 'Gửi dữ liệu in thất bại: ' + err.message });
      client.end();
      reply(200, { ok: true, sentBytes: bytes.length });
    });
  });

  client.on('error', (err) => reply(500, { error: 'Không kết nối được máy in: ' + err.message }));
  client.on('timeout', () => reply(504, { error: 'Quá thời gian chờ máy in phản hồi' }));
});

export default router;
