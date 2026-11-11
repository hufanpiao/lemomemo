// R-371 Gap fix 默认开（11-11 主持人定；负责人 iPhone 主屏幕版 preview.250 真机通过：冷启动 895→956、底栏 853→914，切页不变）：
// 冷启动时要不要下载 vh-gapfix.ts 做一次。只在 iOS（iPhone、iPad）主屏幕版做；电脑、安卓、iOS 上在浏览器里直接打开都不下载。
// 诊断页的“Gap fix”开关改成“关掉用来对照”：关掉时存 OFF_KEY = '1'，下次冷启动起不做；没存就是开着（默认）。
// main.tsx 静态引用本文件（在首屏里），所以单独一个小文件；vh-gapfix.ts 本体只在要做时才下载
import { isAppleMobile, isStandalone, type NavLike } from './env.ts';

export const OFF_KEY = 'lemo-gapfix-off';

/** 这次冷启动要不要做 Gap fix：iOS、主屏幕版、诊断页没关掉。读不到本机存储时照默认做 */
export function gapFixWanted(nav: NavLike = navigator, media?: (q: string) => boolean, store?: Storage): boolean {
  if (!isAppleMobile(nav) || !isStandalone(nav, media)) return false;
  try {
    return (store ?? localStorage).getItem(OFF_KEY) !== '1';
  } catch {
    return true;
  }
}

// 早试（台账 Q-2，11-11 负责人真机日志：Gap fix 等底栏挂上 t=1571 才放垫块、t=1586 就变 956，启动画面盖着的这 1.5 秒底下一直是灰带）：
// main.tsx 一开始（入口模块执行时，启动画面还盖着）就同步放一次同样的垫块，innerHeight 一变或到 EARLY_GIVE_UP_MS 就撤；
// 不成就照原样等底栏挂上再做一次（vh-gapfix.ts 等早试结束才开始，不叠两块垫块），早试的时刻和结果记进 Gap fix 日志第一行之后。
// 判断和放垫块的写法跟 vh-gapfix.ts 共用（放在这里是因为早试在首屏，vh-gapfix.ts 是按需下载的）

/** 差值和顶部安全区差多少以内算“少的正是顶部安全区” */
export const TOL_PX = 4;
export const PAD_ID = 'lemo-gapfix-pad';
/** 早试放了垫块这么久 innerHeight 还没变就撤掉，交给等底栏后那一次 */
export const EARLY_GIVE_UP_MS = 1000;
/** 早试时顶部安全区可能还读到 0（先 0 后 61）：这时差值不超过这么多才试（iPad 分屏等差值大的不试） */
export const EARLY_MAX_GAP = 100;

/** 顶部安全区（px）：读 --inset-top（base.css，= env(safe-area-inset-top)），和页面用的是同一个值 */
export function insetTop(doc: Document): number {
  const probe = doc.createElement('div');
  for (const [k, v] of [
    ['position', 'fixed'],
    ['top', '0'],
    ['width', '0'],
    ['height', '0'],
    ['visibility', 'hidden'],
    ['pointer-events', 'none'],
    ['padding-top', 'var(--inset-top, env(safe-area-inset-top))'],
  ] as const)
    probe.style.setProperty(k, v);
  (doc.body ?? doc.documentElement).append(probe);
  const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return px;
}

/** 看不见的垫块（绝对定位、1px 宽、visibility hidden、不接点按），文档高 = 一屏 + 差值 + 1px，页面变得能滚；放进 body */
export function putPad(doc: Document, gap: number): HTMLElement {
  const pad = doc.createElement('div');
  pad.id = PAD_ID;
  pad.setAttribute('aria-hidden', 'true');
  for (const [k, v] of [
    ['position', 'absolute'],
    ['top', '0'],
    ['left', '0'],
    ['width', '1px'],
    ['height', `calc(100dvh + ${gap + 1}px)`],
    ['visibility', 'hidden'],
    ['pointer-events', 'none'],
  ] as const)
    pad.style.setProperty(k, v);
  (doc.body ?? doc.documentElement).append(pad);
  return pad;
}

/** 早试的结果：at 是开始时刻（页面打开起算 ms），done 以前 vh-gapfix.ts 不开始，what 是写进日志的结果 */
export interface EarlyGap {
  readonly at: number;
  done: boolean;
  what: string;
}

let early: EarlyGap | null = null;
/** 这次冷启动的早试（没试过是 null） */
export const earlyGap = (): EarlyGap | null => early;

/** main.tsx 在 gapFixWanted() 时同步调一次；等帧的函数由调用方传（A25）；后三个参数测试用 */
export function startEarlyGapFix(
  frame: (cb: () => void) => unknown,
  win: Window = window,
  now: () => number = () => win.performance.now(),
  readTop: () => number = () => insetTop(win.document),
): EarlyGap {
  const inner0 = win.innerHeight;
  const gap = win.screen.height - inner0;
  const top = readTop();
  const e: EarlyGap = { at: Math.round(now()), done: false, what: '' };
  early = e;
  const end = (what: string): void => {
    e.done = true;
    e.what = `${what} gap=${gap} top=${top}`;
  };
  if (win.innerWidth >= inner0) end('skip landscape');
  else if (gap <= 0 || gap > EARLY_MAX_GAP || (top > 0 && Math.abs(gap - top) > TOL_PX)) end('skip');
  else {
    const pad = putPad(win.document, gap);
    const t0 = now();
    const step = (): void => {
      const h = win.innerHeight;
      const after = Math.round(now() - t0);
      if (h === inner0 && after < EARLY_GIVE_UP_MS) {
        frame(step);
        return;
      }
      pad.remove();
      end(h === inner0 ? `no-change after=${after}ms` : `changed ${inner0}->${h} after=${after}ms`);
    };
    frame(step);
  }
  return e;
}
