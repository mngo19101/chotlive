#!/usr/bin/env bash
# Cập nhật code ChốtLive trên VPS mà không đụng tới dữ liệu. Xem "Cập nhật code" trong deploy/README.md.
#
# Code mới được giải nén sẵn vào /opt/chotlive-new (từ `git archive` trên máy tính), rồi:
#   sudo bash /opt/chotlive-new/deploy/update.sh prepare   cài thư viện, chụp bản sao, chuẩn bị khoá. Server vẫn chạy.
#   sudo bash /opt/chotlive-new/deploy/update.sh switch    tắt server, đổi sang code mới, bật lại. Lỗi thì tự quay lại.
#   sudo bash /opt/chotlive/deploy/update.sh rollback      quay về code trước lần switch gần nhất.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/chotlive}"
NEW_DIR="${NEW_DIR:-/opt/chotlive-new}"
OLD_DIR="${OLD_DIR:-/opt/chotlive-old}"
DATA_DIR="${DATA_DIR:-/var/lib/chotlive}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/chotlive}"
ENV_FILE="${ENV_FILE:-/etc/chotlive.env}"
SERVICE="${SERVICE:-chotlive}"
APP_USER="${APP_USER:-chotlive}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
PLAIN_VTP="$BACKUP_DIR/vtp-connections.truoc-khi-ma-hoa.json"

say() { echo "==> $*"; }
die() { echo "LỖI: $*" >&2; exit 1; }
as_app() { if [ "$(id -un)" = "$APP_USER" ]; then "$@"; else sudo -u "$APP_USER" "$@"; fi; }

[ "$(id -u)" -eq 0 ] || [ "${ALLOW_NON_ROOT:-}" = 1 ] || die "Hãy chạy bằng sudo."

restarts() { $SYSTEMCTL show -p NRestarts --value "$SERVICE" 2>/dev/null || echo 0; }

# Server trả lời /healthz, và vẫn đứng vững vài giây sau đó: dịch vụ đang chạy, không bị systemd bật lại liên tục
# (code mới lỗi lúc khởi động thì Restart=always bật lại mãi, giữa hai lần có thể vẫn lọt một câu trả lời).
healthy() {
  local before ok=""
  before="$(restarts)"
  for _ in $(seq 1 30); do
    if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || return 1
  sleep "${STABLE_SECONDS:-8}"
  $SYSTEMCTL is-active --quiet "$SERVICE" || return 1
  [ "$(restarts)" = "$before" ] || return 1
  curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1
}

show_log() {
  if command -v journalctl >/dev/null 2>&1; then journalctl -u "$SERVICE" -n "${1:-15}" --no-pager -o cat || true; fi
}

# Code mới mã hoá token Viettel Post khi khởi động. Quay về code cũ thì phải trả lại bản chưa mã hoá,
# vì code cũ không đọc được bản đã mã hoá.
restore_plain_vtp() {
  if [ -f "$PLAIN_VTP" ] && grep -q 'enc:v1:' "$DATA_DIR/vtp-connections.json" 2>/dev/null; then
    cp -p "$PLAIN_VTP" "$DATA_DIR/vtp-connections.json"
    say "Đã trả lại kết nối Viettel Post chưa mã hoá cho code cũ."
  fi
}

prepare() {
  [ -f "$NEW_DIR/server/config.js" ] || die "Chưa có code mới trong $NEW_DIR."
  say "Cài thư viện cho code mới"
  (cd "$NEW_DIR" && npm ci --omit=dev --no-audit --no-fund)
  chmod -R a+rX "$NEW_DIR"
  as_app test -r "$NEW_DIR/server.js" || die "Người dùng $APP_USER không đọc được $NEW_DIR."

  say "Chụp một bản sao CSDL trước khi cập nhật"
  as_app node --no-warnings "$NEW_DIR/deploy/backup.mjs" "$DATA_DIR" "$BACKUP_DIR" 5

  if [ -f "$DATA_DIR/vtp-connections.json" ] && ! grep -q 'enc:v1:' "$DATA_DIR/vtp-connections.json"; then
    cp -p "$DATA_DIR/vtp-connections.json" "$PLAIN_VTP"
    say "Đã giữ một bản kết nối Viettel Post chưa mã hoá để quay lại được: $PLAIN_VTP"
  fi

  if ! grep -q '^VTP_SECRET_KEY=.' "$ENV_FILE"; then
    sed -i '/^VTP_SECRET_KEY=/d' "$ENV_FILE"
    echo "VTP_SECRET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')" >>"$ENV_FILE"
    say "Đã tạo khoá mã hoá token Viettel Post trong $ENV_FILE"
  fi
  chown "root:$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"

  say "SẴN SÀNG. Lúc không có live, chạy: sudo bash $NEW_DIR/deploy/update.sh switch"
}

switch() {
  [ -d "$NEW_DIR/node_modules" ] || die "Code mới chưa được chuẩn bị. Chạy prepare trước."
  say "Tắt server"
  $SYSTEMCTL stop "$SERVICE"
  rm -rf "$OLD_DIR"
  mv "$APP_DIR" "$OLD_DIR"
  mv "$NEW_DIR" "$APP_DIR"
  say "Bật server bằng code mới"
  $SYSTEMCTL start "$SERVICE"
  if healthy; then
    show_log 12
    say "XONG: server đang chạy code mới. Code cũ giữ ở $OLD_DIR."
    say "Có gì không ổn thì quay lại: sudo bash $APP_DIR/deploy/update.sh rollback"
    return 0
  fi
  echo "Server không lên với code mới. Nhật ký:" >&2
  show_log 40 >&2
  say "Tự quay về code cũ"
  $SYSTEMCTL stop "$SERVICE" || true
  rm -rf "$APP_DIR.failed"
  mv "$APP_DIR" "$APP_DIR.failed"
  mv "$OLD_DIR" "$APP_DIR"
  restore_plain_vtp
  $SYSTEMCTL start "$SERVICE"
  healthy && die "Đã quay về code cũ, server chạy lại bình thường. Code mới lỗi giữ ở $APP_DIR.failed."
  die "Đã quay về code cũ nhưng server vẫn chưa lên. Xem: journalctl -u $SERVICE -n 50"
}

rollback() {
  [ -d "$OLD_DIR" ] || die "Không có code cũ ở $OLD_DIR để quay lại."
  say "Quay về code cũ"
  $SYSTEMCTL stop "$SERVICE"
  rm -rf "$APP_DIR.failed"
  mv "$APP_DIR" "$APP_DIR.failed"
  mv "$OLD_DIR" "$APP_DIR"
  restore_plain_vtp
  $SYSTEMCTL start "$SERVICE"
  healthy || die "Server chưa lên. Xem: journalctl -u $SERVICE -n 50"
  say "XONG: server đang chạy code cũ. Code mới giữ ở $APP_DIR.failed."
}

case "${1:-}" in
  prepare) prepare ;;
  switch) switch ;;
  rollback) rollback ;;
  *) die "Dùng: update.sh prepare | switch | rollback" ;;
esac
