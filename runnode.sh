#!/bin/sh
# runnode 命令行。安装时软链到 /usr/local/bin/runnode。
# 只做转发：面板和项目都是普通 systemd unit，这里不重新实现任何东西。
# 调试：RUNNODE_DRY=1 runnode stop web  只打印将要执行的命令，不执行。
set -eu

PANEL=runnode-panel.service
PREFIX=runnode-
DEST=/opt/runnode

run() {
  if [ -n "${RUNNODE_DRY:-}" ]; then
    echo "+ $*"
  else
    "$@"
  fi
}

die() { echo "$*" >&2; exit 1; }

# 静默吃掉多余参数会藏打字错误（runnode stop a b）
no_extra() { [ $# -eq 0 ] || die "多余的参数：$*"; }

need_root() {
  [ "$(id -u)" = 0 ] || [ -n "${RUNNODE_DRY:-}" ] || die "需要 root：sudo runnode $CMD $*"
}

# 校验必须在主 shell 里做：放进 $(...) 的话 exit 只退出子 shell，
# 主脚本会带着空 unit 名继续执行下去。
check_name() {
  [ -n "$1" ] || return 0
  case "$1" in
    *[!a-z0-9-]*|[!a-z]*)
      die "项目名不合法：$1（小写字母开头，只允许小写字母/数字/短横）" ;;
  esac
}

# 项目名 → unit 名。空则表示面板自己。
unit() {
  [ -n "$1" ] && echo "$PREFIX$1.service" || echo "$PANEL"
}

usage() {
  cat <<'USAGE'
runnode —— 基于 systemd 的 Node 项目管理面板

用法：runnode <命令> [项目] [参数]

  带项目名 = 操作那个项目，省略 = 操作面板自己。
  改动类命令需要 root（sudo）。

项目
  ls                        列出所有项目及状态
  start|stop|restart <项目> 启停项目                          [root]
  enable|disable <项目>     开机自启开关                      [root]
  status <项目>             项目状态、PID、内存、重启次数
  log <项目> [-f]           项目日志，-f 跟随
  log <项目> --this-run     只看本次运行（崩溃重启循环时最有用）
  cat <项目>                看实际生效的 unit 文件内容

面板
  status                    面板状态
  start|stop|restart        启停面板                          [root]
  log [-f]                  面板自己的日志
  passwd <新密码>           改管理员密码并自动重启面板        [root]
  update                    git pull 并重新安装               [root]
  uninstall [--all]         卸载，--all 连项目 unit 一起删    [root]
  version                   面板版本号
  help                      本帮助

例子
  sudo runnode restart web        重启项目 web
  runnode log web -f              跟随 web 的日志
  runnode log web --this-run      web 崩溃重启后只看最新那一次
  runnode ls                      看哪些项目挂了
  sudo runnode passwd s3cret123   改密码

其他
  项目也可以直接用 systemctl 管：systemctl restart runnode-<项目>
  RUNNODE_DRY=1 runnode stop web  只打印将执行的命令，不执行
  网页面板默认在 http://127.0.0.1:7788
USAGE
}

CMD="${1:-help}"
[ $# -gt 0 ] && shift || true

# 第一个不以 - 开头的参数取出来，具体当项目名还是别的由各命令决定
ARG=""
case "${1:-}" in
  ''|-*) ;;
  *) ARG="$1"; shift ;;
esac

case "$CMD" in
  start|stop|restart|enable|disable)
    no_extra "$@"
    check_name "$ARG"
    need_root "$ARG"
    run systemctl "$CMD" "$(unit "$ARG")"
    ;;

  status)
    no_extra "$@"
    check_name "$ARG"
    run systemctl status --no-pager "$(unit "$ARG")"
    ;;

  cat)
    no_extra "$@"
    check_name "$ARG"
    run systemctl cat "$(unit "$ARG")"
    ;;

  ls|list)
    no_extra "$@"
    run systemctl list-units --all "$PREFIX*"
    ;;

  log|logs)
    check_name "$ARG"
    U="$(unit "$ARG")"
    THISRUN=""
    HAS_N=""
    ARGS=""
    for a in "$@"; do
      case "$a" in
        --this-run) THISRUN=1 ;;
        -n|--lines|-n*|--lines=*) HAS_N=1; ARGS="$ARGS $a" ;;
        *) ARGS="$ARGS $a" ;;
      esac
    done
    # 用户自己给了 -n 就别再塞一个默认值进去
    [ -n "$HAS_N" ] || ARGS="-n 200 $ARGS"

    if [ -n "$THISRUN" ]; then
      # 只看本次运行：按 systemd 给每次启动分配的 InvocationID 精确切分
      ID="$(systemctl show "$U" -p InvocationID --value)"
      [ -n "$ID" ] || die "$U 还没运行过，没有本次运行的日志"
      # shellcheck disable=SC2086
      run journalctl "_SYSTEMD_INVOCATION_ID=$ID" --no-pager $ARGS
    else
      # shellcheck disable=SC2086
      run journalctl -u "$U" --no-pager $ARGS
    fi
    ;;

  passwd)
    no_extra "$@"
    need_root
    # 这里 ARG 是新密码，不是项目名，所以不走 check_name
    [ -n "$ARG" ] || die "用法：runnode passwd <新密码>"
    run node "$DEST/server.js" --init "$ARG"
    run systemctl restart "$PANEL"
    echo "密码已更新，面板已重启，原有登录会话全部失效"
    ;;

  update)
    need_root
    [ -d "$DEST/.git" ] || die "$DEST 不是 git 仓库（安装时源码在别处）。
请到你 clone 的目录执行：git pull && sudo ./install.sh"
    run git -C "$DEST" pull
    run sh "$DEST/install.sh"
    ;;

  uninstall)
    need_root
    [ -f "$DEST/uninstall.sh" ] || die "找不到 $DEST/uninstall.sh"
    # --all / -y 以 - 开头，所以还在 $@ 里
    run sh "$DEST/uninstall.sh" "$@"
    ;;

  version|--version|-v)
    node -p "require('$DEST/package.json').version"
    ;;

  help|--help|-h)
    usage
    ;;

  *)
    echo "未知命令：$CMD" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
