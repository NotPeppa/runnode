'use strict';
// runnode 面板。只有 express 一个依赖，其余用 node 内置模块。见 DESIGN.md §2。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sd = require('./systemd');

const CONFIG = process.env.RUNNODE_CONFIG || '/etc/runnode/config.json';
const ADDR = process.env.RUNNODE_ADDR || '127.0.0.1:7788';
const SESSION_DAYS = 7;
const MAX_TAILS = 8;

// ---------------------------------------------------------------- 配置

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    console.error('读不到配置 ' + CONFIG + '，先跑 install.sh 或 `node server.js --init <密码>`');
    process.exit(1);
  }
}

const scrypt = (password, salt) =>
  crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });

function initConfig(password) {
  if (!password || password.length < 8) {
    console.error('密码至少 8 位');
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const cfg = {
    salt,
    hash: scrypt(password, salt).toString('hex'),
    secret: crypto.randomBytes(32).toString('hex'),
  };
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log('已写入 ' + CONFIG);
}

if (process.argv[2] === '--init') {
  initConfig(process.argv[3]);
  process.exit(0);
}

const cfg = loadConfig();

// ---------------------------------------------------------------- 会话

// 单管理员，所以会话就是一个签名过的过期时间，不需要 store。
function sign(exp) {
  return crypto.createHmac('sha256', cfg.secret).update(String(exp)).digest('hex');
}

function makeCookie() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return 'rn=' + exp + '.' + sign(exp) +
    '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + SESSION_DAYS * 86400;
}

function authed(req) {
  const raw = /(?:^|;\s*)rn=([^;]+)/.exec(req.headers.cookie || '');
  if (!raw) return false;
  const [exp, mac] = raw[1].split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(sign(Number(exp)), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkPassword(password) {
  const a = scrypt(String(password || ''), cfg.salt);
  const b = Buffer.from(cfg.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 登录失败限流：同 IP 5 分钟内 5 次
const fails = new Map();
function rateLimited(ip) {
  const e = fails.get(ip);
  if (!e || Date.now() - e.t > 3e5) return false;
  return e.n >= 5;
}
function noteFail(ip) {
  const e = fails.get(ip);
  if (!e || Date.now() - e.t > 3e5) fails.set(ip, { n: 1, t: Date.now() });
  else e.n++;
}

// ---------------------------------------------------------------- app

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) return res.status(429).json({ error: '尝试过多，5 分钟后再试' });
  if (!checkPassword(req.body && req.body.password)) {
    noteFail(ip);
    return res.status(401).json({ error: '密码错误' });
  }
  fails.delete(ip);
  res.setHeader('Set-Cookie', makeCookie());
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'rn=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!authed(req)) return res.status(401).json({ error: '未登录' });
  // CSRF：SameSite=Strict 之外再要求 JSON content-type（表单无法伪造）。见 DESIGN.md §4。
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && !(req.is('application/json'))) {
    return res.status(415).json({ error: '需要 Content-Type: application/json' });
  }
  next();
});

// 1 秒缓存：多标签页轮询合并成一次子进程调用。见 DESIGN.md §7 状态刷新。
let listCache = { t: 0, v: null };
app.get('/api/projects', async (req, res, next) => {
  try {
    if (Date.now() - listCache.t < 1000 && listCache.v) return res.json(listCache.v);
    const v = await sd.list();
    listCache = { t: Date.now(), v };
    res.json(v);
  } catch (e) { next(e); }
});

app.get('/api/projects/:slug', async (req, res, next) => {
  try {
    const p = await sd.get(req.params.slug);
    p.status = await sd.status(req.params.slug);
    res.json(p);
  } catch (e) { next(e); }
});

app.post('/api/projects', async (req, res, next) => {
  try {
    const p = await sd.save(req.body || {});
    listCache.t = 0;
    res.json({ ok: true, slug: p.slug, status: await sd.status(p.slug) });
  } catch (e) { next(e); }
});

app.delete('/api/projects/:slug', async (req, res, next) => {
  try {
    await sd.remove(req.params.slug);
    listCache.t = 0;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/projects/:slug/:action', async (req, res, next) => {
  try {
    const status = await sd.act(req.params.slug, req.params.action);
    listCache.t = 0;
    res.json({ ok: true, status });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- 日志

let tails = 0;

app.get('/api/projects/:slug/logs', (req, res, next) => {
  if (tails >= MAX_TAILS) return res.status(429).end('并发日志窗口过多');
  let child;
  try {
    child = sd.journal(req.params.slug, {
      lines: req.query.lines,
      follow: true,
      invocation: req.query.invocation || '',
      grep: req.query.grep || '',
      since: req.query.since || '',
      until: req.query.until || '',
    });
  } catch (e) { return next(e); }

  tails++;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l) res.write('data: ' + l + '\n\n');
  });
  child.stderr.on('data', (d) => {
    res.write('event: err\ndata: ' + JSON.stringify(String(d).trim()) + '\n\n');
  });

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  // 不 kill 就攒孤儿进程。见 DESIGN.md §6.4。
  const done = () => {
    clearInterval(ping);
    child.kill('SIGTERM');
    tails = Math.max(0, tails - 1);
    res.end();
  };
  req.on('close', done);
  child.on('exit', done);
});

app.get('/api/projects/:slug/logs/download', (req, res, next) => {
  let child;
  try {
    child = sd.journal(req.params.slug, {
      lines: 5000,
      json: false,
      invocation: req.query.invocation || '',
      since: req.query.since || '',
      until: req.query.until || '',
    });
  } catch (e) { return next(e); }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition',
    'attachment; filename="' + req.params.slug + '.log"');
  child.stdout.pipe(res);
  req.on('close', () => child.kill('SIGTERM'));
});

// ---------------------------------------------------------------- 收尾

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器错误' });
});

const [host, port] = ADDR.split(':');
app.listen(Number(port), host, () => {
  console.log('runnode 面板监听 http://' + ADDR);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn('警告：面板以 root 运行且监听非本地地址。请确认前面有 TLS 和访问控制。');
  }
});
