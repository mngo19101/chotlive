# Đưa ChốtLive lên VPS

Sau khi làm xong, người dùng ở bất kỳ đâu cũng đăng ký và dùng được qua `https://tên-miền-của-bạn`, không còn phụ thuộc vào laptop.

## Cần chuẩn bị

- VPS Ubuntu 22.04 hoặc 24.04, tối thiểu 2 GB RAM.
- Một tên miền. **Bắt buộc phải có**, vì app chỉ gửi mật khẩu qua HTTPS và chứng chỉ HTTPS cấp theo tên miền.
- Ở trang quản lý tên miền, tạo bản ghi `A` trỏ tên miền về IP của VPS, rồi đợi vài phút.

### Nếu dùng Oracle Cloud (gói miễn phí)

- Chọn hình ảnh Ubuntu 22.04 hoặc 24.04. Ưu tiên máy ARM (Ampere A1); máy AMD 1 GB vẫn chạy được nhờ swap nhưng chậm.
- Trên trang Oracle: **Networking › Virtual Cloud Networks › (mạng của bạn) › Security Lists › Add Ingress Rules**, thêm hai luật nguồn `0.0.0.0/0`, giao thức TCP, cổng `80` và `443`. Script chỉ mở được tường lửa trong máy, không mở được phần này.
- Máy miễn phí có thể bị Oracle thu hồi. Luôn tải bản sao lưu về máy khác.

## 1. Tải code về VPS

Repo đang để riêng tư nên VPS cần một khoá để tải. Đăng nhập VPS rồi chạy:

```bash
sudo ssh-keygen -t ed25519 -N "" -f /root/.ssh/chotlive_deploy
```

```bash
sudo cat /root/.ssh/chotlive_deploy.pub
```

Chép dòng vừa hiện vào GitHub: repo `chotlive` › **Settings › Deploy keys › Add deploy key** (không cần tick quyền ghi). Sau đó:

```bash
sudo GIT_SSH_COMMAND="ssh -i /root/.ssh/chotlive_deploy -o StrictHostKeyChecking=accept-new" git clone --branch master git@github.com:mngo19101/chotlive.git /opt/chotlive
```

Đổi `master` thành tên nhánh khác nếu code mới chưa được gộp vào `master`.

## 2. Cài đặt

```bash
sudo bash /opt/chotlive/deploy/setup.sh ten-mien-cua-ban.vn
```

Script cài Node.js và Caddy (tự lấy HTTPS), tạo dịch vụ tự khởi động, mở tường lửa và đặt lịch sao lưu mỗi đêm. Cuối cùng nó **in mật khẩu admin một lần duy nhất**, hãy lưu lại.

Kiểm tra bằng trình duyệt: mở `https://ten-mien-cua-ban.vn/healthz` phải thấy `"ok":true`.

## 3. (Tuỳ chọn) Chuyển dữ liệu cũ từ laptop

Bỏ qua nếu muốn bắt đầu với dữ liệu trống. Nếu chuyển, các tài khoản và mật khẩu cũ giữ nguyên, kể cả admin: mật khẩu in ở bước 2 sẽ không còn tác dụng.

Tắt server trên laptop trước, rồi chạy trên laptop:

```bash
scp data/susu.db root@IP_VPS:/tmp/susu.db
```

Trên VPS:

```bash
sudo systemctl stop chotlive
```

```bash
sudo install -o chotlive -g chotlive -m 640 /tmp/susu.db /var/lib/chotlive/susu.db
```

```bash
sudo rm -f /var/lib/chotlive/susu.db-wal /var/lib/chotlive/susu.db-shm /tmp/susu.db
```

```bash
sudo systemctl start chotlive
```

## 4. Build app với địa chỉ server

Trên GitHub: **Settings › Secrets and variables › Actions › Variables**, tạo biến `CHOTLIVE_SERVER_URL` = `https://ten-mien-cua-ban.vn`. Từ đó mọi bản IPA đều gắn sẵn địa chỉ này và màn đăng nhập không còn ô nhập server.

Chạy lại workflow **Build iOS IPA native** trong tab Actions để lấy IPA mới.

Máy đang đăng nhập vào server cũ (địa chỉ `192.168.x.x`) cần đăng xuất rồi đăng nhập hoặc đăng ký lại.

## 5. Thử thật trước khi phát hành

Dùng điện thoại **tắt Wi-Fi, chỉ bật 4G**:

