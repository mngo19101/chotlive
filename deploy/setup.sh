#!/usr/bin/env bash
# Cài ChốtLive lên VPS Ubuntu/Debian. Xem deploy/README.md.
#   sudo bash /opt/chotlive/deploy/setup.sh ten-mien-cua-ban.vn
# Chạy lại nhiều lần được: không đổi mật khẩu admin, không đụng tới dữ liệu đã có.
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Cách dùng: sudo bash deploy/setup.sh ten-mien-cua-ban.vn" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Hãy chạy bằng sudo." >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=/var/lib/chotlive
BACKUP_DIR=/var/backups/chotlive
ENV_FILE=/etc/chotlive.env
export DEBIAN_FRONTEND=noninteractive

echo "==> Cài gói hệ thống"
apt-get update -y
apt-get install -y curl git ufw cron gnupg debian-keyring debian-archive-keyring apt-transport-https

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  echo "==> Cài Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Cài Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# Máy ít RAM (ví dụ gói 1 GB của Oracle) dễ bị treo khi cài; thêm 2 GB swap.
if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 1800 ] && ! swapon --show | grep -q .; then
  echo "==> RAM thấp, tạo swap 2 GB"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Tạo người dùng và thư mục dữ liệu"
id chotlive >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin chotlive
install -d -o chotlive -g chotlive -m 750 "$DATA_DIR"
install -d -o chotlive -g chotlive -m 750 "$BACKUP_DIR"

echo "==> Cài thư viện"
cd "$APP_DIR"
npm ci --omit=dev
chmod -R a+rX "$APP_DIR"
# Thư mục cài phải mở được từ gốc, nếu không người dùng chotlive không đọc được code.
if ! sudo -u chotlive test -r "$APP_DIR/server.js"; then
  echo "Người dùng chotlive không đọc được $APP_DIR. Hãy đặt code ở /opt/chotlive." >&2
  exit 1
fi

NEW_ADMIN_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then
  echo "==> Tạo cấu hình $ENV_FILE"
  NEW_ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  (
    umask 077
    cat > "$ENV_FILE" <<EOF
ADMIN_PASSWORD=$NEW_ADMIN_PASSWORD
TOKEN_TTL_DAYS=30
SIGN_API_KEY=
EOF
  )
fi

echo "==> Cấu hình dịch vụ"
sed "s|__APP_DIR__|$APP_DIR|g" "$APP_DIR/deploy/chotlive.service" > /etc/systemd/system/chotlive.service
sed "s|__DOMAIN__|$DOMAIN|g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# 3 giờ sáng mỗi ngày, giữ 14 bản.
cat > /etc/cron.d/chotlive-backup <<EOF
0 3 * * * chotlive cd $APP_DIR && /usr/bin/env node --no-warnings deploy/backup.mjs $DATA_DIR $BACKUP_DIR 14 >/dev/null
EOF
chmod 644 /etc/cron.d/chotlive-backup

echo "==> Mở tường lửa"
if [ -f /etc/iptables/rules.v4 ]; then
  # Ubuntu của Oracle Cloud: đã có sẵn luật iptables chỉ cho cổng SSH, còn lại bị từ chối.
  # Chèn luật mở 80/443 lên đầu rồi lưu lại để còn nguyên sau khi khởi động lại.
  # Ngoài ra phải mở 80/443 trong Security List của VCN trên trang quản lý Oracle.
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null ||
      iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save
  else
    iptables-save > /etc/iptables/rules.v4
  fi
else
  # Giữ đúng cổng SSH đang dùng để không tự khoá mình khỏi VPS.
  SSH_PORT="${SSH_CONNECTION##* }"
  ufw allow "${SSH_PORT:-22}/tcp"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

echo "==> Khởi động"
systemctl daemon-reload
systemctl enable chotlive caddy
systemctl restart chotlive
systemctl reload caddy || systemctl restart caddy

echo "==> Kiểm tra"
ready=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 3
done

echo
if [ -n "$ready" ]; then
  echo "XONG: https://$DOMAIN đang chạy."
else
  echo "Chưa mở được https://$DOMAIN. Kiểm tra tên miền đã trỏ về IP của VPS chưa, rồi xem:"
  echo "  journalctl -u caddy -n 30"
  echo "  journalctl -u chotlive -n 30"
fi
if [ -n "$NEW_ADMIN_PASSWORD" ]; then
  echo
  echo "Tài khoản quản trị: admin"
  echo "Mật khẩu: $NEW_ADMIN_PASSWORD"
  echo "Hãy lưu lại ngay. Mật khẩu này chỉ hiện một lần và có tác dụng khi dữ liệu còn trống."
fi
