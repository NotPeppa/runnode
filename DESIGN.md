# runnode 设计

Node 项目管理面板。核心决定：**不自己写进程管理器**。systemd 已经提供了守护、
自动重启、开机自启、日志、CPU/内存统计、资源限制、用户隔离。面板只是 `systemctl`
和 `journalctl` 上面一层薄 UI。

## 1. 数据模型：unit 文件就是数据库

不用 SQLite，不用 JSON 存项目列表。每个项目 = 一个 systemd unit：

    /etc/systemd/system/runnode-<slug>.service

面板启动时 `systemctl list-units 'runnode-*'` 列出所有项目，`systemctl show` 读详情。
没有第二份状态，也就没有「面板记录和实际进程不一致」这类同步 bug。

slug 校验 `^[a-z][a-z0-9-]{0,31}$` —— 这同时挡住了写文件时的路径穿越。

列表接口固定 **2 次子进程调用**，不随项目数增长：`readdir` 目录拿到全部 unit 名
（本来就是我们的数据源，不用先问 systemctl），然后一次 `systemctl show` 把名字全传进去：

    systemctl show runnode-a.service runnode-b.service       -p Id,ActiveState,SubState,MainPID,ExecMainStartTimestamp,NRestarts,MemoryCurrent,CPUUsageNSec,UnitFileState

输出是按 unit 分组、空行分隔的 `Key=Value` 块，靠 `Id=` 归属。**不要**每个项目单独调
一次 show（20 个项目串行就是两秒），也不要加 `--value`（多 unit 时无法区分归属）。

### unit 模板（面板生成的全部内容）

