# VTP Nháp Test (app thử, tách biệt)

App iOS riêng để thử đẩy **đơn nháp** lên Viettel Post ngay trên iPhone, không qua máy chủ ChotLive.

- **Tách biệt với app thật:** bundle id `com.chotlive.vtpnhaptest`, cài song song với ChốtLive, không dùng chung dữ liệu.
- **Chỉ đọc ChotLive:** app chỉ được gọi `POST /api/auth/login` và `GET /api/state`; mọi lệnh khác bị chặn trong `ChotLiveReader.allowed`.
- **Viettel Post trên máy:** đăng nhập SSO → OTP (thiết bị mới) → `ssoUpdateUser` có chữ ký DPoP (khoá P-256 trong Keychain) → `InsertOrderDraftForWeb`. Đi từ IP của iPhone.
- **Địa chỉ:** `location.viettelpost.vn` đổi địa chỉ chữ (cả địa chỉ mới 2 cấp) thành mã tỉnh/quận/phường Viettel Post.

Đây là API không công khai của web Viettel Post, có thể đổi bất cứ lúc nào.

## Build IPA

Workflow `.github/workflows/build-vtp-nhap-test-ipa.yml` chạy khi đẩy lên nhánh `vtp-nhap-test` (hoặc bấm tay). Tải artifact **VTP-Nhap-Test-IPA**, cài bằng Sideloadly.

## Bản thử trên máy tính

`prototype/vtp-web.mjs` là cùng luồng viết bằng Node: `login`, `inventory`, `draft`, `refresh`.
