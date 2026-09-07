#!/bin/sh
# runnode 安装脚本。在项目源码目录里以 root 执行：sudo ./install.sh
set -eu

DEST=/opt/runnode
CONFIG=/etc/runnode/config.json
ADDR="${RUNNODE_ADDR:-127.0.0.1:7788}"

[ "$(id -u)" = 0 ] || { echo "需要 root：sudo ./install.sh"; exit 1; }
command -v systemctl >/dev/null || { echo "找不到 systemctl，本面板依赖 systemd"; exit 1; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "找不到 node，请先安装"; exit 1; }
echo "使用 node: $NODE ($("$NODE" -v))"

# --- journald 持久化：很多发行版默认 volatile，重启后日志全丢（DESIGN.md §6.1）
if [ ! -d /var/log/journal ]; then
  echo "journald 未持久化，正在开启（否则重启后日志全部丢失）"
  mkdir -p /var/log/journal
  systemd-tmpfiles --create --prefix /var/log/journal || true
  systemctl restart systemd-journald
fi

# --- 代码
echo "安装到 $DEST"
mkdir -p "$DEST"
for f in package.json server.js systemd.js; do
  cp "$f" "$DEST/$f"
done
rm -rf "$DEST/public"
cp -r public "$DEST/public"
chown -R root:root "$DEST"
chmod -R go-w "$DEST"

( cd "$DEST" && npm install --omit=dev --no-audit --no-fund )

# --- 配置与初始密码
if [ -f "$CONFIG" ]; then
  echo "已有配置 $CONFIG，保留原密码"
else
  PW="$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
  ( cd "$DEST" && "$NODE" server.js --init "$PW" )
  chmod 600 "$CONFIG"
  echo
  echo "======================================"
  echo " 管理员密码：$PW"
  echo " 请立刻保存，这行不会再出现"
  echo "======================================"
  echo
fi

# --- 面板自身的 unit（node 路径按实际探测结果写死）
cat > /etc/systemd/system/runnode-panel.service <<UNIT
# Managed by runnode install.sh
[Unit]
Description=runnode panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$DEST
Environment=RUNNODE_ADDR=$ADDR
ExecStart=$NODE server.js
Restart=always
RestartSec=3
LogRateLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now runnode-panel.service

echo
systemctl --no-pager --lines=0 status runnode-panel.service || true
echo
echo "面板已启动：http://$ADDR"
case "$ADDR" in
  127.0.0.1:*|localhost:*)
    echo "只监听本地。从本机浏览器访问，或建隧道："
    echo "  ssh -L ${ADDR##*:}:$ADDR <此服务器>"
    ;;
  *)
    echo "警告：面板以 root 运行且监听 $ADDR。务必在前面加 TLS 和访问控制。"
    ;;
esac
echo "日志：journalctl -u runnode-panel -f"
