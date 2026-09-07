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
  node: '/usr/local/bin/node',
  args: 'dist/index.js --port 3000',
  env: { NODE_ENV: 'production', PORT: '3000' },
  restart: 'always',
  restartSec: 3,
  memoryMax: '512M',
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
  for (const field of ['args', 'user', 'memoryMax']) {
    assert.throws(() => sd.validate({ ...base, [field]: inject }), /换行|不合法/,
      field + ' 应该拒绝换行');
  }
  assert.throws(() => sd.validate({ ...base, env: { X: inject } }), /换行/);
  assert.throws(() => sd.validate({ ...base, env: { 'X\nUser': 'y' } }), /换行/);
  assert.throws(() => sd.validate({ ...base, args: 'x\rUser=root' }), /换行/);
});

test('注入的值即使侥幸进到渲染，也不会产生新指令', () => {
  // env 值走 systemd 的双引号转义，所以就算换行漏过校验也只是引号里的字面量
  const text = sd.render({ ...base, env: { X: 'a"b' } });
  assert.match(text, /^Environment="X=a\\"b"$/m);
});

test('项目名和路径校验', () => {
  assert.throws(() => sd.unitPath('../../etc/passwd'), /不合法/);
  assert.throws(() => sd.unitPath('Foo'), /不合法/);
  assert.throws(() => sd.unitPath('9app'), /不合法/);
  assert.throws(() => sd.unitPath(''), /不合法/);
  assert.match(sd.unitPath('ok-app-1'), /runnode-ok-app-1\.service$/);
});

test('拒绝以 root 运行，除非显式允许', () => {
  assert.throws(() => sd.validate({ ...base, user: 'root' }), /root/);
});

test('重启策略和内存上限的取值受限', () => {
  assert.throws(() => sd.validate({ ...base, restart: 'sometimes' }), /重启策略/);
  assert.throws(() => sd.validate({ ...base, restartSec: 0 }), /RestartSec/);
  assert.throws(() => sd.validate({ ...base, restartSec: 1.5 }), /RestartSec/);
  assert.throws(() => sd.validate({ ...base, memoryMax: '512MB' }), /内存上限/);
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
