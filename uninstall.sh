#!/bin/sh
# 卸载 runnode 面板。默认只卸面板，被管理的项目继续跑。
#   sudo ./uninstall.sh          仅卸面板（项目 unit 保留，继续自启和运行）
#   sudo ./uninstall.sh --all    连所有项目 unit 一起停掉并删除
#   加 -y 跳过确认
#
# 无论哪种都不会删除：项目代码目录、项目的 unix 用户、journal 里的日志。
set -eu

DEST=/opt/runnode
CONFIG_DIR=/etc/runnode
UNIT_DIR=/etc/systemd/system
PANEL=runnode-panel.service

ALL=0
YES=0
for a in "$@"; do
  case "$a" in
    --all) ALL=1 ;;
    -y|--yes) YES=1 ;;
    *) echo "未知参数：$a"; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "需要 root：sudo ./uninstall.sh"; exit 1; }

# 脚本可能就在 $DEST 里（clone 到 /opt/runnode 的情况）。sh 是边读边执行的，
# 删掉自己所在目录会把执行搞断，所以先把自己搬到临时文件再接着跑。
SRC="$(cd "$(dirname "$0")" && pwd -P)"
if [ -z "${RUNNODE_RELOCATED:-}" ]; then
  case "$SRC" in
    "$DEST"|"$DEST"/*)
      TMP="$(mktemp)"
      cat "$0" > "$TMP"
      RUNNODE_RELOCATED=1 exec sh "$TMP" "$@"
      ;;
  esac
fi

projects="$(ls "$UNIT_DIR" 2>/dev/null | grep '^runnode-.*\.service$' | grep -v "^$PANEL$" || true)"

echo "将要执行："
echo "  - 停止并注销 $PANEL"
echo "  - 删除 $UNIT_DIR/$PANEL"
echo "  - 删除 /usr/local/bin/runnode 命令"
echo "  - 删除 $DEST"
if [ "$ALL" = 1 ]; then
  echo "  - 删除 $CONFIG_DIR（含管理员密码）"
  if [ -n "$projects" ]; then
    echo "  - 停止并删除以下项目 unit："
    echo "$projects" | sed 's/^/      /'
  fi
else
  echo "  - 保留 $CONFIG_DIR（管理员密码，重装可复用）"
  if [ -n "$projects" ]; then
    echo "  - 保留以下项目 unit，它们会继续运行和开机自启："
    echo "$projects" | sed 's/^/      /'
    echo "    （要一起删就加 --all）"
  fi
fi
echo "  不会删除：项目代码目录、项目的 unix 用户、journal 日志"
echo

if [ "$YES" != 1 ]; then
  if [ -r /dev/tty ]; then
    printf '继续？[y/N] '
    read ans < /dev/tty
  else
    echo "非交互环境，请加 -y 确认"; exit 1
  fi
  case "$ans" in y|Y|yes|YES) ;; *) echo "已取消"; exit 1 ;; esac
fi

echo "停止面板"
systemctl disable --now "$PANEL" 2>/dev/null || true
rm -f "$UNIT_DIR/$PANEL"
rm -f /usr/local/bin/runnode

if [ "$ALL" = 1 ] && [ -n "$projects" ]; then
  for u in $projects; do
    echo "停止并删除 $u"
    systemctl disable --now "$u" 2>/dev/null || true
    rm -f "$UNIT_DIR/$u"
  done
fi

systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

echo "删除 $DEST"
rm -rf "$DEST"

if [ "$ALL" = 1 ]; then
  echo "删除 $CONFIG_DIR"
  rm -rf "$CONFIG_DIR"
fi

echo
echo "卸载完成。"
if [ "$ALL" != 1 ] && [ -n "$projects" ]; then
  echo "项目 unit 仍在，可继续用 systemctl 管理，例如："
  echo "  systemctl status $(echo "$projects" | head -1)"
fi
