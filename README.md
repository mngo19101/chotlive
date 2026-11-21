# ChốtLive – Chốt đơn TikTok Live (Web, App iPhone và Android)

Đọc bình luận TikTok Live theo thời gian thực, tự bắt giá, chạm để in tem nhiệt 80mm (Xprinter Q80BS), gộp đơn theo khách, quản lý doanh số và xuất file CSV.

Web, App iPhone và App Android đồng bộ qua server: thao tác trên máy này thì máy kia cập nhật ngay, miễn là cả hai dùng **cùng một server và cùng một tài khoản**.

---

## 1. Chạy trên máy tính

```powershell
npm.cmd install
npm.cmd start
```

Mở http://localhost:3000 trên máy tính. `localhost` chỉ mở được trên chính máy đó. Điện thoại cùng Wi-Fi dùng địa chỉ IP LAN, xem trên web ở **Tôi › Đồng bộ Web & App (IPA)**.

**Tự chạy server khi bật máy:** bấm đúp `scripts\cai-tu-chay-server.cmd` và chọn **Yes**. Server sẽ tự chạy (không hiện cửa sổ) mỗi khi đăng nhập Windows, tự bật lại nếu bị tắt, và cổng 3000 được mở cho điện thoại cùng Wi-Fi hoặc Tailscale. Nếu điện thoại dùng địa chỉ Tailscale Funnel (`https://<tên-máy>.<tailnet>.ts.net`) thì không cần chọn **Yes**, vì Funnel chuyển kết nối vào ngay trên máy. Nhật ký ở `data\server.log`. Khi đã cài thì đừng chạy thêm `npm start`, vì hai server sẽ tranh cổng 3000. Muốn gỡ: `powershell -ExecutionPolicy Bypass -File scripts\cai-tu-chay-server.ps1 -Uninstall`.

Muốn in qua mạng LAN, đặt `LAN_MODE=1` trong file `.env`. Chỉ bật khi server chạy cùng mạng với máy in, không bật trên VPS. Các biến khác xem trong [.env.example](.env.example).

Chạy test (dùng TikTok giả trong `test/fake-tiktok`, không gọi mạng thật):

```powershell
npm.cmd test
```

---

## 2. Đưa server lên mạng

- **VPS (nên dùng):** làm theo [deploy/README.md](deploy/README.md).
- **Render:** vào https://render.com, chọn **New › Blueprint** rồi chọn repo. Render tự đọc [render.yaml](render.yaml). Cấu hình này dùng gói trả phí, vì cần ổ đĩa riêng để không mất dữ liệu khi khởi động lại.

---

## 3. Cài App lên iPhone

App được viết bằng SwiftUI trong thư mục `ios-native/` và build trên GitHub Actions.

### Lấy file IPA

1. Vào tab **Actions** của repo, chọn workflow **Build iOS IPA native (ChốtLive SwiftUI)**. Workflow tự chạy khi có thay đổi trong `ios-native/`, hoặc bấm **Run workflow** để chạy tay.
2. Khi chạy xong, tải **ChotLive-Native-IPA** ở mục **Artifacts**. Trong đó là file `ChotLive-Native.ipa`.

Muốn gắn sẵn địa chỉ server vào app, tạo biến `CHOTLIVE_SERVER_URL` ở **Settings › Secrets and variables › Actions › Variables**, rồi build lại.

### Cài vào iPhone

File IPA chưa được ký, công cụ cài đặt sẽ ký lại. Có thể dùng một trong các công cụ sau:

- **Sideloadly** (Windows/Mac): cắm cáp iPhone, kéo file IPA vào, nhập Apple ID rồi bấm **Start**. Sau đó trên iPhone vào **Cài đặt › Cài đặt chung › Quản lý VPN & Thiết bị** và bấm **Tin cậy**.
- **AltStore / SideStore:** mở file IPA ngay trên iPhone.
- **ESign:** cài trực tiếp trên iPhone bằng chứng chỉ của bạn.

App cài bằng Apple ID miễn phí sẽ hết hạn sau 7 ngày và phải cài lại.

### Kết nối App với server

Mở App và đăng nhập. Nếu bản IPA chưa gắn sẵn địa chỉ server, nhập địa chỉ ở màn đăng nhập, ví dụ `https://ten-mien-cua-ban.vn` hoặc `http://192.168.1.x:3000`.

### Kết nối máy in

Vào **Tôi › Máy in › Tìm máy in**, chọn máy rồi bấm **In thử**. App trên iPhone chỉ nối được máy in có **Bluetooth LE**, không dùng được máy chỉ có Bluetooth Classic (SPP). Hãy kiểm tra thông số máy trước khi mua.

---

## 4. Cài App lên Android

App viết bằng Kotlin và Jetpack Compose trong thư mục `android/`, cùng màn hình và cùng tài khoản với bản iPhone. Cách build APK, khoá ký app và chạy test xem ở [android/README.md](android/README.md).

### Cài vào điện thoại

