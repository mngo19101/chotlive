// Phát trang test "VTP Nháp Test" trong mạng Wi-Fi nhà, để mở bằng Safari trên iPhone.
// Chỉ gửi index.html và thư viện ký lib/p256.js; không gọi Viettel Post, không gọi ChotLive, không giữ dữ liệu gì.
//   node ios-vtp-nhap-test/web/serve.mjs        (cổng mặc định 5000, đổi bằng PORT=...)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const PORT = Number(process.env.PORT) || 5000;

http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/lib/p256.js': ['lib/p256.js', 'text/javascript'] };
  const f = files[p];
  if (!f) { res.statusCode = 404; return res.end('Không có'); }
  fs.readFile(path.join(dir, f[0]), (err, data) => {
    if (err) { res.statusCode = 500; return res.end('Lỗi đọc trang'); }
    res.setHeader('Content-Type', f[1] + '; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))
    .map((i) => i.address);
  console.log('Trang VTP Nháp Test đang phát. Mở trên iPhone (cùng Wi-Fi):');
  for (const ip of ips) console.log(`  http://${ip}:${PORT}`);
  console.log('Tắt: Ctrl+C');
});
