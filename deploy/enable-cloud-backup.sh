#!/usr/bin/env bash
# Bật sao lưu lên Google Drive cho server ChốtLive trên VPS. Xem "Cài đặt trên VPS" trong backup/README.md.
#
# Trước đó, trên máy tính có trình duyệt: tạo kết nối rclone (đăng nhập Google), xuất riêng phần cấu hình của nó
# ra file rồi chép lên VPS ở /tmp/rclone-vps.conf. Mật khẩu sao lưu đưa vào qua stdin (dòng đầu), để nó không
# hiện trên màn hình hay nằm trong lịch sử lệnh:
#   <mật khẩu> | ssh ... "sudo bash enable-cloud-backup.sh"
# Không đưa mật khẩu mà file cấu hình đã có BACKUP_PASSPHRASE thì giữ nguyên mật khẩu cũ.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/chotlive}"
DATA_DIR="${DATA_DIR:-/var/lib/chotlive}"
ENV_FILE="${ENV_FILE:-/etc/chotlive.env}"
APP_USER="${APP_USER:-chotlive}"
CONF_IN="${CONF_IN:-/tmp/rclone-vps.conf}"
RCLONE_CONF="${RCLONE_CONF:-$DATA_DIR/rclone.conf}"
FOLDER="${FOLDER:-ChotLive-VPS}"
INSTALL_RCLONE="${INSTALL_RCLONE:-1}"

say() { echo "==> $*"; }
die() { echo "LỖI: $*" >&2; exit 1; }
as_app() { if [ "$(id -un)" = "$APP_USER" ]; then "$@"; else sudo -u "$APP_USER" "$@"; fi; }
[ "$(id -u)" -eq 0 ] || [ "${ALLOW_NON_ROOT:-}" = 1 ] || die "Hãy chạy bằng sudo."
[ -f "$APP_DIR/backup/cloud-backup.mjs" ] || die "Code trên VPS chưa có phần sao lưu. Cập nhật code trước (deploy/update.sh)."

# Mật khẩu: dòng đầu của stdin, bỏ ký tự xuống dòng kiểu Windows nếu có.
PASS=""
if [ ! -t 0 ]; then IFS= read -r PASS || true; fi
PASS="${PASS%$'\r'}"
# Kiểm tra mật khẩu trước khi đụng tới bất cứ thứ gì.
if [ -n "$PASS" ]; then
  [ "${#PASS}" -ge 12 ] || die "Mật khẩu sao lưu phải dài ít nhất 12 ký tự."
  case "$PASS" in *[[:space:]\'\"\#\\]*) die "Mật khẩu sao lưu không được có dấu cách, dấu nháy, dấu # hay dấu \\." ;; esac
  # PowerShell 5.1 gửi chữ có dấu qua ssh thành dấu ?, mật khẩu trên VPS sẽ khác mật khẩu bạn nhớ.
  LC_ALL=C; case "$PASS" in *[![:print:]]*|*\?*) die "Mật khẩu sao lưu chỉ dùng chữ không dấu, số và dấu gạch (không có dấu ?)." ;; esac; unset LC_ALL
elif ! grep -q '^BACKUP_PASSPHRASE=.\{12,\}' "$ENV_FILE"; then
  die "Chưa có mật khẩu sao lưu. Đưa mật khẩu vào qua stdin (xem đầu file này)."
fi

if [ "$INSTALL_RCLONE" = 1 ] && ! command -v rclone >/dev/null 2>&1; then
  say "Cài rclone"
  command -v unzip >/dev/null 2>&1 || (apt-get update -y >/dev/null && apt-get install -y unzip >/dev/null)
  curl -fsSL https://rclone.org/install.sh | bash >/dev/null
fi
command -v rclone >/dev/null 2>&1 || die "Chưa có rclone."

[ -f "$CONF_IN" ] || die "Chưa có $CONF_IN. Hãy chép cấu hình rclone từ máy tính lên trước."
sed -i 's/\r$//' "$CONF_IN"
REMOTE="$(grep -m1 -oE '^\[[^]]+\]' "$CONF_IN" | tr -d '[]')"
[ -n "$REMOTE" ] || die "$CONF_IN không có kết nối rclone nào."
if [ "${TEST_ANY_REMOTE:-}" != 1 ]; then # chỉ để chạy thử tự động với một thư mục giả làm Drive
  grep -q '^type *= *drive' "$CONF_IN" || die "Kết nối $REMOTE trong $CONF_IN không phải Google Drive."
  grep -q '^token *= *{' "$CONF_IN" || die "Kết nối $REMOTE chưa đăng nhập Google (không có token)."
fi

say "Lưu cấu hình rclone cho người dùng $APP_USER"
install -o "$APP_USER" -g "$APP_USER" -m 600 "$CONF_IN" "$RCLONE_CONF"
rm -f "$CONF_IN"
as_app rclone --config "$RCLONE_CONF" lsd "$REMOTE:" >/dev/null || die "rclone không vào được Google Drive bằng kết nối $REMOTE."

set_env() {
  sed -i "/^$1=/d" "$ENV_FILE"
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
}
if [ -n "$PASS" ]; then set_env BACKUP_PASSPHRASE "$PASS"; fi
set_env BACKUP_RCLONE_REMOTE "$REMOTE:$FOLDER"
set_env BACKUP_RCLONE_CONFIG "$RCLONE_CONF"
chown "root:$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
say "Đã ghi cấu hình sao lưu vào $ENV_FILE (nơi lưu: $REMOTE:$FOLDER)"

backup_cmd() {
  (cd "$APP_DIR" && as_app env DATA_DIR="$DATA_DIR" node --env-file="$ENV_FILE" --no-warnings backup/cloud-backup.mjs "$@")
}
say "Sao lưu thử"
backup_cmd run
say "Khôi phục thử (không đụng dữ liệu đang dùng)"
backup_cmd test-restore

say "XONG. Khởi động lại server lúc không có live để bật sao lưu tự động: sudo systemctl restart chotlive"
