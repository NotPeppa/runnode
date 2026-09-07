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
