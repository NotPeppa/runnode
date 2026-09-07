# runnode

服务器上的 Node 项目管理面板。启停、重启、开机自启、实时日志，都在网页上做。

**进程管理后端是 systemd** —— 面板不自己守护进程，每个项目生成一个
`/etc/systemd/system/runnode-<名字>.service`，unit 文件就是数据库。所以守护、
自动重启、开机自启、CPU/内存统计、用户隔离、内存上限全部由 systemd 提供，
面板重启升级也不影响正在跑的项目。设计取舍见 [DESIGN.md](DESIGN.md)。

## 安装

```sh
git clone <repo> runnode && cd runnode
sudo ./install.sh
```

脚本会：检查 journald 持久化（默认可能没开，重启后日志全丢）、装到 `/opt/runnode`、
生成随机管理员密码并打印一次、注册 `runnode-panel.service` 并开机自启。

**面板默认只监听 `127.0.0.1:7788`** —— 它以 root 运行，不做公网暴露。从本机浏览器打开，
或建隧道：

```sh
ssh -L 7788:127.0.0.1:7788 <服务器>
```

需要公网访问就在前面挂 nginx + TLS + 访问控制，然后
`RUNNODE_ADDR=0.0.0.0:7788 sudo ./install.sh`。

## 命令速查

`install.sh` 会把 `runnode` 注册到 `/usr/local/bin`（软链到 `$DEST/runnode.sh`，
所以更新代码后命令自动跟着更新）。

```sh
runnode help        # 全部命令和例子；空跑 runnode 也是这个
```

### 面板

```sh
sudo runnode start|stop|restart
runnode status
runnode log [-f]                     # 面板日志
runnode version
sudo runnode passwd <新密码>         # 改密码并自动重启面板
sudo runnode update                  # git pull + 重新安装
sudo runnode uninstall [--all]
```

改密码会连 cookie 签名密钥一起换掉，已登录的会话全部失效。面板配置只在启动时读一次，
所以 `passwd` 内部会自动帮你重启。

### 单个项目

省略项目名就是操作面板自己，带项目名就是操作那个项目：

```sh
runnode ls                           # 列出全部项目及状态
sudo runnode start|stop|restart <项目>
sudo runnode enable|disable <项目>   # 开机自启开关
runnode status <项目>
runnode cat <项目>                   # 看实际生效的 unit 内容
runnode log <项目> [-f]
runnode log <项目> --this-run        # 只看本次运行（崩溃重启循环时最有用）
```

### 底层等价命令

`runnode` 只是转发，不做任何自己的状态管理。所以下面这些永远可用，
也是排查 `runnode` 本身出问题时的退路：

```sh
systemctl start|stop|restart|status|enable|disable runnode-panel
systemctl start|stop|restart|status|enable|disable runnode-<名字>
systemctl list-units 'runnode-*'
systemctl cat runnode-<名字>
journalctl -u runnode-<名字> -f
journalctl _SYSTEMD_INVOCATION_ID=$(systemctl show runnode-<名字> -p InvocationID --value)
sudo node /opt/runnode/server.js --init <新密码> && sudo systemctl restart runnode-panel
```

调试 `runnode` 自己生成的命令：`RUNNODE_DRY=1 runnode stop web` 只打印不执行。

### 文件位置

| 路径 | 是什么 |
|---|---|
| `/opt/runnode` | 面板代码 |
| `/etc/runnode/config.json` | 管理员密码 hash + cookie 密钥（0600） |
| `/etc/systemd/system/runnode-<名字>.service` | 项目定义，也就是「数据库」 |
| `/etc/systemd/system/runnode-panel.service` | 面板自身的 unit |

## 更新

`install.sh` 就是更新脚本，可重复执行：

```sh
sudo runnode update      # 等价于 git pull && ./install.sh
```

或者手动：

```sh
cd /opt/runnode          # 或你 clone 的位置
git pull
sudo ./install.sh
```

它会重新同步代码、装依赖、重写面板 unit，然后 **restart 面板**。已有的
`/etc/runnode/config.json` 会保留，不会重置密码。

