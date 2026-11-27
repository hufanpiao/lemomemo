// 启动阶段的兜底计时器总表（全 app 评审 11-18 六.1：原来 10 来个计时器散在 7 个文件，看不出谁先谁后）。
// 运行代码不搬：这些常量各自留在用它的模块里（platform 不能引 app；懒加载块要是从首屏块引常量，首屏块就得多导出名字，首屏 JS 余量只剩约 100 B），
// 这里把每一个的时限、从哪一刻起算、到点做什么列在一张表里钉死，改任何一个都要先改这张表；下面再核文件头里写明了的先后关系。
// 启动画面的收起只有一个实现 platform/splash.ts 的 hideSplash（重复调用安全），触发点四个、各管一种情况，见最后一组
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AFTER_PAINT_TIMEOUT_MS } from '../after-paint.ts';
import { REMIND_ARM_WATCHDOG_MS, REMIND_MAX_WAIT_MS } from '../App.tsx';
import { LOOK_WAIT_MS } from '../look-wait.ts';
import { BLOCKED_RELEASE_MAX_MS } from '../root.tsx';
import { dur, FADE_WAIT_MS } from '../../motion/index.ts';
import { GATE_LIMIT_MS } from '../../platform/gate-limit.ts';
import { INSET_BACKSTOP_MS, INSET_MAX_MS, INSET_POLL_MS, INSET_QUIET_MS, INSET_ZERO_WAIT_MS } from '../../platform/inset-watch.ts';
import { APP_PAINT_BACKSTOP_MS } from '../../platform/root-paint.ts';
import { SPLASH_FADE_MS, SPLASH_MAX_MS } from '../../platform/splash.ts';
import { SW_REGISTER_WAIT_MS } from '../../platform/sw-register.ts';
import { GIVE_UP_MS } from '../../platform/vh-gapfix-gate.ts';

const main = readFileSync('src/app/main.tsx', 'utf8');
/** main.tsx 里没导出的那个：按源码文字读 */
const BOOT_FAIL_LOG_WAIT_MS = Number(/const BOOT_FAIL_LOG_WAIT_MS = (\d+);/.exec(main)?.[1]);

/** [名字, 现在的值, 应该是, 从哪一刻起算 → 到点做什么（文件）] */
const TIMELINE: readonly [string, number, number, string][] = [
  ['SPLASH_MAX_MS', SPLASH_MAX_MS, 5000, '入口模块开始执行 → 收起启动画面（splash.ts hideSplashAfter，main.tsx 第一行就挂）'],
  ['splash.css 纯 CSS 兜底', dur.splashFailsafe * 1000, 6000, '网页第一次绘制 → 脚本没跑起来也把启动画面淡掉（splash.css --dur-splash-failsafe）'],
  ['SPLASH_FADE_MS', SPLASH_FADE_MS, 220, '开始淡出 → 淡完（再加 80 ms 余量）从 DOM 移除，不等 transitionend（splash.ts）'],
  ['LOOK_WAIT_MS', LOOK_WAIT_MS, 600, 'createRoot 之前 → 不再等皮肤，按入口页默认皮肤画（look-wait.ts）'],
  ['GATE_LIMIT_MS', GATE_LIMIT_MS, 5000, 'GatedApp 挂上（含关口分包加载）→ 告知页关口放行画 App（gate-limit.ts，root.tsx、ConsentGate、useNoticeState 共用）'],
  ['首屏画完时限 GATE_LIMIT_MS + 1000', GATE_LIMIT_MS + 1000, 6000, 'render 之后 → 算首屏画完、放行同步等（main.tsx startAppPaintLimit）'],
  ['APP_PAINT_BACKSTOP_MS', APP_PAINT_BACKSTOP_MS, 15_000, 'render 之前 watchFirstPaint → 一定算首屏画完（root-paint.ts armAppPaint）'],
  ['BLOCKED_RELEASE_MAX_MS', BLOCKED_RELEASE_MAX_MS, 5000, '“库被挡住”解除 → #root 还没画出东西也卸掉整屏提示（root.tsx watchCacheBlocked）'],
  ['SW_REGISTER_WAIT_MS', SW_REGISTER_WAIT_MS, 3000, 'version_too_new 渲染前 → 不再等 SW 注册，照样画整屏提示（root.tsx startRoot）'],
  ['INSET_QUIET_MS', INSET_QUIET_MS, 120, '首屏画完后底部安全区和 innerHeight 不变这么久 → 算稳定，底栏淡入（inset-watch.ts）'],
  ['INSET_ZERO_WAIT_MS', INSET_ZERO_WAIT_MS, 600, '主屏幕版读到 0 → 画完后多等到这一刻再算稳定（inset-watch.ts）'],
  ['INSET_MAX_MS', INSET_MAX_MS, 1500, '首屏画完 → 最多藏底栏这么久（inset-watch.ts）'],
  ['INSET_BACKSTOP_MS', INSET_BACKSTOP_MS, 8000, '挂上 → 一直没调 markInsetPainted 也放行、停轮询（inset-watch.ts）'],
  ['INSET_POLL_MS', INSET_POLL_MS, 40, '挂上后 → 每隔这么久读一次安全区（env 变了没有事件；inset-watch.ts）'],
  ['GIVE_UP_MS', GIVE_UP_MS, 1000, '冷启动放垫块（启动画面还盖着）→ 没回到整屏就撤，不再试（vh-gapfix-gate.ts）'],
  ['FADE_WAIT_MS', FADE_WAIT_MS, 1500, '新页分包还没到 → 不再等它出来再动画（motion/page-shown.ts；App 等页面显示也用）'],
  ['REMIND_MAX_WAIT_MS', REMIND_MAX_WAIT_MS, 5000, 'App 第一次渲染 → 页面没出来也挂提醒（App.tsx useAfterFirstPage）'],
  ['REMIND_ARM_WATCHDOG_MS', REMIND_ARM_WATCHDOG_MS, 15_000, '提醒挂上（ready）→ 还没 armed 记 remindDown（App.tsx）'],
  ['AFTER_PAINT_TIMEOUT_MS', AFTER_PAINT_TIMEOUT_MS, 15_000, '首屏画完后下载同步那批代码 → 一次最多等这么久，超时进重试（after-paint.ts）'],
  ['BOOT_FAIL_LOG_WAIT_MS', BOOT_FAIL_LOG_WAIT_MS, 1000, 'start() 抛错 → 最多等运行日志记下这么久再跳登录页（main.tsx）'],
];

