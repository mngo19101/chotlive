# Sao lưu lên Google Drive

Mục đích: máy chạy server hỏng, mất, cháy hay bị virus mã hoá thì vẫn còn một bản dữ liệu ở nơi khác để lấy lại.

- **Mỗi ngày một bản.** Server tự làm, không cần hẹn giờ riêng. Máy tắt qua đêm thì bản sao được tạo khoảng 1 phút sau khi server chạy lại.
- **Đã mã hoá trước khi rời máy.** File trên Google Drive không đọc được nếu không có mật khẩu sao lưu, kể cả với Google hay người vào được tài khoản Google của bạn.
- **Giữ 30 bản mới nhất** trên Drive, bản cũ hơn tự dọn.
- **Báo qua Telegram khi bị trễ.** Quá 36 giờ không có bản sao mới, bot Telegram (bot chat hỗ trợ đang dùng) nhắn cho Admin kèm lý do, mỗi ngày nhắc một lần cho tới khi sao lưu chạy lại.

Việc đẩy file lên Drive dùng [rclone](https://rclone.org), một chương trình miễn phí. Bạn đăng nhập Google một lần trên trình duyệt, rclone giữ quyền truy cập từ đó. rclone chỉ được phép thấy những file do chính nó tạo, không đọc được file khác trong Drive của bạn.

## Cài đặt trên máy Windows (laptop, mini PC)

Làm trên máy đang chạy server, bằng đúng tài khoản Windows mà server chạy.

**Bước 1: Cài rclone.** Mở PowerShell và chạy:

```powershell
winget install Rclone.Rclone
```

Đóng PowerShell rồi mở lại để nhận lệnh `rclone`.

**Bước 2: Đăng nhập Google Drive.**

```powershell
rclone config create gdrive drive scope=drive.file
```

Trình duyệt mở ra, chọn tài khoản Google rồi bấm **Cho phép**. Kiểm tra lại bằng lệnh dưới, không báo lỗi là được:

```powershell
rclone lsd gdrive:
```

**Bước 3: Đặt mật khẩu sao lưu.** Mở file `.env` trong thư mục dự án (chưa có thì chép từ `.env.example`), thêm hai dòng:

```
BACKUP_RCLONE_REMOTE=gdrive:ChotLive-SaoLuu
BACKUP_PASSPHRASE=mot-cau-dai-chi-minh-ban-biet-2026
```

Mật khẩu sao lưu dài ít nhất 12 ký tự, không dùng dấu cách, dấu nháy hay dấu `#`.

> **Ghi mật khẩu sao lưu ra một nơi ngoài máy này**: giấy cất trong nhà, ghi chú trên điện thoại, hoặc trình quản lý mật khẩu. Máy hỏng mà không còn mật khẩu này thì các bản sao trên Drive không mở được, và không ai khôi phục giúp được.

**Bước 4: Sao lưu thử và khôi phục thử.**

```powershell
npm.cmd run backup:now
```

```powershell
npm.cmd run backup:test-restore
```

Lệnh thứ hai tải bản vừa đẩy lên về, giải mã, kiểm tra và in số tài khoản, đơn hàng, khách hàng trong đó. Nó không đụng tới dữ liệu đang dùng. Thấy dòng `Kết luận: bản sao này khôi phục được` là xong. Mở Google Drive sẽ thấy thư mục `ChotLive-SaoLuu`.

**Bước 5: Khởi động lại máy** để server nhận cấu hình mới và tìm thấy rclone. Khoảng 1 phút sau khi server chạy, bot Telegram nhắn `đã bật sao lưu lên đám mây`. Nhận được tin này nghĩa là cả sao lưu tự động lẫn cảnh báo đều hoạt động.

Chưa có bot Telegram thì sao lưu vẫn chạy, nhưng cảnh báo trễ chỉ ghi vào `data\server.log`. Cách tạo bot xem phần `TELEGRAM_BOT_TOKEN` trong `.env.example`.

## Cài đặt trên VPS

Server trên VPS chạy bằng người dùng `chotlive`, nên rclone phải được đăng nhập bằng người dùng đó.

```bash
curl https://rclone.org/install.sh | sudo bash
```

```bash
sudo -H -u chotlive rclone config
```

Trong phần hỏi đáp: tạo kết nối mới tên `gdrive`, loại `drive`, quyền truy cập chọn `drive.file`, các câu khác để mặc định. VPS không có trình duyệt nên ở câu hỏi dùng trình duyệt để đăng nhập hãy trả lời **không**; rclone sẽ in một lệnh `rclone authorize ...` để chạy trên máy tính có trình duyệt (máy đó cũng cần cài rclone), rồi dán kết quả trở lại. Chi tiết xem [hướng dẫn của rclone](https://rclone.org/remote_setup/).

Thêm hai dòng `BACKUP_RCLONE_REMOTE` và `BACKUP_PASSPHRASE` như ở trên vào `/etc/chotlive.env`, rồi:

```bash
sudo chown root:chotlive /etc/chotlive.env && sudo chmod 640 /etc/chotlive.env
```

```bash
sudo systemctl restart chotlive
```

Các lệnh bằng tay trên VPS chạy theo mẫu sau (đổi `test-restore` thành `run`, `list`, `status`):

```bash
cd /opt/chotlive && sudo -H -u chotlive env DATA_DIR=/var/lib/chotlive node --env-file=/etc/chotlive.env --no-warnings backup/cloud-backup.mjs test-restore
```

Bản sao mỗi đêm trên chính VPS (xem `deploy/README.md`) vẫn chạy như cũ.

## Các lệnh

Trên Windows gõ `npm.cmd` thay cho `npm`.

| Lệnh | Việc làm |
|---|---|
| `npm run backup:status` | Xem lần sao lưu gần nhất và lỗi gần nhất |
| `npm run backup:now` | Sao lưu ngay một bản |
| `npm run backup:list` | Liệt kê các bản đang có trên Drive |
| `npm run backup:test-restore` | Tải bản mới nhất về kiểm tra, không thay dữ liệu đang dùng |
| `npm run backup:restore -- --yes` | Thay dữ liệu đang dùng bằng bản mới nhất (phải tắt server trước) |

Muốn dùng một bản cũ hơn, ghi tên file lấy từ `backup:list` vào sau lệnh, ví dụ `npm run backup:restore -- chotlive-20261115-030000.db.gz.enc --yes`.

**Nên chạy `backup:test-restore` mỗi tháng một lần.** Bản sao chỉ đáng tin khi đã thử lấy lại được.

## Khi máy hỏng: khôi phục sang máy mới

1. Cài [Node.js](https://nodejs.org) bản 22.13 trở lên và tải dự án về máy mới, chạy `npm install`.
2. Làm lại bước 1 và 2 ở trên (cài rclone, đăng nhập đúng tài khoản Google cũ).
3. Tạo file `.env` với hai dòng `BACKUP_RCLONE_REMOTE` và `BACKUP_PASSPHRASE` **giống hệt máy cũ**.
4. Khi server chưa chạy, khôi phục rồi mới bật server:

```powershell
npm.cmd run backup:restore -- --yes
```

Tài khoản, mật khẩu đăng nhập, đơn hàng, khách hàng và bình luận đều trở lại như lúc tạo bản sao. Phần mất là những thay đổi sau bản sao gần nhất, tối đa khoảng một ngày.

Khôi phục vào máy đang có dữ liệu thì dữ liệu cũ không bị xoá: nó được giữ trong `data/sync/before-replace`.

## Những gì bản sao không có

- **Thay đổi sau bản sao gần nhất.** Muốn mất ít hơn, đặt `BACKUP_EVERY_HOURS=6` trong `.env` để sao lưu 6 giờ một lần.
- **Kết nối Viettel Post.** Sau khi khôi phục sang máy mới, mỗi shop dán lại token Viettel Post một lần.
- **File `.env`.** Trong đó có mật khẩu sao lưu, nên không thể nằm trong chính bản sao. Hãy giữ một bản `.env` ở nơi khác.

## Khi nào không có cảnh báo

Cảnh báo do server gửi. Nếu máy chạy server tắt hẳn hoặc mất mạng thì không có gì gửi được. Lúc đó web và app cũng không vào được, bạn sẽ biết ngay. Khi máy chạy lại, server tự sao lưu bù.

## Tuỳ chỉnh

Các dòng dưới đây đặt trong `.env`, đều không bắt buộc:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `BACKUP_EVERY_HOURS` | 24 | Bao lâu sao lưu một lần |
| `BACKUP_ALERT_HOURS` | 36 | Quá bao lâu không có bản mới thì báo Telegram |
| `BACKUP_KEEP` | 30 | Số bản giữ trên Drive |
| `BACKUP_RCLONE_PATH` | `rclone` | Đường dẫn tới file rclone, dùng khi server không tự tìm thấy |
| `BACKUP_RCLONE_CONFIG` | (của rclone) | Đường dẫn file cấu hình rclone, nếu không để ở chỗ mặc định |

Tình trạng lần sao lưu gần nhất nằm ở `data/cloud-backup-status.json`.
