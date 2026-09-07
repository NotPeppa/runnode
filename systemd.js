'use strict';
// systemd 是本项目的进程管理后端。unit 文件就是数据库，这里只做渲染/解析和命令转发。
// 详见 DESIGN.md §1、§5.1。

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

const UNIT_DIR = process.env.RUNNODE_UNIT_DIR || '/etc/systemd/system';
const PREFIX = 'runnode-';
const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const ENVKEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESTART = new Set(['always', 'on-failure', 'no']);
const ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);

// Id 放第一个：多 unit 输出按空行分块，块内靠 Id 归属（见 list()）
const SHOW_PROPS = [
  'Id', 'ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestampMonotonic',
  'NRestarts', 'MemoryCurrent', 'CPUUsageNSec', 'UnitFileState',
  'Result', 'ExecMainStatus', 'ExecMainCode', 'InvocationID',
].join(',');

class Fail extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const unitName = (slug) => PREFIX + slug + '.service';

const BAD_SLUG = '项目名不合法（小写字母开头，只允许小写字母/数字/短横，最长 32）';

function unitPath(slug) {
  if (!SLUG_RE.test(slug)) throw new Fail(400, BAD_SLUG);
  return path.join(UNIT_DIR, unitName(slug));
}

// ---------------------------------------------------------------- 校验

// unit 文件是行式语法：字段值里的换行会变成新指令（如 x\nUser=root 提权到 root）。
// 这是本项目最重要的一条校验，见 DESIGN.md §5.1。
function line(v, what) {
  const s = String(v ?? '');
  if (/[\n\r\0]/.test(s)) throw new Fail(400, what + '不允许包含换行');
  return s.trim();
}

function absPath(v, what, opts) {
  const dir = opts && opts.dir;
  const s = line(v, what);
  if (!s.startsWith('/')) throw new Fail(400, what + '必须是绝对路径');
  if (/\s/.test(s)) throw new Fail(400, what + '不允许包含空格');
  let st;
  try { st = fs.statSync(s); } catch { throw new Fail(400, what + '不存在：' + s); }
  if (dir && !st.isDirectory()) throw new Fail(400, what + '不是目录：' + s);
  if (!dir && !st.isFile()) throw new Fail(400, what + '不是文件：' + s);
  return s;
}

function validate(input) {
  const slug = line(input.slug, '项目名');
  if (!SLUG_RE.test(slug)) throw new Fail(400, BAD_SLUG);

  const user = line(input.user, '运行用户');
  if (!USER_RE.test(user)) throw new Fail(400, '运行用户名不合法');
  if (user === 'root' && !input.allowRoot) {
    throw new Fail(400,
      '拒绝以 root 运行项目：那样进程里任何代码（含未审计的 npm 依赖）都能读写整台机器。\n' +
      '建议改用专用用户，面板会自动创建，你只需把工作目录给它：\n' +
      '  chown -R <用户名>: ' + (line(input.cwd || '<工作目录>', '工作目录') || '<工作目录>') + '\n' +
      '确实需要 root，请勾选表单里的「允许以 root 运行」。');
  }

  const args = line(input.args, '启动参数');
  if (!args) throw new Fail(400, '启动参数不能为空（例如 dist/index.js）');

  const env = {};
  for (const [k, v] of Object.entries(input.env || {})) {
    const key = line(k, '环境变量名');
    if (!ENVKEY_RE.test(key)) throw new Fail(400, '环境变量名不合法：' + key);
    env[key] = line(v, '环境变量 ' + key + ' 的值');
  }

  const restart = line(input.restart || 'always', '重启策略');
  if (!RESTART.has(restart)) throw new Fail(400, '重启策略只能是 always / on-failure / no');

  const restartSec = Number(input.restartSec == null ? 3 : input.restartSec);
  if (!Number.isInteger(restartSec) || restartSec < 1 || restartSec > 3600) {
    throw new Fail(400, 'RestartSec 必须是 1..3600 的整数');
  }

  const memoryMax = line(input.memoryMax || '', '内存上限');
  if (memoryMax && !/^\d+[KMG]?$/.test(memoryMax)) {
    throw new Fail(400, '内存上限格式形如 512M / 2G');
  }

  // 碰文件系统的检查放最后：纯字符串校验（含换行注入）先跑完，失败得更快也更安全
  const cwd = absPath(input.cwd, '工作目录', { dir: true });
  const node = absPath(input.node, 'node 可执行文件');

  return { slug, user, cwd, node, args, env, restart, restartSec, memoryMax };
}

// ---------------------------------------------------------------- 渲染 / 解析