```ini
[Unit]
Description=runnode: myapp
After=network.target

[Service]
Type=simple
User=myapp
WorkingDirectory=/srv/myapp
EnvironmentFile=-/srv/myapp/.env
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/local/bin/node dist/index.js
Restart=always
RestartSec=3
# 可选，默认不写
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

面板表单字段就是上面这些：名称、运行用户、工作目录、node 路径、启动参数、
环境变量、重启策略、内存上限。写文件 → `daemon-reload` → 完事。

- **开机自启** = `systemctl enable`，免费。
- **不同 node 版本** = ExecStart 写绝对路径（fnm/nvm 装的都能用），只是个字段。
- **CPU/内存/重启次数** = `systemctl show -p MemoryCurrent,CPUUsageNSec,NRestarts`，
  不用 ps，不用采样。（依赖 cgroup v2；老系统上 unit 里补 `MemoryAccounting=yes`
  `CPUAccounting=yes`，读不到就显示 `-`，不要报错。）

### 为什么不是「面板自己 fork 子进程」

方案 B（面板当守护进程管子进程，PM2 / 宝塔那种）需要自己实现：重启退避、僵尸回收、
面板崩溃后的孤儿进程、面板升级重启时子进程存活、日志采集与轮转、开机启动顺序、
per-project 资源限制。systemd 这些全都有。一个 unit 的成本只是一个文本文件加一个
cgroup，systemd 日常管几百个 unit；真正的开销是 node 进程本身，换谁守护都一样。

代价三条，接受：

1. **面板必须 root**（写 unit + `daemon-reload`）。不能接受 root 就改用 user unit
   （`~/.config/systemd/user/` + `systemctl --user` + `loginctl enable-linger`），
   代价是所有项目共用同一 uid，失去 `User=` 隔离。
2. **没有 cluster 和零停机 reload**（PM2 白送）。需要多核多实例就在应用内用 node 的
   `cluster` 模块，不要为此换掉 supervisor。
3. **绑死 systemd**，Alpine/OpenRC、容器内、本地 Windows 开发都不适用。

## 2. 服务端

单进程，依赖只有 express（路由 + 静态文件），其余全用 node 内置模块。

```
server.js            express app、鉴权、路由        ~250 行
systemd.js           unit 渲染/解析 + systemctl/journalctl 封装   ~150 行
public/index.html    UI，无构建步骤
install.sh           装到 /opt/runnode + 注册面板自身的 unit
runnode-panel.service
test/systemd.test.js node:test，测渲染/解析往返
```

API（8 个端点，够了）：

| 方法 | 路径 | 动作 |
|---|---|---|
| GET | `/api/projects` | list-units + show 汇总 |
| POST | `/api/projects` | 新建/更新 unit，daemon-reload |
| DELETE | `/api/projects/:slug` | stop + disable + 删文件 |
| POST | `/api/projects/:slug/:action` | start\|stop\|restart\|enable\|disable |
| GET | `/api/projects/:slug/logs` | SSE，`journalctl -u ... -n 200 -f` |
| POST | `/api/login` `/api/logout` | 会话 |

- 日志：直接透传 journalctl，不写日志文件、不做轮转、不做落库。
- 鉴权：单管理员，`node:crypto` 的 scrypt + timingSafeEqual，会话用 HMAC 签名
  cookie（`HttpOnly; SameSite=Strict`）。不上 JWT、不上 passport、不上 session store。
- 所有子进程用 `execFile`（不过 shell）。
- 前端：一个 index.html + 原生 fetch + SSE。没有打包、没有框架、没有 node_modules 前端树。

## 3. 面板自身的生命周期

`install.sh` 做四件事：拷贝到 `/opt/runnode`、`npm ci --omit=dev`、写
`/etc/systemd/system/runnode-panel.service`、`enable --now`。

```ini
[Service]
Type=simple
User=root
WorkingDirectory=/opt/runnode
Environment=RUNNODE_ADDR=127.0.0.1:7788
ExecStart=/usr/bin/node server.js
Restart=always
```

面板自己用 systemd 守护 —— 和它管理的项目同一套机制。升级 = git pull + `restart runnode-panel`。

## 4. 安全（这块不偷懒）

面板要写 `/etc/systemd/system` 并调 `systemctl`，所以跑在 root 下。因此：

- **默认只监听 `127.0.0.1:7788`**。外网访问走 SSH 隧道，或自己在前面挂 nginx + TLS。
  不提供「一键公网暴露」。
- **项目默认以非 root 用户运行**，`User=` 必填；填 root 需要显式确认。
- **只操作 `runnode-` 前缀的 unit**，其他 unit 一律拒绝，防止面板被用来动系统服务。
- 登录失败限流，密码 scrypt 存 `/etc/runnode/config.json`（0600）。
- CSRF：SameSite=Strict + 要求 `Content-Type: application/json`。

### `User=` 隔离到底挡住了什么

改用 user unit（免 root）会让所有项目跑在同一个 uid 下，丢掉的**只有项目之间的安全
边界**，但这条边界挡的是：

1. **`.env` 互读** —— A 能 `cat /srv/B/.env`，`chmod 600` 无效（属主就是它自己）。
   所有项目的密钥变成一个池子，A 的某个没审计的依赖出事，B 的凭据一起丢。
2. **互相 kill / ptrace** —— 对 node 尤其糟：给任意 node 进程发 `SIGUSR1` 会打开
   inspector（127.0.0.1:9229），接上去 `Runtime.evaluate` 即为该进程内任意代码执行。
   新版 node 有 `--disable-sigusr1`（已在 v24.13 确认存在），但那是要逐个项目记得加
   的补丁，不是边界。
3. **面板一起沦陷** —— user unit 模式下 cookie 签名密钥、密码 hash、unit 文件都归同一
   uid。任一项目 RCE = 伪造会话 + 改写其他项目的 unit + 可能改写面板代码。系统级 unit
   下这些在 root 属主的 `/etc`、`/opt`，项目用户碰不到。
4. **日志共用** —— 全进同一用户 journal，互相可读。
5. **绑不了 <1024 端口**（无 `CAP_NET_BIND_SERVICE`）。走 nginx 的话基本无感。

**没丢的**：`MemoryMax`/`CPUQuota` 等 cgroup 限额、重启策略、开机自启、per-unit 日志
分离 —— 这些按 unit 算，与 uid 无关，user unit 下照常工作。

`Protect*=` 一类沙箱指令在 user unit 下依赖内核 user namespace，行为随版本变化，
不要指望它补上这个洞。

**结论（已定）**：走**系统级 unit**，面板 root 运行。user unit 方案否决，不做双模式。
`User=` 只有系统级 unit 能给。

## 5. root 面板的落地细节

选了系统级 unit，下面这几条就是必须定的。

### 5.1 只渲染白名单字段，绝不接受原始 unit 文本

面板永远不把用户提交的字符串当 unit 文件内容写进去，只接受结构化字段再套模板渲染。
否则等于开放了一个「以 root 身份写任意 systemd 配置」的 web 接口。

**配套的注入点（必查）**：unit 文件是行式语法，字段值里的换行会变成新指令。
比如环境变量值填 `x
User=root` 就能把项目提权到 root。所以**所有字段值拒绝
`
` 和 `
`**，路径类字段额外要求绝对路径且真实存在。这是本项目最重要的一条校验。

`ExecStart` 本身是任意命令，这是面板的用途、不是漏洞 —— 前提是它以非 root 的
`User=` 运行。所以 `User=` 必填、拒绝 `root`（要填 root 需要显式二次确认）。

### 5.2 unix 用户由谁创建

面板创建：项目新建时若目标用户不存在，执行

    useradd --system --no-create-home --shell /usr/sbin/nologin <user>

**删除项目不删用户** —— 删用户会留下一堆无主文件，且不可逆。宁可留一个没用的系统
用户。用户名走和 slug 相同的校验。

### 5.3 目录属主不自动修

`WorkingDirectory` 若不属于目标用户，面板**拒绝创建并显示要执行的 `chown` 命令**，
不自己动手。理由：`chown -R` 一旦路径算错就是不可逆的系统级破坏，这个风险不值得
省用户一次复制粘贴。

<!-- ponytail: 先不做自动 chown。等这个手动步骤真的烦到人了，再加一键修复按钮，
     且必须带路径白名单（必须在 /srv 或 /home 下、层级 >= 2、非符号链接）。 -->

### 5.4 权限与路径

| 路径 | 属主/权限 |
|---|---|
| `/etc/systemd/system/runnode-*.service` | root:root 0644 |
| `/etc/runnode/config.json`（密码 hash、cookie 密钥） | root:root **0600** |
| `/opt/runnode`（面板代码） | root:root，项目用户不可写 |

项目日志只有 root 能读（journalctl -u），由面板做鉴权后转发 —— 项目之间读不到彼此日志。

### 5.5 顺带的好处

项目是独立 unit，所以**面板重启/升级不影响正在运行的项目**。`systemctl restart
runnode-panel` 期间所有业务照常跑。这是方案 B 拿不到的。

## 6. 日志：journalctl 够用，但要改两个默认值

**日志的目标已明确：排查问题方便。** 这条把 §6.6 的取舍直接定死 —— 时间范围过滤、
日志级别、与 systemd 状态同一时间线，三样都是排查刚需，所以 **journald 是唯一默认，
不做 `append:` 双模式**。

结论：够用。写日志文件 + 自己轮转那条路要实现采集、轮转、读取器三样，journald
全都有。但它的默认配置有两个会咬人的地方。

### 6.1 必须确认持久化（install.sh 检查）

很多发行版没有 `/var/log/journal` 目录，journald 就跑 volatile 模式
（`/run/log/journal`），**重启后日志全丢**。install.sh 检查并修复：

    [ -d /var/log/journal ] || {
      mkdir -p /var/log/journal
      systemd-tmpfiles --create --prefix /var/log/journal
      systemctl restart systemd-journald
    }

### 6.2 关掉 per-unit 限流（写进 unit 模板）

journald 默认 `RateLimitIntervalSec=30s` / `RateLimitBurst=10000`，话多的项目或崩溃
重启循环刷栈会触发限流，**静默丢行**，只留一句 "Suppressed N messages"。用户正盯着
日志排查时丢行最要命。unit 模板里直接放宽：

    LogRateLimitIntervalSec=0

### 6.3 已知限制：没有 per-unit 磁盘配额

journald 只有全局 `SystemMaxUse=`，没有按 unit 的配额。一个疯狂刷日志的项目会把其他
项目的历史挤出去。面板层面无解，只能把 `SystemMaxUse` 设成合理值（如 2G）然后接受。
个别量特别大的项目单独改成 `StandardOutput=append:/var/log/<slug>.log`。

<!-- ponytail: 不做日志配额和用量统计。真被挤掉过历史再说。 -->

### 6.4 读取方式

    journalctl -u runnode-<slug> -n 200 -f -o json --no-pager

用 `-o json`（每行一个 JSON 对象）而不是 `-o short`：自带 `PRIORITY` 和
`__REALTIME_TIMESTAMP`，前端可直接按级别上色，也不用猜多行消息的边界。
历史翻页用 `--since/--until`，搜索用 `-g <正则>`。

区分 stdout / stderr 依赖 journald 的 priority 映射，版本相关 —— 上服务器先跑
`journalctl -u X -p warning` 确认再决定要不要做这个筛选。

**实现要点**：每个打开的日志窗口 = 一个常驻 `journalctl -f` 子进程。SSE 连接断开
（`req.on('close')`）必须 `child.kill()`，否则用户多开几次页面就攒一堆孤儿进程。
并发 tail 数量设上限。

### 6.5 导出下载（覆盖「我要日志文件」的需求）

    GET /api/projects/:slug/logs/download?since=...&until=...

把 `journalctl -u ... --since ... -o short-iso` 的 stdout 直接管到 response，
带 `Content-Disposition: attachment`。约 5 行，不新增任何存储。

### 6.6 为什么不默认写日志文件

两种「写文件」要分开看：

**面板自己收集 stdout → 否决。** 面板不是项目的父进程（systemd 是），拿不到它的
stdout。要拿到就得让面板 fork 子进程 = 回到 §1 否决的方案 B。`ExecStart` 里塞管道
需要 `/bin/sh -c` 包一层，进程树和信号处理都会变脏。

**让 systemd 写文件 → 可行，是逃生阀而非默认：**

```ini
LogsDirectory=runnode/<slug>
StandardOutput=append:/var/log/runnode/<slug>/out.log
StandardError=append:/var/log/runnode/<slug>/err.log
```

轮转交给 logrotate（服务器自带），`copytruncate` 安全 —— systemd 以 `O_APPEND`
持有 fd，truncate 后下次写回到文件头，不产生空洞文件。

| | journald（默认） | append: + logrotate |
|---|---|---|
| per-项目配额/保留 | ✗ 只有全局 `SystemMaxUse` | ✓ logrotate 按项目配 |
| 受 journald 限流 | 需 §6.2 关掉 | ✓ 完全绕开 |
| 时间范围过滤 | ✓ `--since/--until` | ✗ 只有应用自打的时间戳，格式不可控 |
| 日志级别 | ✓ `PRIORITY` 字段 | ✗ 只能 grep 猜 |
| 与 systemd 状态同一时间线 | ✓ | ✗ 要对两个地方 |
| 面板代码量 | `spawn journalctl` ~15 行 | `spawn tail -F` ~15 行 + 一个 logrotate 配置 |

代码量基本相同，所以这不是「哪个更麻烦」，而是**拿配额换时间过滤和日志级别**。
面板的主场景是「看跑没跑、崩了看栈」，时间过滤和级别更值钱 → journald 做默认。
个别刷量特别大的项目在表单里勾选切到 `append:`。

<!-- ponytail: 只做 journald 一条路，不做 append: 开关。目标是排查方便，append: 会丢
     时间过滤和 PRIORITY,方向相反。 -->

### 6.7 让排查真正方便的三件事

存储选完之后，体验由这三条决定。

**a. 不过滤 systemd 自己的消息。** `journalctl -u X` 的输出里混着 `Started`、
`Main process exited, code=exited, status=1/FAILURE`、`Scheduled restart job`,
和应用日志在同一条时间线上。排查崩溃时这是最值钱的信息 ——「应用打完这行栈之后
systemd 说它 status=1 退出，3 秒后重启」。天然就有，不要为了界面干净滤掉。

**b.「只看本次运行」筛选。** 崩溃重启循环下几十次运行的日志糊在一起没法看。
systemd 为每次启动分配 InvocationID，可以精确切出一次运行:

    systemctl show runnode-<slug> -p InvocationID          # 当前这次
    journalctl _SYSTEMD_INVOCATION_ID=<id> -o json         # 只出这一次

这是文件方案做不到的，也是 journald 值这一票的主要原因。
列举历史 invocation 需要扫日志去重 → 放 v2,v1 只做「本次运行」+ 时间范围。

**c. 退出原因显示在项目详情，不要让人去日志里找。**

    systemctl show runnode-<slug> -p Result,ExecMainStatus,ExecMainCode

`Result` 的取值直接给出死因:`exit-code`、`signal`、`oom-kill`、`watchdog`、
`start-limit-hit`。其中 **`oom-kill` 尤其重要** —— 被 OOM 杀掉时应用日志里通常
什么都没有，只能从这里看出来，而 node 项目内存泄漏很常见。

**UI 侧**:日志窗口要有「暂停自动滚动」(崩溃循环时刷屏没法读)和搜索框(接 `-g`)。

## 7. 功能清单

每一项都落在前面已设计好的调用上，不引入新机制。**粗体 = v1 必做**，其余留到之后。

### 登录页
- **单管理员密码登录**(scrypt + HMAC 签名 cookie),**失败限流**
- 改密码(v1 先手动编 `/etc/runnode/config.json`)

### 项目列表(主页)
数据全部来自 §1 那一次批量 `systemctl show`，不额外调用:

- **状态**(running / stopped / failed / activating)、**运行时长**
  (`ExecMainStartTimestamp`)、**PID**
- **内存**(`MemoryCurrent`)、CPU 累计(`CPUUsageNSec`)、**重启次数**(`NRestarts`)
- **是否开机自启**(`UnitFileState`)
- **失败时显示死因**(`Result`，含 `oom-kill`，见 §6.7c)

行内操作:**启动 / 停止 / 重启 / 开机自启开关 / 日志 / 编辑 / 删除**

### 状态刷新：前端轮询，2 秒

列表数据是快照，靠**前端定时轮询**保持新鲜:

    setInterval(() => document.visibilityState === 'visible' && refresh(), 2000)

不做 SSE 推送，也不做 D-Bus 订阅。D-Bus 能拿到 systemd 的 `PropertiesChanged` 真事件、
零轮询，但要引一个 dbus 依赖再处理信号 —— 对 20 个项目的面板不值。轮询成本是每 2 秒
一次子进程调用(20 个项目约 50ms)，约 2.5% 占用，代码就是上面那一行。

三个配套细节:

1. **操作后立刻回状态**。`systemctl start/stop/restart` 是同步的(等 job 完成才返回),
   所以在 action handler 里紧接着 show 这一个 unit，把新状态随响应返回，前端直接更新
   那一行，不等下一个 tick。反正已经在 handler 里，免费。
2. **服务端 1 秒缓存**。`let cache = {t:0, v:null}`，让多标签页的轮询合并成一次子进程
   调用。三行，顺手做掉。
3. **`NRestarts` 要显眼**。轮询是取样，2 秒一次会漏掉 `activating → running → failed`
   的崩溃循环，可能正好采到 `running` 显得一切正常。状态正常但重启次数在涨，才是崩溃
   循环的真实信号。

日志侧本来就是 SSE 实时(§6.4)，不受此影响。

### 新建 · 编辑表单
就是 §1 unit 模板的白名单字段(校验规则见 §5.1):

- **项目名 slug**、**运行用户**(必填、拒绝 root、不存在则 `useradd`)
- **工作目录**(绝对路径 + 属主校验，不自动 chown，见 §5.3)
- **node 可执行路径**(绝对路径 —— 这就是多版本支持，不需要额外做版本管理)
- **启动参数**、**环境变量**(key=value，拒绝 `
`)
- `EnvironmentFile` 自定义路径(v1 固定 `<工作目录>/.env`,`-` 前缀容错)
- **重启策略 + `RestartSec`**、内存上限 `MemoryMax`

保存 = 渲染 unit → 写文件 → `daemon-reload`。

### 日志页
- **实时跟随**(SSE,`-o json`)、**暂停自动滚动**、**按 `PRIORITY` 上色**
- **只看本次运行**(InvocationID，见 §6.7b)
- 搜索(`-g`)、时间范围(`--since/--until`)、导出下载(§6.5)

### 面板自身
- **install.sh**:装到 `/opt/runnode`、注册 panel unit 并 enable、
  **journald 持久化检查**(§6.1)、**生成初始密码**

## 7.1 为什么这么切

v1 的最小可用集是：登录 + 列表带状态 + 启停重启 + 开机自启 + 新建编辑 + 实时日志 +
只看本次运行。砍掉的搜索/时间范围/导出/内存上限，是因为「实时跟随 + 只看本次运行」
已覆盖绝大多数排查场景，而这几项后加的成本和现在做一样低 —— 没有先做的理由。

**v2**:端口占用检测、`npm install/build` 一键(用
`systemd-run --unit=runnode-deploy-<slug>` 跑一次性任务，日志同样进 journal,
不需要面板自己管子进程)。
**v3**:git 拉取部署、nginx 站点配置。

## 8. 明确不做

多用户 / RBAC、SQLite、Docker、集群多机、监控历史曲线图、WebSocket 终端。
需要哪个再加，别提前搭架子。
