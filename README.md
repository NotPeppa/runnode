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
| 启动命令 | `ExecStart=` |
| 环境变量 | `Environment=` |
| 重启策略 / 间隔 | `Restart=` / `RestartSec=` |
| 重启次数上限 / 统计窗口 | `StartLimitBurst=` / `StartLimitIntervalSec=` |
| 内存上限 | `MemoryMax=` |

工作目录下的 `.env` 会自动加载（不存在就忽略）。

### 启动命令怎么写

直接写你在项目目录里会敲的命令。命令名会去 `<工作目录>/node_modules/.bin` 和 `PATH`
里找，保存时解析成绝对路径写进 `ExecStart=` —— 所以 `systemctl cat` 看到的就是实际
执行的东西，没有运行时的 PATH 惊喜。

```
tsx scripts/monitor.ts        → /srv/app/node_modules/.bin/tsx scripts/monitor.ts
node dist/index.js            → /usr/local/bin/node dist/index.js
npm run monitor               → /usr/local/bin/npm run monitor
./start.sh                    → /srv/app/start.sh
/opt/node22/bin/node app.js   → 原样（绝对路径不查找）
```

同名时项目本地的 `.bin` 优先于全局，和 `npm run` 的行为一致。找不到命令时报错会列出
找过的目录。

两条来自 systemd 的硬约束：

- **不经过 shell** —— 管道、`&&`、`$VAR` 展开都不生效。需要这些就写成脚本文件，
  然后填 `./start.sh`。
- **最终必须是绝对路径** —— 上面的解析就是为了让你不用自己写。

多版本 node 就填不同的绝对路径（fnm / nvm / 官方 tarball 都行），不需要额外的版本
管理功能。

### 用 npm run 还是直接指到入口

两种都行。`npm run monitor` 直接这么填就可以。

**优雅退出不受影响。** systemd 的 `KillMode` 默认是 `control-group`，停止时 `SIGTERM`
发给 cgroup 里的每一个进程 —— 你的 node 进程会直接从 systemd 收到信号，不依赖 npm
转发。（只有显式设成 `KillMode=mixed` 才变成「只给主进程发 SIGTERM」。）

走 npm 的实际代价只有两条，都不影响功能：

- 多一个常驻 npm 进程，会算进 `MemoryCurrent`（列表里的内存数字）
- 列表里的 PID 是 npm 的，不是你的应用进程

想省掉这一层就把 `package.json` 里那条脚本的内容直接填进来 —— 比如
`"monitor": "tsx scripts/monitor.ts"` 就填 `tsx scripts/monitor.ts`。

### 失败重启次数

**默认会一直重启**，这点容易看错，说清楚。

systemd 的 `StartLimitBurst` / `StartLimitIntervalSec` 数的是**窗口内的启动次数**。
启动发生在 t=0、`RestartSec`、2·`RestartSec`……，所以窗口 `iv` 内最多只会发生
`floor(iv / RestartSec) + 1` 次启动。这个数不超过 burst 时，上限永远撞不到。

默认组合 burst=5 / 窗口=10 秒，配上模板里的 `RestartSec=3`：

```
启动时刻  0s   3s   6s   9s     →  10 秒窗口内 4 次 < 5 次上限  →  永远不停
```

要真的让它停下来，**窗口必须大于 `次数上限 × 重启间隔`**：

| 想要的效果 | 重启间隔 | 次数上限 | 统计窗口 |
|---|---|---|---|
| 崩 5 次就放弃 | 3 | 5 | **16**（> 5×3） |
| 崩 3 次就放弃 | 5 | 3 | **16**（> 3×5） |
| 永远重试（当前默认行为） | 3 | 留空 | 留空，或填 `0` |
| 崩一次就不管 | — | — | 重启策略选 `no` |

表单里这两个字段下面会**实时算出当前设置的实际效果**，包括「这个组合永远不会停，
要停窗口至少填 N」。算术在 `public/restart-limit.js`，浏览器和单元测试共用一份 ——
这个公式我第一版写错过，所以专门测了。

撞上限后状态变 `failed`、死因显示 `start-limit-hit`。面板点「启动」会自动先
`systemctl reset-failed` 清掉计数再启动，否则 systemd 会直接拒绝
（`start request repeated too quickly`）。

## 日志

页面里实时跟随（SSE），可暂停自动滚动、按正则搜索、下载。

两个专门为排查做的东西：

- **只看本次运行** —— 崩溃重启循环时几十次运行的日志糊在一起没法读。按 systemd 的
  InvocationID 精确切出当前这一次。
- **列表里直接显示死因** —— `Result=oom-kill` 时应用日志里通常什么都没有，
  只能从这里看出来。重启次数也显眼标出，因为 2 秒轮询会漏掉瞬时的崩溃循环状态。

systemd 自己的消息（`Started` / `Main process exited, status=1` / `Scheduled restart`）
不做过滤 —— 它们和应用日志在同一条时间线上，是排查崩溃最有用的部分。

## 常见启动失败

项目状态是 `failed`、但应用日志里什么都没有时，先看 `runnode log <项目> -n 50`
里 systemd 自己那几行。

**`Failed at step EXEC ... Permission denied`**

运行用户无法执行 node。最常见的是 node 装在 root 家目录里（nvm / fnm / n），
`/usr/local/bin/node` 只是软链，真身在 `/root/.nvm/versions/...`，而 `/root` 是 `0700`，
别的用户连穿过去都不行。

```sh
namei -l /usr/local/bin/node    # 逐段看权限，哪一段是 drwx------ 就是它
```

修法：把 node 装到全局可达的位置（官方 tarball 解到 `/usr/local`），
或者二进制本身权限不对时 `chmod 755`。面板保存时会先以目标用户身份 `test -x` 一次，
所以正常情况下你会在表单上就被拦住，而不是等启动失败。

**`Failed at step CHDIR`，或工作目录报属主不对**

同一类问题：代码放在 `/root/xxx` 下时，即使 chown 给了项目用户，它也穿不过 `/root`。
代码放 `/srv` 或 `/home` 下。

**`Result=oom-kill`**

被内核 OOM 杀掉，应用日志里通常什么都没有。列表里会直接显示这个死因。
调大或去掉表单里的「内存上限」，或者去查内存泄漏。

**`EADDRINUSE`**

端口被占。`ss -ltnp | grep :<端口>` 看是谁占的 —— 常见是同一个项目的旧进程还在，
或者你之前手动 `node app.js` 跑的那个没关。

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
