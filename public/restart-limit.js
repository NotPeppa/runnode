// 算出「崩溃后到底会不会停」。浏览器和 node 都能用（表单实时提示 + 单元测试共用一份）。
//
// systemd 数的是**窗口内的启动次数**，不是失败次数。启动发生在 t=0, RestartSec,
// 2·RestartSec …… 所以窗口 iv 内最多能发生 floor(iv / RestartSec) + 1 次启动。
// 这个数不超过 StartLimitBurst 时，上限永远撞不到 —— 无限重启。
// 默认组合（burst=5 / iv=10s）配上 RestartSec=3 恰好就是失效的：10 秒内只有 4 次。
(function (root) {
  root.restartLimitEffect = function (o) {
    const sec = Number(o.restartSec) || 3;
    const burst = Number(o.startLimitBurst) || 5;              // 留空 = systemd 默认 5
    const rawIv = String(o.startLimitIntervalSec == null ? '' : o.startLimitIntervalSec).trim();
    const iv = rawIv === '' ? 10 : Number(rawIv);              // 留空 = systemd 默认 10s
    const usingDefaults = String(o.startLimitBurst || '').trim() === '' && rawIv === '';

    if (o.restart === 'no') return { mode: 'no-restart' };
    if (iv === 0) return { mode: 'unlimited', sec };

    const maxStarts = Math.floor(iv / sec) + 1;
    if (maxStarts <= burst) {
      return {
        mode: 'never-stops',
        sec, burst, iv, maxStarts, usingDefaults,
        needIv: burst * sec + 1,   // 窗口至少要大于 burst × RestartSec 才可能撞上限
      };
    }
    return { mode: 'stops', sec, burst, iv, maxStarts, usingDefaults };
  };
}(typeof module !== 'undefined' && module.exports ? module.exports : window));