1. Gửi file `app-release.apk` sang điện thoại, qua Zalo, Google Drive hoặc cáp USB.
2. Mở file APK trên điện thoại. Lần đầu Android sẽ hỏi có cho phép cài app từ nguồn này không, chọn **Cho phép**.
3. Bản mới cài đè lên bản cũ và giữ nguyên dữ liệu, miễn là cùng khoá ký.

### Kết nối App với server

Mở App và đăng nhập. Nếu bản APK chưa gắn sẵn địa chỉ server, nhập địa chỉ ở màn đăng nhập, giống bản iPhone. Cách gắn sẵn địa chỉ khi build xem ở [android/README.md](android/README.md#gắn-sẵn-địa-chỉ-server).

### Kết nối máy in

Vào **Tôi › Máy in › Tìm máy in**, chọn máy rồi bấm **In thử**. Khác bản iPhone, app Android nối được cả máy in **Bluetooth LE** lẫn máy chỉ có **Bluetooth Classic (SPP)**. Máy Classic nên ghép đôi trước trong **Cài đặt › Bluetooth** của điện thoại.

---

## 5. Sao lưu

- **Google Drive (nên bật trên mọi máy):** mỗi ngày một bản đã mã hoá, có cảnh báo Telegram khi bị trễ. Xem [backup/README.md](backup/README.md).
- **Laptop và mini PC:** xem [sync/README.md](sync/README.md).
- **VPS:** xem mục sao lưu trong [deploy/README.md](deploy/README.md).

---

## 6. Quên mật khẩu admin

`ADMIN_PASSWORD` chỉ có tác dụng khi tạo dữ liệu lần đầu. Muốn đặt lại mật khẩu sau đó:

1. Tắt server.
2. Thêm dòng `ADMIN_PASSWORD=mật-khẩu-mới` vào `.env`.
3. Chạy lệnh dưới đây, rồi bật lại server:

   ```powershell
   node --env-file=.env scripts/reset-admin.mjs
   ```

4. Đăng nhập thử bằng mật khẩu mới, rồi xoá dòng `ADMIN_PASSWORD` khỏi `.env`.

---

## 7. Dùng thử và gói

- Tài khoản mới được **3 ngày dùng thử**. Hết hạn thì không theo dõi được live (live đang chạy cũng dừng); đơn hàng, khách hàng, in tem và lịch sử bình luận vẫn dùng bình thường.
- **Cấp gói:** đăng nhập admin, vào **Tôi → Quản lý Tài khoản**, bấm **Cấp gói** ở tài khoản cần cấp. Gói còn hạn, hoặc tài khoản còn dùng thử, thì gói mới được cộng nối tiếp sau ngày hết hạn đó. Một tháng tính là 30 ngày.
- **Mỗi IP chỉ tự đăng ký được 2 tài khoản**, xoá tài khoản không trả lại lượt. Khách dùng chung IP (4G, cùng công ty) mà hết lượt thì admin tạo tài khoản giúp ở nút **Tạo tài khoản mới**.
- Đặt đúng `TRUST_PROXY` (xem `.env.example`), nếu không mọi khách sẽ bị tính chung một IP.

---

## 8. Cấu trúc dự án

| Đường dẫn | Vai trò |
|---|---|
| `server.js` | Điểm khởi động: ghép các phần trong `server/` lại và chạy server |
| `server/config.js`, `server/database.js` | Cấu hình từ biến môi trường và CSDL SQLite dùng chung |
| `server/accounts.js`, `server/states.js` | Tài khoản, token đăng nhập và dữ liệu của từng tài khoản |
| `server/hub.js`, `server/ws.js` | WebSocket: gửi tin tới thiết bị và xử lý từng kết nối |
| `server/device-sync.js`, `server/live.js` | Nhận dữ liệu từ web và app; theo dõi TikTok Live |
| `server/backup-watch.js` | Tự sao lưu mỗi ngày và báo Telegram khi sao lưu bị trễ |
| `server/routes/` | Các API, mỗi nhóm một file: `auth` (đăng nhập), `admin`, `support` (chat hỗ trợ), `sync` (đồng bộ), `vtp` (Viettel Post), `lan` (in LAN) |
| `access.js` | Dùng thử, gói và cách tính IP khi giới hạn tạo tài khoản |
| `live-manager.js` | Kết nối và theo dõi các phiên TikTok Live |
| `native-sync.js`, `delta.js` | Đồng bộ dữ liệu giữa server và các máy |
| `db.js` | Lưu dữ liệu bằng SQLite |
| `validate.js`, `rate-limit.js` | Kiểm tra dữ liệu gửi lên và giới hạn số lần gọi |
| `public/` | Giao diện web |
| `ios-native/` | App iPhone viết bằng SwiftUI |
| `android/` | App Android viết bằng Kotlin và Jetpack Compose |
| `deploy/` | Cài đặt lên VPS |
| `sync/` | Đồng bộ dữ liệu giữa laptop và mini PC |
| `backup/` | Sao lưu có mã hoá lên Google Drive và khôi phục |
| `scripts/reset-admin.mjs` | Đặt lại mật khẩu admin |
| `test/` | Test server và logic web |
| `.github/workflows/` | Chạy test và build IPA trên GitHub Actions |