1. Đăng ký một tài khoản mới trên app.
2. Mở web `https://ten-mien-cua-ban.vn` trên máy tính, đăng nhập cùng tài khoản. Tạo một đơn và xem app có cập nhật ngay không.
3. Vào một phiên TikTok đang live, xem bình luận có về không. **Đây là bước dễ gặp lỗi nhất:** TikTok có thể chặn IP của máy chủ thuê, và máy chủ ký miễn phí giới hạn lượt kết nối. Nếu báo lỗi giới hạn, đăng ký key ở [eulerstream.com](https://www.eulerstream.com), điền vào `SIGN_API_KEY` trong `/etc/chotlive.env` rồi `sudo systemctl restart chotlive`.
4. Khởi động lại VPS (`sudo reboot`), xem server có tự chạy lại và dữ liệu còn nguyên không.

## Cập nhật phiên bản mới

Nếu `/opt/chotlive` là thư mục git (cài theo bước 1):

```bash
cd /opt/chotlive && sudo GIT_SSH_COMMAND="ssh -i /root/.ssh/chotlive_deploy" git pull && sudo npm ci --omit=dev && sudo chmod -R a+rX . && sudo systemctl restart chotlive
```

Nên làm ngoài giờ live. Server tự nối lại các live đang theo dõi sau khi khởi động, nhưng có thể lỡ vài giây bình luận.

### Cập nhật từ máy tính (VPS không có git)

Dùng khi code trên VPS được chép lên chứ không `git clone`. Mọi lệnh chạy trong PowerShell trên máy tính, ở thư mục dự án, đúng nhánh muốn đưa lên. Thay `KHOA` bằng đường dẫn file `.pem` và `IP` bằng địa chỉ VPS.

**1. Đưa code mới lên và chuẩn bị** (server vẫn chạy, không gián đoạn):

```powershell
git archive --format=tar -o "$env:TEMP\chotlive.tar" HEAD
```

```powershell
scp -i KHOA "$env:TEMP\chotlive.tar" ubuntu@IP:/tmp/chotlive.tar
```

```powershell
ssh -i KHOA ubuntu@IP "sudo rm -rf /opt/chotlive-new && sudo mkdir -p /opt/chotlive-new && sudo tar -xf /tmp/chotlive.tar -C /opt/chotlive-new && sudo bash /opt/chotlive-new/deploy/update.sh prepare"
```

Bước này cài thư viện vào `/opt/chotlive-new`, chụp một bản sao CSDL vào `/var/backups/chotlive`, và tạo `VTP_SECRET_KEY` nếu chưa có. Thấy `SẴN SÀNG` là xong.

**2. Đổi sang code mới** (vài giây gián đoạn, làm lúc không có live):

```powershell
ssh -i KHOA ubuntu@IP "sudo bash /opt/chotlive-new/deploy/update.sh switch"
```

Script tắt server, đổi thư mục, bật lại, rồi đợi xem server có đứng vững không. Không lên thì nó tự quay về code cũ và báo lỗi.

**3. Quay lại code cũ** nếu sau đó thấy có gì không ổn:

```powershell
ssh -i KHOA ubuntu@IP "sudo bash /opt/chotlive/deploy/update.sh rollback"
```

Code cũ được giữ ở `/opt/chotlive-old` cho tới lần cập nhật sau. Quay lại không làm mất dữ liệu; kết nối Viettel Post được trả về bản chưa mã hoá mà code cũ đọc được.

## Sao lưu và khôi phục

Bản sao nằm ở `/var/backups/chotlive`, tạo lúc 3 giờ sáng (giờ VPS), giữ 5 bản. **Các bản này vẫn nằm trên cùng VPS**, nên VPS hỏng là mất cả. Hãy bật sao lưu lên Google Drive theo [backup/README.md](../backup/README.md): mỗi ngày một bản đã mã hoá, có cảnh báo Telegram khi bị trễ.

Bản sao chỉ chứa CSDL `susu.db`, không chứa token Viettel Post, nên tải bản sao về máy khác không làm lộ token. Token nằm ở `/var/lib/chotlive/vtp-connections.json`, được mã hoá bằng khoá `VTP_SECRET_KEY` trong `/etc/chotlive.env`. Khôi phục sang VPS mới mà không mang theo hai file này thì mỗi shop dán lại token Viettel Post một lần.

Sao lưu ngay:

```bash
cd /opt/chotlive && sudo -u chotlive node --no-warnings deploy/backup.mjs /var/lib/chotlive /var/backups/chotlive 5
```

Khôi phục (đổi `TEN_BAN_SAO` thành tên file trong thư mục sao lưu):

```bash
sudo systemctl stop chotlive
```

```bash
sudo install -o chotlive -g chotlive -m 640 /var/backups/chotlive/TEN_BAN_SAO.db /var/lib/chotlive/susu.db
```

```bash
sudo rm -f /var/lib/chotlive/susu.db-wal /var/lib/chotlive/susu.db-shm
```

```bash
sudo systemctl start chotlive
```

## Xử lý sự cố

Xem nhật ký server và HTTPS:

```bash
sudo journalctl -u chotlive -n 50
```

```bash
sudo journalctl -u caddy -n 50
```
