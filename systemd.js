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

// ExecStart 的首段（那个可执行文件）。带空格的路径不支持 —— 服务器上属于病态情况，
// 支持它就得实现 systemd 的引号规则，不值得。
const execBin = (exec) => exec.split(' ')[0];

// systemd 的 ExecStart 首段必须是绝对路径，但人想写的是 `tsx scripts/monitor.ts`
// 或 `npm run monitor`。这里负责把首段解析成绝对路径，解析结果写进 unit ——
// 存的是绝对路径，所以 `systemctl cat` 看到的就是实际执行的东西，没有运行时惊喜。
function binDirs(cwd) {
  const fromPath = String(process.env.PATH || '').split(':').filter((d) => d.startsWith('/'));
  return [...new Set([
    cwd + '/node_modules/.bin',   // tsx / vite / nest 这类项目本地命令
    ...fromPath,
    '/usr/local/bin', '/usr/bin', '/bin',
  ])];
}

// exists 可注入，便于测试（真实调用走文件系统）
function resolveBin(tok, cwd, dirs, exists) {
  if (tok.startsWith('/')) return tok;                 // 已是绝对路径
  if (tok.includes('/')) return cwd + '/' + tok.replace(/^\.\//, ''); // ./start.sh
  for (const d of dirs) if (exists(d + '/' + tok)) return d + '/' + tok;
  return null;
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

  // 一个完整的 ExecStart。systemd 要求首段是绝对路径，这样 npm / pnpm / 自己的
  // 启动脚本都能写，不用再假设入口一定是 node。
  const exec = line(input.exec, '启动命令');
  if (!exec) {
    throw new Fail(400, '启动命令不能为空，例如 /usr/local/bin/node dist/index.js');
  }

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

  // 留空 = 用 systemd 默认（10 秒内最多 5 次）。窗口 0 = 不限次数。
  const startLimitBurst = line(input.startLimitBurst || '', '重启次数上限');
  if (startLimitBurst && !/^\d{1,4}$/.test(startLimitBurst)) {
    throw new Fail(400, '重启次数上限必须是 0..9999 的整数（留空用默认 5）');
  }
  const startLimitIntervalSec = line(input.startLimitIntervalSec || '', '重启统计窗口');
  if (startLimitIntervalSec && !/^\d{1,5}$/.test(startLimitIntervalSec)) {
    throw new Fail(400, '重启统计窗口必须是 0..99999 秒的整数（留空用默认 10，填 0 表示不限次数）');
  }

  // 碰文件系统的检查放最后：纯字符串校验（含换行注入）先跑完，失败得更快也更安全。
  const cwd = absPath(input.cwd, '工作目录', { dir: true });

  // 首段解析成绝对路径。只校验它，后面的参数不管。
  const tok = execBin(exec);
  const dirs = binDirs(cwd);
  const bin = resolveBin(tok, cwd, dirs, (f) => fs.existsSync(f));
  if (!bin) {
    throw new Fail(400,
      '找不到命令 ' + tok + '。找过这些目录：\n  ' + dirs.join('\n  ') + '\n' +
      '如果它是项目本地依赖，先在工作目录里装好（npm i），或直接填绝对路径。');
  }
  absPath(bin, '启动命令里的可执行文件');
  const execResolved = bin + exec.slice(tok.length);

  return {
    slug, user, cwd, exec: execResolved, env, restart, restartSec, memoryMax,
    startLimitBurst, startLimitIntervalSec,
  };
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
    // StartLimit* 在 [Unit] 段（systemd 229 起从 [Service] 移到这里）。
    // 留空则用系统默认：DefaultStartLimitIntervalSec=10s / DefaultStartLimitBurst=5。
    ...(p.startLimitBurst ? ['StartLimitBurst=' + p.startLimitBurst] : []),
    ...(p.startLimitIntervalSec ? ['StartLimitIntervalSec=' + p.startLimitIntervalSec] : []),
    '',
    '[Service]',
    'Type=simple',
    'User=' + p.user,
    'WorkingDirectory=' + p.cwd,
    'EnvironmentFile=-' + p.cwd + '/.env',
    ...Object.entries(p.env).map(([k, v]) => 'Environment=' + quote(k + '=' + v)),
    'ExecStart=' + p.exec,
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

  return {
    slug,
    user: one('User'),
    cwd: one('WorkingDirectory'),
    exec: one('ExecStart'),
    env,
    restart: one('Restart') || 'always',
    restartSec: Number(one('RestartSec') || 3),
    memoryMax: one('MemoryMax'),
    startLimitBurst: one('StartLimitBurst'),
    startLimitIntervalSec: one('StartLimitIntervalSec'),
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

// 目标用户能否执行/穿过某个路径。
// 只看属主和 mode 不够：node 常被装在 /root/.nvm 下再软链到 /usr/local/bin，
// 那样二进制本身是 755，但 /root 是 0700，别的用户穿不过去 —— 只有真的以那个
// 用户身份 test 一次才测得出来。返回 null 表示没有 runuser，跳过检查。
async function userCanExec(user, target) {
  try {
    await execFileP('runuser', ['-u', user, '--', 'test', '-x', target]);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return null; // 系统没有 runuser
    return false;
  }
}

async function save(input) {
  const p = validate(input);

  if (p.user !== 'root') {
    await ensureUser(p.user);

    // 这两条不拦的话，错误只会在启动后以
    // 「Failed at step EXEC ... Permission denied」的形式出现在 journal 里
    const bin = execBin(p.exec);
    if (await userCanExec(p.user, bin) === false) {
      throw new Fail(400,
        '用户 ' + p.user + ' 无法执行 ' + bin + '。\n' +
        '常见原因：node 装在 root 家目录里（nvm/fnm），/usr/local/bin/node 只是软链，' +
        '而 /root 是 0700，别的用户穿不过去。\n' +
        '定位：namei -l ' + bin + '\n' +
        '修法：把 node 装到 /usr/local 等全局可达位置，或 chmod 755 该二进制。');
    }
    if (await userCanExec(p.user, p.cwd) === false) {
      throw new Fail(400,
        '用户 ' + p.user + ' 无法进入工作目录 ' + p.cwd + '。\n' +
        '即使属主已经是它，父目录不可穿越也进不去（例如代码放在 /root 下）。\n' +
        '定位：namei -l ' + p.cwd + '\n' +
        '修法：把代码放到 /srv 或 /home 下。');
    }
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
  // 撞到 StartLimit 之后 systemctl start 会直接失败（start request repeated too
  // quickly），必须先清掉失败计数。用户点启动就是想再试一次。
  if (action === 'start' || action === 'restart') {
    await systemctl(['reset-failed', unitName(slug)]).catch(() => {});
  }
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
  validate, render, parse, journalArgs, parseShow, SHOW_PROPS, execBin,
  resolveBin, binDirs,
  list, get, status, slugs, save, act, remove, journal, ensureUser,
};
