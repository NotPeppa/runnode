'use strict';
// 覆盖两件事：unit 渲染/解析的往返，和字段值的注入拒绝（DESIGN.md §5.1 的那条）。
// 不碰 systemd，所以在任何平台上都能跑：node --test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sd = require('../systemd');

const base = {
  slug: 'myapp',
  user: 'myapp',
  cwd: '/srv/myapp',
  exec: '/usr/local/bin/node dist/index.js --port 3000',
  env: { NODE_ENV: 'production', PORT: '3000' },
  restart: 'always',
  restartSec: 3,
  memoryMax: '512M',
  startLimitBurst: '',
  startLimitIntervalSec: '',
};

test('render → parse 往返不丢字段', () => {
  const back = sd.parse('myapp', sd.render(base));
  assert.deepEqual(back, base);
});

test('环境变量里的空格、引号、反斜杠能原样往返', () => {
  const p = {
    ...base,
    env: {
      MSG: 'hello world',
      JSON_CFG: '{"a":"b"}',
      WINPATH: 'C:\\tmp\\x',
      TRAILING: 'a"b\\',
    },
  };
  assert.deepEqual(sd.parse('myapp', sd.render(p)).env, p.env);
});

test('没有环境变量和内存上限时也能往返', () => {
  const p = { ...base, env: {}, memoryMax: '' };
  assert.deepEqual(sd.parse('myapp', sd.render(p)), p);
});

test('渲染出的 unit 带上了防丢日志和自启', () => {
  const text = sd.render(base);
  assert.match(text, /^LogRateLimitIntervalSec=0$/m);
  assert.match(text, /^WantedBy=multi-user\.target$/m);
  assert.match(text, /^ExecStart=\/usr\/local\/bin\/node dist\/index\.js --port 3000$/m);
});

// 这是本项目最重要的一条校验：unit 是行式语法，值里的换行会变成新指令。
test('字段值里的换行被拒绝（否则可注入 User=root 提权）', () => {
  const inject = 'x\nUser=root';
  for (const field of ['exec', 'user', 'memoryMax']) {
    assert.throws(() => sd.validate({ ...base, [field]: inject }), /换行|不合法/,
      field + ' 应该拒绝换行');
  }
  assert.throws(() => sd.validate({ ...base, env: { X: inject } }), /换行/);
  assert.throws(() => sd.validate({ ...base, env: { 'X\nUser': 'y' } }), /换行/);
  assert.throws(() => sd.validate({ ...base, exec: 'x\rUser=root' }), /换行/);
});