面板重启期间**项目全程照常运行** —— 它们是各自独立的 unit，和面板进程没有父子关系。
这是选 systemd 做后端换来的。

确认新代码真的生效（版本号和 pid 会打进 journal）：

```sh
runnode log -n 5
# runnode 0.1.0 监听 http://127.0.0.1:7788 (pid 12345)
```

回滚到某个版本：

```sh
git checkout <tag 或 commit> && sudo ./install.sh
```

**一个注意点**：更新只影响面板自己。如果新版本改了 unit 模板（比如加了新的 systemd
指令），已有项目的 unit 文件不会自动重写 —— 在面板里把那个项目**打开保存一次**即可
按新模板重新生成。`systemctl cat runnode-<名字>` 可以看当前实际生效的内容。

卸载：

```sh
sudo runnode uninstall          # 只卸面板，项目继续跑和自启
sudo runnode uninstall --all    # 连所有项目 unit 一起停掉删掉
```

两种都不会删除项目代码目录、项目的 unix 用户、journal 里的日志。

## 新建一个项目

面板里填这些，对应的就是 unit 里的字段：

| 表单 | unit |
|---|---|
| 运行用户（不存在自动建） | `User=` |
| 工作目录 | `WorkingDirectory=` |
| node 可执行路径 | `ExecStart=` 前半段 |
| 启动参数 | `ExecStart=` 后半段 |
| 环境变量 | `Environment=` |
| 重启策略 / 间隔 | `Restart=` / `RestartSec=` |
| 内存上限 | `MemoryMax=` |

工作目录下的 `.env` 会自动加载（不存在就忽略）。多版本 node 就填不同的绝对路径，
fnm / nvm 装的都行 —— 不需要额外的版本管理功能。

项目**必须以非 root 用户运行**。工作目录属主不对时面板会拒绝创建并给出要执行的
`chown` 命令 —— 不自动 `chown -R`，路径算错是不可逆的。

## 日志

页面里实时跟随（SSE），可暂停自动滚动、按正则搜索、下载。

两个专门为排查做的东西：

- **只看本次运行** —— 崩溃重启循环时几十次运行的日志糊在一起没法读。按 systemd 的
  InvocationID 精确切出当前这一次。
- **列表里直接显示死因** —— `Result=oom-kill` 时应用日志里通常什么都没有，
  只能从这里看出来。重启次数也显眼标出，因为 2 秒轮询会漏掉瞬时的崩溃循环状态。

systemd 自己的消息（`Started` / `Main process exited, status=1` / `Scheduled restart`）
不做过滤 —— 它们和应用日志在同一条时间线上，是排查崩溃最有用的部分。

## 开发

```sh
npm install
npm test                      # 不需要 systemd，任何平台都能跑

RUNNODE_CONFIG=./dev/config.json \
RUNNODE_UNIT_DIR=./dev/units \
RUNNODE_ADDR=127.0.0.1:7799 \
  node server.js --init mypassword123 && node server.js
```

`RUNNODE_UNIT_DIR` 指向别处可以在不碰系统 unit 的前提下开发，但启停操作仍然会真的调用
`systemctl`，所以完整功能只能在有 systemd 的机器上验证。

## 第一次上服务器要确认的事

`systemctl show` 的多 unit 输出形状是本项目唯一的外部格式依赖。手跑一遍对一下：

```sh
systemctl show runnode-<a>.service runnode-<b>.service \
  -p Id,ActiveState,MemoryCurrent,Result,InvocationID
```

期望是按 unit 分组、空行分隔的 `Key=Value`。形状不同的话
`test/systemd.test.js` 里的 `SHOW_SAMPLE` 就是要改的地方（面板会自动退化成逐个查询，
只是慢一点，不会坏）。

`MemoryCurrent=[not set]` 表示这台机器没开 cgroup 统计，面板显示 `—`。要数字就在 unit 里
加 `MemoryAccounting=yes`。

## 不做

多用户 / RBAC、Docker、集群多机、监控历史曲线、Web 终端。需要哪个再加。
