# Đồng bộ laptop và mini PC

Mục đích: máy này hỏng thì máy kia vẫn còn dữ liệu để cứu lại.

- **Laptop:** mỗi lần đăng nhập Windows sẽ tự kết nối mini PC, rồi cứ 5 phút kiểm tra một lần. Chưa kết nối được thì 1 phút sau thử lại.
- **Mini PC:** tự chạy khi khởi động, không cần đăng nhập.
- **Chưa có mini PC:** laptop vẫn tự lưu bản sao trên chính nó, tối đa 30 phút một bản. Bản này cứu được khi lỡ xóa nhầm, nhưng **không cứu được khi hỏng ổ cứng**.

## Khi mua mini PC về

Hai máy cần cắm chung một mạng (cùng modem hoặc Wi-Fi).

**Bước 1: Chuẩn bị mini PC**
1. Cài [Node.js](https://nodejs.org) bản 22.13 trở lên.
2. Chép cả thư mục dự án từ laptop sang mini PC (bằng USB chẳng hạn), **gồm cả `sync/config.json`** vì file này chứa mã kết nối. Thư mục `node_modules` có thể chép theo hoặc chạy `npm install` sau.
3. Bấm đúp `sync\cai-tren-mini-pc.cmd` và chọn **Yes** khi Windows hỏi quyền.
4. Ghi lại **tên máy** và **địa chỉ IP** hiện ra trên màn hình.

Ở bước 3, script sẽ mở cổng 3100 cho mạng nội bộ và tắt chế độ ngủ khi cắm điện. Nếu mini PC ngủ, laptop sẽ không kết nối được.

**Bước 2: Thêm mini PC trên laptop**
1. Bấm đúp `sync\them-mini-pc.cmd`.
2. Nhập tên máy của mini PC. Nên dùng tên máy vì IP có thể đổi; nếu tên không kết nối được thì nhập IP.
3. Thấy `Hai máy đã giống nhau` hoặc `Đã gửi dữ liệu mới` là xong.

Nếu mini PC là máy Linux, cách cài ở bước 1 sẽ khác vì các script ở đây chỉ dành cho Windows.

## Cách hai máy đồng bộ

| Tình huống | Kết quả |
|---|---|
| Chỉ một máy có thay đổi | Máy kia tự nhận bản mới và lưu lại bản cũ trước khi thay |
| Một máy trống (máy mới, vừa cài lại) | Máy đó tự nhận toàn bộ dữ liệu từ máy còn lại |
| **Cả hai máy đều có thay đổi riêng** | **Không ghi đè.** Mỗi máy giữ bản của mình và cất thêm bản của máy kia, chờ bạn chọn |
| Một máy bỗng mất hơn nửa dữ liệu | Coi là sự cố, không lan sang máy kia, cả hai bản đều được giữ |
| Server ChốtLive đang chạy trên máy cần nhận | Chỉ cất bản sao. Bản mới được áp dụng khi tắt server và chạy lại `npm start` |

**Hai bản không được gộp lại với nhau**, vì đơn hàng chưa lưu đủ thông tin để biết bên nào đúng hơn. Để tránh phải chọn giữa hai bản, chỉ nên bật server ChốtLive trên **một máy** tại một thời điểm. Điện thoại và web đều trỏ về máy đó, ví dụ mini PC chạy suốt ngày và laptop mở `http://<tên-mini-pc>:3000`.

Dữ liệu chỉ đồng bộ khi hai máy thấy nhau trên mạng. Khi mang laptop ra ngoài, nó sẽ đồng bộ lại lúc về nhà. Muốn đồng bộ từ xa thì cài [Tailscale](https://tailscale.com) trên cả hai máy rồi dùng tên máy trong Tailscale ở bước 2.

## Khi có sự cố

Kiểm tra tình trạng: bấm đúp `sync\kiem-tra.cmd`. **Nên xem định kỳ**, vì hiện chưa có thông báo tự động khi đồng bộ bị lỗi.

**Hai máy có thay đổi riêng (xung đột):** chọn một trong hai lệnh, chạy trên laptop.

```bash
node --no-warnings sync/sync.js keep-mine
```

```bash
node --no-warnings sync/sync.js use-peer
```

`keep-mine` dùng bản của laptop cho cả hai máy, `use-peer` dùng bản của mini PC. Bản bị thay vẫn được lưu lại.

**Mini PC hỏng:** làm lại bước 1 trên mini PC mới, chép thư mục từ laptop. Nếu mini PC mới khác tên hoặc IP thì làm lại cả bước 2. Laptop sẽ gửi lại toàn bộ dữ liệu.

**Laptop hỏng:** trên laptop mới, cài Node.js, chép thư mục dự án từ mini PC sang (gồm cả `sync/config.json`), rồi chạy lệnh dưới đây trong thư mục đó. Sau đó làm bước 2.

```bash
powershell -ExecutionPolicy Bypass -File sync\install.ps1
```

**Muốn quay về một bản cũ:** tắt server, xem danh sách bản sao rồi khôi phục bản muốn dùng.

```bash
node --no-warnings sync/sync.js list
```

```bash
node --no-warnings sync/sync.js restore "<đường dẫn file trong danh sách>"
```

Sau khi khôi phục, bản này chưa sang máy kia. Muốn đưa sang thì chạy thêm `keep-mine`.

## Nơi lưu và bảo mật

- Bản sao nằm trong `data/sync/`: `received` (nhận từ máy kia), `own` (tự lưu), `before-replace` (lưu trước khi bị thay). Mỗi thư mục giữ 6 bản mới nhất và mỗi ngày một bản trong 14 ngày.
- Nhật ký nằm ở `data/sync/sync.log`.
- Dữ liệu gửi qua mạng được mã hóa AES-256, mã kết nối không bao giờ được gửi đi.
- **Bản sao trong `data/sync/` không được mã hóa trên ổ cứng** và chứa thông tin khách hàng, nên hãy đặt mật khẩu đăng nhập Windows cho cả hai máy.
- `sync/config.json` chứa mã kết nối và đã được loại khỏi git. **Đừng gửi file này cho người khác.**
- Tài khoản và mật khẩu ChốtLive cũng được đồng bộ, nên đăng nhập trên hai máy như nhau.

## Gỡ bỏ

```bash
powershell -ExecutionPolicy Bypass -File sync\install.ps1 -Uninstall
```

Lệnh này chỉ gỡ tác vụ chạy nền, dữ liệu và bản sao vẫn còn. Trên mini PC, chạy bằng quyền Administrator để gỡ luôn quy tắc mở cổng.