test('注入的值即使侥幸进到渲染，也不会产生新指令', () => {
  // env 值走 systemd 的双引号转义，所以就算换行漏过校验也只是引号里的字面量
  const text = sd.render({ ...base, env: { X: 'a"b' } });
  assert.match(text, /^Environment="X=a\\"b"$/m);
});

test('启动命令可以是 npm 等任意可执行文件，不假设入口是 node', () => {
  for (const cmd of [
    '/usr/local/bin/npm start',
    '/usr/local/bin/npm run monitor',
    '/usr/local/bin/node --max-old-space-size=2048 server.js',
    '/srv/app/start.sh',
  ]) {
    const text = sd.render({ ...base, exec: cmd });
    assert.match(text, new RegExp('^ExecStart=' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
    assert.equal(sd.parse('myapp', text).exec, cmd);
  }
  // 首段就是要做存在性/权限检查的那个可执行文件
  assert.equal(sd.execBin('/usr/local/bin/npm run monitor'), '/usr/local/bin/npm');
  assert.equal(sd.execBin('/usr/local/bin/node'), '/usr/local/bin/node');
});

test('启动命令不能为空', () => {
  assert.throws(() => sd.validate({ ...base, exec: '' }), /启动命令不能为空/);
});

// 人想写的是 `tsx scripts/monitor.ts`，不是绝对路径。首段解析成绝对路径后再写进 unit，
// 所以 systemctl cat 看到的就是实际执行的东西。exists 注入以便跨平台跑。
test('命令名解析：node_modules/.bin 优先，其次 PATH', () => {
  const CWD = '/srv/maoyan';
  const dirs = [CWD + '/node_modules/.bin', '/usr/local/bin', '/usr/bin'];
  const has = (...paths) => (f) => paths.includes(f);

  // 项目本地依赖（tsx / vite / nest 这类）
  assert.equal(
    sd.resolveBin('tsx', CWD, dirs, has(CWD + '/node_modules/.bin/tsx')),
    CWD + '/node_modules/.bin/tsx');

  // 本地没有就往 PATH 找
  assert.equal(
    sd.resolveBin('npm', CWD, dirs, has('/usr/local/bin/npm')),
    '/usr/local/bin/npm');

  // 同名时本地优先（项目锁定的版本应该赢过全局的）
  assert.equal(
    sd.resolveBin('tsx', CWD, dirs, has(CWD + '/node_modules/.bin/tsx', '/usr/local/bin/tsx')),
    CWD + '/node_modules/.bin/tsx');

  // 绝对路径原样返回，不去查
  assert.equal(sd.resolveBin('/opt/node/bin/node', CWD, dirs, () => false), '/opt/node/bin/node');

  // 带斜杠的当成相对工作目录，不去猜 PATH
  assert.equal(sd.resolveBin('./start.sh', CWD, dirs, () => false), CWD + '/start.sh');
  assert.equal(sd.resolveBin('scripts/run.sh', CWD, dirs, () => false), CWD + '/scripts/run.sh');

  // 找不到就是 null，由 validate 报出「找过哪些目录」
  assert.equal(sd.resolveBin('nope', CWD, dirs, () => false), null);
});

test('binDirs 把项目本地 .bin 排在最前，且只收绝对路径', () => {
  const dirs = sd.binDirs('/srv/maoyan');
  assert.equal(dirs[0], '/srv/maoyan/node_modules/.bin');
  assert.ok(dirs.every((d) => d.startsWith('/')), 'Windows 上的 PATH 项要被过滤掉');
  assert.equal(new Set(dirs).size, dirs.length, '不该有重复目录');
});

test('找不到命令时报错列出找过的目录', () => {
  // cwd 用 '/'：任何平台上都存在，这条测试才不依赖环境里有 /srv/myapp
  assert.throws(() => sd.validate({ ...base, cwd: '/', exec: 'definitely-not-a-real-bin x' }), (e) => {
    assert.match(e.message, /找不到命令 definitely-not-a-real-bin/);
    assert.match(e.message, /node_modules\/\.bin/);
    return true;
  });
});

test('项目名和路径校验', () => {
  assert.throws(() => sd.unitPath('../../etc/passwd'), /不合法/);
  assert.throws(() => sd.unitPath('Foo'), /不合法/);
  assert.throws(() => sd.unitPath('9app'), /不合法/);
  assert.throws(() => sd.unitPath(''), /不合法/);
  assert.match(sd.unitPath('ok-app-1'), /runnode-ok-app-1\.service$/);
});

test('拒绝以 root 运行，并给出可执行的出路', () => {
  assert.throws(() => sd.validate({ ...base, user: 'root' }), (e) => {
    assert.match(e.message, /拒绝以 root 运行/);
    // 报错必须自带出路：chown 命令 + 勾选框的名字（消息里提到的东西界面上要真有）
    assert.match(e.message, /chown -R <用户名>: \/srv\/myapp/);
    assert.match(e.message, /允许以 root 运行/);
    return true;
  });
});

test('显式 allowRoot 后不再因 root 被拒', () => {
  try {
    sd.validate({ ...base, user: 'root', allowRoot: true });
  } catch (e) {
    // 这台机器上 /srv/myapp 不存在，所以还会因路径报错 —— 但不该再是 root 那条
    assert.doesNotMatch(e.message, /拒绝以 root/);
  }
});

test('重启次数上限：留空不写入 unit，设了就写进 [Unit] 段', () => {
  // 留空 → 不出现，交给 systemd 默认（10 秒 5 次）
  const bare = sd.render(base);
  assert.doesNotMatch(bare, /StartLimit/);

  const p = { ...base, startLimitBurst: '3', startLimitIntervalSec: '60' };
  const text = sd.render(p);
  assert.match(text, /^StartLimitBurst=3$/m);
  assert.match(text, /^StartLimitIntervalSec=60$/m);
  // 必须在 [Unit] 段里：写到 [Service] 里 systemd 229+ 会忽略
  const unitSection = text.slice(text.indexOf('[Unit]'), text.indexOf('[Service]'));
  assert.match(unitSection, /StartLimitBurst=3/);
  assert.match(unitSection, /StartLimitIntervalSec=60/);
  // 回读
  assert.deepEqual(sd.parse('myapp', text), p);

  // 窗口 0 = 不限次数，也要能写进去（别被「留空」的判断吃掉）
  assert.match(sd.render({ ...base, startLimitIntervalSec: '0' }), /^StartLimitIntervalSec=0$/m);
});

test('重启策略和内存上限的取值受限', () => {
  assert.throws(() => sd.validate({ ...base, restart: 'sometimes' }), /重启策略/);
  assert.throws(() => sd.validate({ ...base, restartSec: 0 }), /RestartSec/);
  assert.throws(() => sd.validate({ ...base, restartSec: 1.5 }), /RestartSec/);
  assert.throws(() => sd.validate({ ...base, memoryMax: '512MB' }), /内存上限/);
  assert.throws(() => sd.validate({ ...base, startLimitBurst: 'abc' }), /重启次数上限/);
  assert.throws(() => sd.validate({ ...base, startLimitBurst: '-1' }), /重启次数上限/);
  assert.throws(() => sd.validate({ ...base, startLimitIntervalSec: '10s' }), /重启统计窗口/);
});

test('journalctl 参数：默认按 unit，指定 InvocationID 时只看本次运行', () => {
  const a = sd.journalArgs('myapp', { lines: 50 });
  assert.deepEqual(a, ['--no-pager', '-u', 'runnode-myapp.service', '-n', '50', '-o', 'json']);

  const inv = 'a'.repeat(32).replace(/a/g, '0');
  const b = sd.journalArgs('myapp', { invocation: inv, follow: true });
  assert.ok(b.includes('_SYSTEMD_INVOCATION_ID=' + inv));
  assert.ok(!b.includes('-u'));
  assert.ok(b.includes('-f'));

  assert.throws(() => sd.journalArgs('myapp', { invocation: 'not-a-uuid' }), /Invocation/);
  assert.throws(() => sd.journalArgs('myapp', { grep: 'a\nb' }), /换行/);
  // 行数上限，防止一次拉爆内存
  assert.ok(sd.journalArgs('myapp', { lines: 99999 }).includes('5000'));
});

// `systemctl show` 的输出形状是本项目唯一的外部格式依赖。用真实形状的样本锁住它：
// 服务器上格式若不同，是这个测试先报错，而不是面板显示一堆「—」。
// 样本命令：systemctl show runnode-a.service runnode-b.service -p <SHOW_PROPS>
const SHOW_SAMPLE = [
  'Id=runnode-web.service',
  'ActiveState=active',
  'SubState=running',
  'MainPID=4211',
  'ExecMainStartTimestampMonotonic=90000000',
  'NRestarts=2',
  'MemoryCurrent=104857600',
  'CPUUsageNSec=12500000000',
  'UnitFileState=enabled',
  'Result=success',
  'ExecMainStatus=0',
  'ExecMainCode=0',
  'InvocationID=6d3f1b9c4e2a47c8b5d0e1f2a3b4c5d6',
  '',
  'Id=runnode-api.service',
  'ActiveState=failed',
  'SubState=failed',
  'MainPID=0',
  'ExecMainStartTimestampMonotonic=0',
  'NRestarts=7',
  'MemoryCurrent=[not set]',
  'CPUUsageNSec=[not set]',
  'UnitFileState=disabled',
  'Result=oom-kill',
  'ExecMainStatus=9',
  'ExecMainCode=1',
  'InvocationID=',
  '',
].join('\n');

test('解析 systemctl show 的多 unit 输出', () => {
  const [web, api] = sd.parseShow(SHOW_SAMPLE, 3600); // /proc/uptime = 3600s

  assert.equal(web.slug, 'web');
  assert.equal(web.state, 'active');
  assert.equal(web.pid, 4211);
  assert.equal(web.uptimeSec, 3510); // 3600 - 90
  assert.equal(web.restarts, 2);
  assert.equal(web.memory, 104857600);
  assert.equal(web.cpuSec, 12.5);
  assert.equal(web.enabled, true);
  assert.equal(web.result, ''); // success 不显示
  assert.equal(web.invocation, '6d3f1b9c4e2a47c8b5d0e1f2a3b4c5d6');

  assert.equal(api.slug, 'api');
  assert.equal(api.state, 'failed');
  assert.equal(api.pid, null);
  assert.equal(api.uptimeSec, null);
  assert.equal(api.restarts, 7);
  // 关掉 cgroup 统计时是 [not set]，要显示成「—」而不是 NaN
  assert.equal(api.memory, null);
  assert.equal(api.cpuSec, null);
  assert.equal(api.enabled, false);
  // 被 OOM 杀掉时应用日志里通常什么都没有，只能靠这个（DESIGN.md §6.7c）
  assert.equal(api.result, 'oom-kill');
  assert.equal(api.exitStatus, 9);
});

test('cgroup 统计返回 UINT64_MAX 时也当作未启用', () => {
  const s = sd.parseShow('Id=runnode-x.service\nMemoryCurrent=18446744073709551615\n', 10)[0];
  assert.equal(s.memory, null);
});

test('SHOW_PROPS 里 Id 必须在第一位（多 unit 分块靠它归属）', () => {
  assert.match(sd.SHOW_PROPS, /^Id,/);
});

// 「崩溃后到底会不会停」的算术。我第一版就把它算错过：默认 5 次/10 秒配上
// RestartSec=3，窗口里只会发生 4 次启动，上限永远撞不到 —— 实际是无限重启。
const { restartLimitEffect } = require('../public/restart-limit');

test('重启上限：默认组合配 RestartSec=3 实际不会停', () => {
  const e = restartLimitEffect({ restart: 'always', restartSec: 3 });
  assert.equal(e.mode, 'never-stops');
  assert.equal(e.maxStarts, 4);   // t=0,3,6,9
  assert.equal(e.burst, 5);
  assert.equal(e.iv, 10);
  assert.equal(e.usingDefaults, true);
  assert.equal(e.needIv, 16);     // 要 > 5×3
});

test('重启上限：窗口够大就真的会停', () => {
  const e = restartLimitEffect({
    restart: 'always', restartSec: 3, startLimitBurst: '5', startLimitIntervalSec: '20',
  });
  assert.equal(e.mode, 'stops');
  assert.equal(e.maxStarts, 7);
  assert.equal(e.usingDefaults, false);
});

test('重启上限：间隔短也能撞上默认上限', () => {
  // RestartSec=1 时 10 秒里有 11 次启动 > 5，默认配置就是有效的
  assert.equal(restartLimitEffect({ restart: 'always', restartSec: 1 }).mode, 'stops');
});

test('重启上限：重启间隔比窗口还长时同样撞不到', () => {
  const e = restartLimitEffect({
    restart: 'always', restartSec: 10, startLimitBurst: '3', startLimitIntervalSec: '10',
  });
  assert.equal(e.mode, 'never-stops');
  assert.equal(e.maxStarts, 2);
  assert.equal(e.needIv, 31);
});

test('重启上限：窗口 0 = 永远重试；策略 no = 不重试', () => {
  assert.equal(restartLimitEffect({ restart: 'always', startLimitIntervalSec: '0' }).mode, 'unlimited');
  assert.equal(restartLimitEffect({ restart: 'no' }).mode, 'no-restart');
  // 策略 no 优先于任何上限设置
  assert.equal(restartLimitEffect({ restart: 'no', startLimitIntervalSec: '0' }).mode, 'no-restart');
});
