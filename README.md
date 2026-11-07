# ChốtLive (Susu) – Chốt đơn TikTok Live (Web & App iPhone IPA đồng bộ thời gian thực)

Nền tảng đọc bình luận TikTok Live theo thời gian thực, tự bắt giá, chạm để in tem nhiệt 80mm (Xprinter Q80BS), gộp đơn theo khách, quản lý doanh số và xuất báo cáo Excel/CSV.

Hỗ trợ **đồng bộ 2 chiều thời gian thực (Real-time Sync)** giữa **bản Web trên mạng** và **App iPhone cài qua file `.ipa`**:
- Trên **Web** bấm tạo đơn, sửa đơn, in đơn, đổi trạng thái giao hàng, sửa địa chỉ khách hoặc chọn khách → **App trên điện thoại hiển thị & cập nhật ngay lập tức**.
- Trên **App iPhone (IPA)** ấn thao tác → **Web cũng tự động cập nhật tức thì**.

---

## 1. Chạy cục bộ trên máy tính

```powershell
npm.cmd install
npm.cmd start
```
Mở http://localhost:3000 trên trình duyệt máy tính hoặc mở trên điện thoại qua địa chỉ IP mạng LAN (ví dụ `http://192.168.1.x:3000`).

Web và điện thoại chỉ đồng bộ khi dùng **cùng một server và cùng một tài khoản**. `localhost` chỉ mở được trên chính máy tính đó; trên điện thoại phải nhập IP LAN (xem trong Tôi › Đồng bộ trên web) hoặc địa chỉ server đã đưa lên mạng.

Chạy test: `npm test` (dùng TikTok giả trong `test/fake-tiktok`, không gọi mạng thật).

---

## 2. Đưa Web & Server Đồng Bộ lên mạng (Render / Railway)

1. Đẩy toàn bộ thư mục này lên một repository **GitHub**.
2. Vào https://render.com → **New → Blueprint** → chọn repo GitHub (Render tự đọc `render.yaml`).
   Hoặc chọn **New → Web Service**: Build Command `npm install`, Start Command `npm start`.
3. Sau khi hoàn tất, bạn sẽ có địa chỉ Web & Server đồng bộ (ví dụ: `https://susu-live-order.onrender.com`).

---

## 3. Xuất file `.ipa` và cài App lên iPhone

Dự án đã tích hợp sẵn cấu hình **Capacitor iOS** ([capacitor.config.json](file:///c:/Users/mnhti/Downloads/tiktok/capacitor.config.json)) và quy trình tự động biên dịch file `.ipa` trên đám mây macOS qua **GitHub Actions** ([.github/workflows/build-ipa.yml](file:///c:/Users/mnhti/Downloads/tiktok/.github/workflows/build-ipa.yml)):

### Bước 1: Tải file `ChotLive-iOS.ipa`
1. Sau khi đẩy code lên GitHub, vào tab **Actions** trên repo GitHub của bạn.
2. Chọn workflow **Build iOS IPA (ChốtLive)** → bấm **Run workflow** (có thể nhập sẵn link Render của bạn vào ô `server_url`).
3. Đợi khoảng 2–3 phút để máy chủ macOS biên dịch xong → kéo xuống mục **Artifacts** và tải file **`ChotLive-iOS-IPA.zip`** (bên trong là file `ChotLive-iOS.ipa`).

### Bước 2: Cài file `.ipa` vào iPhone
Bạn có thể cài file `ChotLive-iOS.ipa` vào iPhone bằng một trong các công cụ phổ biến sau:
- **Sideloadly** (trên Windows/Mac): Cắm cáp iPhone vào máy tính, mở Sideloadly, kéo thả file `ChotLive-iOS.ipa` vào, nhập Apple ID miễn phí và bấm **Start** (trên iPhone vào *Cài đặt → Cài đặt chung → Quản lý VPN & Thiết bị* bấm **Tin cậy**).
- **AltStore / SideStore**: Mở file `.ipa` trực tiếp trên iPhone qua AltStore/SideStore.
- **TrollStore / ESign / Scarlet / Chứng chỉ P12**: Cài trực tiếp ngay trên iPhone không cần máy tính.

### Bước 3: Kết nối đồng bộ giữa App IPA và Web
1. Mở App **ChốtLive** trên iPhone → vào mục **Tôi → Đồng bộ Web & App (IPA)**.
2. Nhập địa chỉ Web bạn đã đưa lên mạng (ví dụ `https://susu-live-order.onrender.com` hoặc IP LAN `http://192.168.1.x:3000`) rồi bấm **Lưu & Kết nối**.
3. Từ lúc này, cả Web và App iPhone sẽ trao đổi thông tin thời gian thực với nhau (hiển thị số thiết bị đang kết nối ở mục **Đồng bộ Web & App**).

---

## 4. Sao lưu sang mini PC

Laptop tự đồng bộ dữ liệu với mini PC mỗi khi bật máy, để máy này hỏng thì còn máy kia. Cách thêm mini PC và khôi phục dữ liệu: xem [sync/README.md](sync/README.md).

---

## 5. Cấu trúc dự án

| File | Vai trò |
|---|---|
| `server.js` | Server Node.js + WebSocket Sync Hub (`/ws`) + REST API (`/api/state`, `/api/sync`) + Kết nối TikTok Live |
| `public/index.html` | Giao diện chuẩn 9 màn hình Mobile & Desktop (Doanh số, Bình luận, Khách hàng, Đơn hàng, Tôi) |
| `public/css/style.css` | Thiết kế giao diện chuẩn UI/UX Mobile App (Bottom Sheet, Safe-area iPhone, Card bo tròn) & Web |
| `public/js/sync.js` | Engine đồng bộ 2 chiều thời gian thực giữa Web và App IPA qua WebSocket + HTTP fallback |
| `public/js/store.js` | Quản lý trạng thái đơn hàng, khách hàng, bình luận, phiên live & kích hoạt đồng bộ tự động |
| `public/js/app.js` | Điều khiển giao diện, sự kiện tương tác, đồng bộ UI tức thì và in tem Xprinter |
| `sync/` | Đồng bộ dữ liệu giữa laptop và mini PC |
| `capacitor.config.json` | Cấu hình đóng gói ứng dụng iOS Native |
| `.github/workflows/build-ipa.yml` | Tự động biên dịch và xuất file `ChotLive-iOS.ipa` trên GitHub Actions |
