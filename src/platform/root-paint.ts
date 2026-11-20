// 首屏画完了没有（这类事只在这里判断，架构约定 10.1）：一个标志，对外三种写法——afterAppPainted(fn)、appPainted()、isAppPainted()。
// 这里不看 DOM：入口（app/first-paint.ts 的 watchFirstPaint）看着第一个显示出来的页面 <main>（motion 的 shownMain，“页面出来”只有这一个口径）
// 出来再过一帧调 markAppPainted；armAppPaint 起的长兜底、render 后的时限（startAppPaintLimit）到了也算。没 arm 过（登录页、测试）当场算画完。
// motion 按分层不能 import platform、platform 不能 import motion，所以唯一的 DOM 等待器在 motion，由入口接到这里

/** 首屏画完的时限：render 之后最多等这么久（入口按告知页关口的时限另传） */
export const APP_PAINT_LIMIT_MS = 4000;
/** 长兜底：从 armAppPaint 算（render 之前就走了、冷启动特别慢、后台标签 rAF 不跑时放行） */
export const APP_PAINT_BACKSTOP_MS = 15_000;

let armed = false;
let painted = false;
let limited = false;
const waiters: (() => void)[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];

const clearTimers = (): void => {
  for (const t of timers.splice(0)) clearTimeout(t);
};

/** 算首屏画完：排着的按顺序执行（一个出错不挡别的）；重复调用只算第一次 */
export function markAppPainted(): void {
  if (painted) return;
  painted = true;
  clearTimers();
  for (const fn of waiters.splice(0)) {
    try {
      fn();
    } catch {
      // 一个回调出错不挡别的
    }
  }
}

/** 入口在 render 之前调一次（重复调用不再算）：从这时起首屏算“还没画完”，backstopMs 后一定算画完。返回取消（测试用） */
export function armAppPaint(backstopMs: number = APP_PAINT_BACKSTOP_MS): () => void {
  if (armed) return () => undefined;
  armed = true;
  timers.push(setTimeout(markAppPainted, backstopMs));
  return clearTimers;
}

/** render 之后调一次：再等最多 limitMs 就当首屏画完了。没 arm 过、已画完、已经开始计时的不再计 */
export function startAppPaintLimit(limitMs: number = APP_PAINT_LIMIT_MS): void {
  if (!armed || painted || limited) return;
  limited = true;
  timers.push(setTimeout(markAppPainted, limitMs));
}

/** 首屏已经算画完了吗（没 arm 过也算） */
export const isAppPainted = (): boolean => !armed || painted;

/** 首屏画完以后执行 fn；已经画完、或者没 arm 过时当场执行 */
export function afterAppPainted(fn: () => void): void {
  if (isAppPainted()) fn();
  else waiters.push(fn);
}

/** 同上，Promise 写法（入口里 await 用） */
export function appPainted(): Promise<void> {
  return new Promise((ok) => afterAppPainted(ok));
}

/** 测试用 */
export function resetRootPaintForTest(): void {
  armed = false;
  painted = false;
  limited = false;
  waiters.length = 0;
  clearTimers();
}