const quote = (s) => '"' + s.replace(/[\\"]/g, (m) => '\\' + m) + '"';

function render(p) {
  return [
    '# Managed by runnode. 手改会被面板覆盖。',
    '',
    '[Unit]',
    'Description=runnode: ' + p.slug,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'User=' + p.user,
    'WorkingDirectory=' + p.cwd,
    'EnvironmentFile=-' + p.cwd + '/.env',
    ...Object.entries(p.env).map(([k, v]) => 'Environment=' + quote(k + '=' + v)),
    'ExecStart=' + p.node + ' ' + p.args,
    'Restart=' + p.restart,
    'RestartSec=' + p.restartSec,
    // 崩溃循环刷栈时 journald 默认会静默丢行，见 DESIGN.md §6.2
    'LogRateLimitIntervalSec=0',
    ...(p.memoryMax ? ['MemoryMax=' + p.memoryMax] : []),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function parse(slug, text) {
  const one = (k) => {
    const m = text.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };

  const env = {};
  for (const m of text.matchAll(/^Environment="(.*)"$/gm)) {
    const raw = m[1].replace(/\\(.)/g, '$1');
    const i = raw.indexOf('=');
    if (i > 0) env[raw.slice(0, i)] = raw.slice(i + 1);
  }

  // node 路径不允许空格（见 absPath），所以按第一个空格切是安全的
  const exec = one('ExecStart');
  const sp = exec.indexOf(' ');

  return {
    slug,
    user: one('User'),
    cwd: one('WorkingDirectory'),
    node: sp < 0 ? exec : exec.slice(0, sp),
    args: sp < 0 ? '' : exec.slice(sp + 1),
    env,
    restart: one('Restart') || 'always',
    restartSec: Number(one('RestartSec') || 3),
    memoryMax: one('MemoryMax'),
  };
}

// ---------------------------------------------------------------- 读

async function systemctl(args) {
  try {
    const r = await execFileP('systemctl', args, { maxBuffer: 16 << 20 });
    return r.stdout;
  } catch (e) {
    // systemctl 用非零退出码表达「服务没在跑」等正常状态，stdout 仍然有效
    if (e.stdout) return e.stdout;
    throw new Fail(500, String(e.stderr || e.message).trim());
  }
}

const NOT_SET = new Set(['', '[not set]', '18446744073709551615', '0']);
const num = (v) => (NOT_SET.has(v) ? null : Number(v));

async function bootUptimeSec() {
  try {
    const s = await fs.promises.readFile('/proc/uptime', 'utf8');
    return parseFloat(s.split(' ')[0]);
  } catch { return null; }
}

function blocks(stdout) {
  return stdout
    .split(/\n\s*\n/)
    .map((b) => {
      const map = {};
      for (const l of b.split('\n')) {
        const i = l.indexOf('=');
        if (i > 0) map[l.slice(0, i)] = l.slice(i + 1);
      }
      return map;
    })
    .filter((m) => m.Id);
}

function toStatus(m, up) {
  const monoUs = num(m.ExecMainStartTimestampMonotonic);
  return {
    slug: m.Id.replace(PREFIX, '').replace(/\.service$/, ''),
    state: m.ActiveState || 'unknown',
    sub: m.SubState || '',
    pid: num(m.MainPID),
    // 时区缩写有歧义（CST），所以不解析人类时间戳，用 monotonic + /proc/uptime
    uptimeSec: monoUs && up ? Math.max(0, Math.round(up - monoUs / 1e6)) : null,
    restarts: Number(m.NRestarts || 0),
    memory: num(m.MemoryCurrent),
    cpuSec: num(m.CPUUsageNSec) ? Number(m.CPUUsageNSec) / 1e9 : null,
    enabled: m.UnitFileState === 'enabled',
    // Result=oom-kill 时应用日志里通常什么都没有，见 DESIGN.md §6.7c
    result: m.Result && m.Result !== 'success' ? m.Result : '',
    exitStatus: m.ExecMainCode === '1' ? Number(m.ExecMainStatus) : null,
    invocation: m.InvocationID || '',
  };
}

async function slugs() {
  const files = await fs.promises.readdir(UNIT_DIR).catch(() => []);
  return files
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.service'))
    .map((f) => f.slice(PREFIX.length, -'.service'.length))
    .filter((s) => SLUG_RE.test(s))
    .sort();
}

// `systemctl show` 多 unit 的输出形状是本文件唯一的外部格式依赖（见 test/）
function parseShow(stdout, up) {
  return blocks(stdout).map((m) => toStatus(m, up));
}

// 固定 2 次子进程调用（readdir + 一次 show），不随项目数增长。见 DESIGN.md §1。
async function list() {
  const names = (await slugs()).map(unitName);
  if (!names.length) return [];
  const up = await bootUptimeSec();
  const out = parseShow(await systemctl(['show', ...names, '-p', SHOW_PROPS]), up);
  if (out.length === names.length) return out;

  // 老版本 systemctl 可能不用空行分隔多 unit。分块数不对就退化成逐个查。
  // ponytail: 只在数量不匹配时退化，正常路径仍是一次调用。
  const each = [];
  for (const n of names) {
    each.push(...parseShow(await systemctl(['show', n, '-p', SHOW_PROPS]), up));
  }
  return each;
}

async function get(slug) {
  const text = await fs.promises.readFile(unitPath(slug), 'utf8').catch(() => {
    throw new Fail(404, '项目不存在');
  });
  return parse(slug, text);
}

async function status(slug) {
  const up = await bootUptimeSec();
  const b = blocks(await systemctl(['show', unitName(slug), '-p', SHOW_PROPS]));
  return b[0] ? toStatus(b[0], up) : null;
}

// ---------------------------------------------------------------- 写

async function uid(user) {
  const r = await execFileP('id', ['-u', user]);
  return Number(r.stdout.trim());
}

async function ensureUser(user) {
  try {
    await uid(user);
    return false;
  } catch { /* 不存在，建 */ }
  try {
    await execFileP('useradd',
      ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', user]);
    return true;
  } catch (e) {
    throw new Fail(500, '创建用户 ' + user + ' 失败：' + String(e.stderr || e.message).trim());
  }
}

async function save(input) {
  const p = validate(input);

  if (p.user !== 'root') {
    await ensureUser(p.user);
    // chown -R 路径算错就是不可逆的系统级破坏，所以只检查不修。见 DESIGN.md §5.3。
    // ponytail: 手动 chown 烦到人了再加一键修复，且必须带路径白名单。
    const st = fs.statSync(p.cwd);
    if (st.uid !== await uid(p.user)) {
      throw new Fail(400,
        '工作目录属主不是 ' + p.user + '。请在服务器上执行：\n  chown -R ' + p.user + ': ' + p.cwd);
    }
  }

  await fs.promises.writeFile(unitPath(p.slug), render(p), { mode: 0o644 });
  await systemctl(['daemon-reload']);
  return p;
}

async function act(slug, action) {
  if (!ACTIONS.has(action)) throw new Fail(400, '未知操作');
  unitPath(slug); // 校验 slug
  await systemctl([action, unitName(slug)]);
  // systemctl 是同步的（等 job 完成），所以这里拿到的状态已是新的。见 DESIGN.md §7。
  return status(slug);
}

async function remove(slug) {
  const file = unitPath(slug);
  await systemctl(['stop', unitName(slug)]).catch(() => {});
  await systemctl(['disable', unitName(slug)]).catch(() => {});
  await fs.promises.unlink(file).catch(() => {});
  await systemctl(['daemon-reload']);
  // 删项目不删 unix 用户：会留下一堆无主文件且不可逆。见 DESIGN.md §5.2。
}

// ---------------------------------------------------------------- 日志

function journalArgs(slug, opts) {
  const o = opts || {};
  const a = ['--no-pager'];
  if (o.invocation) {
    if (!/^[0-9a-f]{32}$/.test(o.invocation)) throw new Fail(400, 'InvocationID 不合法');
    // 只看本次运行，见 DESIGN.md §6.7b
    a.push('_SYSTEMD_INVOCATION_ID=' + o.invocation);
  } else {
    a.push('-u', unitName(slug));
  }
  const n = Math.min(Math.max(Number(o.lines) || 200, 1), 5000);
  a.push('-n', String(n));
  a.push('-o', o.json === false ? 'short-iso' : 'json');
  if (o.follow) a.push('-f');
  if (o.grep) a.push('-g', line(o.grep, '搜索词'));
  if (o.since) a.push('--since', line(o.since, '起始时间'));
  if (o.until) a.push('--until', line(o.until, '结束时间'));
  return a;
}

// 调用方必须在连接断开时 kill 返回的子进程，否则攒孤儿进程。见 DESIGN.md §6.4。
function journal(slug, opts) {
  unitPath(slug);
  return spawn('journalctl', journalArgs(slug, opts), { stdio: ['ignore', 'pipe', 'pipe'] });
}

module.exports = {
  Fail, UNIT_DIR, PREFIX, SLUG_RE, unitName, unitPath,
  validate, render, parse, journalArgs, parseShow, SHOW_PROPS,
  list, get, status, slugs, save, act, remove, journal, ensureUser,
};
