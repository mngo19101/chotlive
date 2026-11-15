/**
 * Susu Live Order / ChốtLive – Server, Auth, Admin & Real-Time Sync Hub (Web <-> iOS IPA App)
 * - Hệ thống Đăng nhập / Đăng ký (Chỉ cần Tên tài khoản + Mật khẩu + Xác nhận mật khẩu)
 * - Phân quyền:
 *   + Tài khoản Admin riêng (mật khẩu đặt qua ADMIN_PASSWORD, xem .env.example) quản lý toàn bộ tài khoản:
 *     Xem danh sách, Tạo mới, Khoá / Mở khoá tài khoản (đẩy văng tức thì nếu đang online), Đổi mật khẩu, Xoá tài khoản.
 *   + Tài khoản Thành viên (user): sử dụng đầy đủ tính năng chốt đơn, in tem, đồng bộ Web <-> App IPA.
 *     Theo dõi live cần còn hạn dùng thử hoặc có gói do Admin cấp (xem access.js).
 * - Lưu trữ và đồng bộ dữ liệu thời gian thực theo từng tài khoản qua WebSocket (/ws) + REST API.
 *
 * File này chỉ ghép các phần lại và khởi động server. Mã nằm trong thư mục server/:
 *   config, database, accounts, states  – cấu hình, CSDL, tài khoản, dữ liệu từng tài khoản
 *   hub, device-sync, live, ws          – WebSocket, nhận dữ liệu từ thiết bị, TikTok Live
 *   routes/                             – các API: auth, support, admin, sync, lan, vtp
 */
import path from 'node:path';
import express from 'express';
import { securityHeaders } from './security-headers.js';
import { parseTrustProxy } from './access.js';
import { HOST, PORT, ROOT_DIR } from './server/config.js';
import { flushUsersDb } from './server/accounts.js';
import { flushStates } from './server/states.js';
import { app, server } from './server/app.js';
import { wss } from './server/hub.js';
import { liveManager, resumeLivesAfterRestart } from './server/live.js';
import { startWebSocket } from './server/ws.js';
import { vtpWards } from './server/vtp-stores.js';
import { smallJsonExceptBigPaths } from './server/middleware.js';
import authRoutes from './server/routes/auth.js';
import supportRoutes, { telegram } from './server/routes/support.js';
import adminRoutes from './server/routes/admin.js';
import syncRoutes from './server/routes/sync.js';
import lanRoutes from './server/routes/lan.js';
import vtpRoutes from './server/routes/vtp.js';

function flushAllAndExit() {
  liveManager.stopAll();
  flushStates();
  flushUsersDb();
  process.exit(0);
}
process.on('SIGTERM', flushAllAndExit);
process.on('SIGINT', flushAllAndExit);
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => {
  // Lỗi lọt qua mọi lớp chặn: ghi nốt dữ liệu rồi thoát để nền tảng khởi động lại server sạch.
  console.error('[uncaughtException]', err);
  try {
    flushStates();
    flushUsersDb();
  } catch {}
  process.exit(1);
});

/* ============================================================
   Express Server & Middleware
   ============================================================ */

app.disable('x-powered-by');
// Mặc định chỉ tin IP do Caddy trên cùng máy báo lại; người ngoài không giả IP được để né giới hạn.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(securityHeaders);

// Gói lớn chỉ nhận ở API đồng bộ và in LAN, và chỉ sau khi đã kiểm tra token (xem từng route).
// Các API khác, nhất là đăng nhập/đăng ký ai cũng gọi được, không phải đọc gói 10MB của người lạ.
app.use(smallJsonExceptBigPaths);

app.use(
  express.static(path.join(ROOT_DIR, 'public'), {
    extensions: ['html'],
    etag: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store');
    }
  })
);

app.get('/healthz', (_req, res) =>
  res.json({
    ok: true,
    time: Date.now(),
    clients: wss.clients.size
  })
);

// Mỗi nhóm API nằm trong một file ở server/routes/. Thêm API mới thì sửa đúng file của nhóm đó.
app.use(authRoutes);
app.use(supportRoutes);
app.use(adminRoutes);
app.use(syncRoutes);
app.use(lanRoutes);
app.use(vtpRoutes);

startWebSocket();

server.listen(PORT, HOST, () => {
  console.log(`Susu Live Order đang chạy: http://${HOST || 'localhost'}:${PORT}`);
  resumeLivesAfterRestart();
  telegram?.start();
  if (process.env.NODE_ENV !== 'test') setTimeout(() => vtpWards.warm(), 15000).unref();
});
