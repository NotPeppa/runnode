#!/bin/sh
# runnode 安装脚本。在项目源码目录里以 root 执行：sudo ./install.sh
set -eu

DEST=/opt/runnode
CONFIG=/etc/runnode/config.json
ADDR="${RUNNODE_ADDR:-127.0.0.1:7788}"

# 源码目录取脚本自身位置，不取 cwd —— 允许 `bash /path/to/install.sh` 从任意目录执行
SRC="$(cd "$(dirname "$0")" && pwd -P)"

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
mkdir -p "$DEST"
DEST_R="$(cd "$DEST" && pwd -P)"
if [ "$SRC" = "$DEST_R" ]; then
  # 直接把仓库 clone 到了 /opt/runnode。跳过复制 —— 否则 rm -rf public 会删掉源码。
  echo "源码已在 $DEST，跳过复制"
else
  echo "安装到 $DEST"
  # 文件清单从 git 取：写死列表的话，以后新增文件忘了加进来，更新会静默不生效。
  # 不在 git 仓库里（比如直接解压的 tar 包）才退回最小集。注意：不支持带空格的文件名。
  # -co --exclude-standard = 已跟踪 + 未提交的新文件，但排除 .gitignore 里的 node_modules
  FILES="$(git -C "$SRC" ls-files -co --exclude-standard 2>/dev/null || true)"
  [ -n "$FILES" ] || FILES="package.json server.js systemd.js public/index.html"
  for f in $FILES; do
    mkdir -p "$DEST/$(dirname "$f")"
    cp "$SRC/$f" "$DEST/$f"
  done
fi
chown -R root:root "$DEST"
chmod -R go-w "$DEST"

( cd "$DEST" && npm install --omit=dev --no-audit --no-fund )

# --- 配置与初始密码
if [ -f "$CONFIG" ]; then
  echo "已有配置 $CONFIG，保留原密码"
else
  # 多取一些熵再过滤，保证 tr 删掉 /+= 之后还有足够长度
  PW="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
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

# --- runnode 命令。软链而非复制：更新代码后命令自动跟着更新
if [ -f "$DEST/runnode.sh" ]; then
  chmod +x "$DEST/runnode.sh"
  ln -sf "$DEST/runnode.sh" /usr/local/bin/runnode
  echo "已注册命令：runnode -> $DEST/runnode.sh"
fi

systemctl daemon-reload
systemctl enable runnode-panel.service
# 必须是 restart 而不是 enable --now：--now 对已在运行的 unit 是空操作，
# 那样更新完新代码在磁盘上、跑的还是旧进程。restart 对未启动的也能起来。
systemctl restart runnode-panel.service

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
echo "日志：runnode log -f     全部命令：runnode help"
