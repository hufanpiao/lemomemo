// 启动画面颜色诊断（台账 Q-2，负责人 11-11“启动的时候下面那一块灰色去掉不行吗”）：只在非正式版里有，诊断页开关打开后下次冷启动跑一次。
// 目的：负责人冷启动截一张图，就能分清那块灰色是哪一层——
//   html 画布 = 洋红、body = 青、.lemo-splash 自己的底 = 绿、浅色层（平时是 splash-bg.png）= 黄、深色层 = 蓝；
//   红线 = 启动画面的下沿，橙线 = 布局视口的下沿（position: fixed; bottom: 0）。
//   截图里还是灰的那一块不是上面任何一层：在网页画得到的范围之外（WKWebView 视口外的原生底色），或者网页还没画、仍是 iOS 启动图。
// 左上角小字（白底黑字）每 200 ms 刷新：innerHeight、screen、visualViewport、documentElement.clientHeight、100lvh/svh/dvh/vh 实测、
// --lemo-screen-h、启动画面的上下沿、顶部和底部安全区、Gap fix 垫块在不在、启动画面在哪个阶段；下面几行是数变的那一刻（相对开始的 ms）。
// 启动画面多留 8 秒：诊断启动件 diag-boot.ts 先打 data-splash-hold（main.tsx 收起启动画面前先等 diag-boot），platform/splash.ts 从第一次要收起的那一刻起再等 SPLASH_HOLD_MS 才收起；
// 启动画面还在时小字顶上多一行 HOLD_HINT（英文，同其他诊断开关的文字），提示现在截图。
// 跑 DURATION_MS 后整块撤掉（属性、小字、量尺、保留标记都拿掉），之后和平时一模一样；DURATION_MS 要晚于启动画面最晚收起的时刻（5 秒兜底 + 8 秒 + 淡出）。
// 涂色全在 splash-probe.css（外链样式，CSP style-src 'self' 照旧；不写 style 属性），挂在 <html data-sp-probe> 上；本模块只由 diag-boot.ts 在开关开着时动态加载（diag-boot 本身只在非正式版下载）
import './splash-probe.css';
import { ARM_KEY, setSplashProbeArmed } from './splash-probe-arm.ts';
import { SPLASH_HOLD_ATTR } from './splash.ts';

export const DURATION_MS = 20_000;
export const TICK_MS = 200;
export const ATTR = 'spProbe';
export const PANEL_ID = 'lemo-sp-probe-panel';
const SPLASH_ID = 'lemo-splash';
const PAD_ID = 'lemo-gapfix-pad';
const UNITS = ['lvh', 'svh', 'dvh', 'vh'] as const;
const MAX_LOG = 8;
export const HOLD_HINT = 'Splash held 8s - screenshot now';

export { ARM_KEY };

function el(doc: Document, cls: string): HTMLDivElement {
  const d = doc.createElement('div');
  d.className = cls;
  d.setAttribute('aria-hidden', 'true');
  return d;
}

const px = (n: number): string => String(Math.round(n * 10) / 10);

/** 量一遍，返回 [固定那几行, 用来比“变没变”的那几个数] */
export function measure(win: Window, meters: Record<string, HTMLElement>): { lines: string[]; key: string; phase: string } {
  const doc = win.document;
  const splash = doc.getElementById(SPLASH_ID);
  const phase = !splash ? 'gone' : splash.classList.contains('is-leaving') ? 'leaving' : 'splash';
  const sr = splash?.getBoundingClientRect();
  const screenH = splash ? win.getComputedStyle(splash).getPropertyValue('--lemo-screen-h').trim() || '-' : '-';
  const vv = win.visualViewport;
  const units = UNITS.map((u) => `${u}=${px(meters[u]?.getBoundingClientRect().height ?? 0)}`).join(' ');
  const inset = meters['inset'] ? win.getComputedStyle(meters['inset']) : null;
  const sa = typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser';
  const lines = [
    `phase=${phase} ${sa} pad=${doc.getElementById(PAD_ID) ? 'yes' : 'no'}`,
    `inner=${win.innerWidth}x${win.innerHeight} screen=${win.screen.width}x${win.screen.height}`,
    `vv=${vv ? `${px(vv.width)}x${px(vv.height)} top=${px(vv.offsetTop)}` : '-'} client=${doc.documentElement.clientHeight}`,
    units,
    `--lemo-screen-h=${screenH} splash=${sr ? `${px(sr.top)}..${px(sr.bottom)} h=${px(sr.height)}` : '-'}`,
    `inset top=${inset?.paddingTop ?? '-'} bottom=${inset?.paddingBottom ?? '-'} scrollY=${px(win.scrollY)}`,
    'magenta=html cyan=body lime=splash yellow=L blue=D',
    'red=splash bottom orange=viewport bottom',
  ];
  return { phase, lines, key: `${phase} ${win.innerHeight} ${vv ? px(vv.height) : '-'} ${doc.documentElement.clientHeight}` };
}

/** 开始涂色、印数；返回撤掉的函数（到点也会自己撤） */
export function startSplashProbe(win: Window = window, store: Storage = localStorage): () => void {
  setSplashProbeArmed(false, store); // 只跑一次
  const doc = win.document;
  const root = doc.documentElement;
  const t0 = Date.now();
  root.dataset[ATTR] = '1';
  const panel = el(doc, 'lemo-sp-probe-panel');
  panel.id = PANEL_ID;
  const vbLine = el(doc, 'lemo-sp-probe-vb');
  const meters: Record<string, HTMLElement> = {};
  for (const u of UNITS) meters[u] = el(doc, `lemo-sp-probe-m lemo-sp-probe-${u}`);
  meters['inset'] = el(doc, 'lemo-sp-probe-m lemo-sp-probe-inset');
  const added = [vbLine, ...Object.values(meters), panel];
  doc.body.append(...added);

  const log: string[] = [];
  let lastKey = '';
  const tick = (): void => {
    const { phase, lines, key } = measure(win, meters);
    if (key !== lastKey) {
      lastKey = key;
      log.push(`+${Date.now() - t0} ${key}`);
      if (log.length > MAX_LOG) log.splice(1, 1); // 第一行（开始那一刻）一直留着
    }
    panel.textContent = [...(phase === 'splash' ? [HOLD_HINT] : []), `sp-probe +${Date.now() - t0}ms`, ...lines, '--- changes (phase inner vv client)', ...log].join('\n');
  };
  tick();
  const iv = win.setInterval(tick, TICK_MS);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    win.clearInterval(iv);
    win.clearTimeout(end);
    delete root.dataset[ATTR];
    delete root.dataset[SPLASH_HOLD_ATTR];
    for (const n of added) n.remove();
  };
  const end = win.setTimeout(stop, DURATION_MS);
  return stop;
}