describe('启动阶段兜底计时器总表（全 app 评审 六.1）', () => {
  it.each(TIMELINE)('%s = %i ms（应为 %i）：%s', (_name, now, want) => {
    expect(now).toBe(want);
  });
});

describe('文件头里写明了的先后关系', () => {
  it('启动画面最多盖的时间和告知页关口的上限一样（R-250，splash.ts）；CSS 兜底比脚本那条晚', () => {
    expect(SPLASH_MAX_MS).toBe(GATE_LIMIT_MS);
    expect(dur.splashFailsafe * 1000).toBeGreaterThan(SPLASH_MAX_MS);
  });
  it('渲染前等皮肤远短于启动画面最多盖的时间（等皮肤时启动画面还盖着）', () => {
    expect(LOOK_WAIT_MS).toBeLessThan(SPLASH_MAX_MS);
  });
  it('首屏画完时限是关口时限再加 1 秒（关口慢时同步不和告知页分包抢下载），长兜底比它晚', () => {
    expect(main).toContain('startAppPaintLimit(GATE_LIMIT_MS + 1000);');
    expect(APP_PAINT_BACKSTOP_MS).toBeGreaterThan(GATE_LIMIT_MS + 1000);
  });
  it('底栏最多藏的时间比“没调 markInsetPainted”的兜底短', () => {
    expect(INSET_MAX_MS).toBeLessThan(INSET_BACKSTOP_MS);
  });
});

describe('启动画面的收起：一个实现、四个触发点', () => {
  it('main.tsx：开头 hideSplashAfter(hideSplash) 兜底；#root 第一次画出东西的下一帧；两种冷启动就进退出屏（挂在 body 下，不在 #root 里）当场收', () => {
    expect(main.match(/hideSplashAfter\(hideSplash\);/g)?.length).toBe(1);
    expect(main.match(/whenContent\(el, \(\) => void nextFrame\(\(\) => void hideSplash\(\)\)\);/g)?.length).toBe(1);
    expect(main.match(/void hideSplash\(\);\s*mountExitScreen\('(unavailable|incomplete)'\);/g)?.length).toBe(2);
  });
  it('root.tsx：“库被挡住”整屏提示（另挂在 body 下的 #lemo-blocked）提交后的下一帧（SplashRelease）', () => {
    const root = readFileSync('src/app/root.tsx', 'utf8');
    expect(root).toContain('useEffect(() => nextFrame(() => void hideSplash()), []);');
    expect(root.match(/hideSplash\(\)/g)?.length).toBe(1);
  });
});
