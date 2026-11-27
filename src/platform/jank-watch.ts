// 长帧计数（真机卡不卡要有数可看）：前台时每帧量一次和上一帧的间隔，
// 每 JANK_PERIOD_MS 里有超过 JANK_MS 的帧才记一行“jank n50=<几次> max=<最长毫秒> route=<最长那一帧时在哪页>”，没有长帧不记（日志不会变多）。
// • 帧回调由调用方注入（同 run-log.ts 的 opts.frame，app 层传 motion 的 nextFrame；平台层不直接调帧接口）
// • 切到后台停（后台不出帧，间隔不算），回来重开；只在运行日志开着时跑（正式版不起运行日志）
export const JANK_MS = 50;
export const JANK_PERIOD_MS = 10_000;

/** 当前路由名（#/notes/… → notes），记最长那一帧在哪页。
 *  读的时机是长帧结束、下一帧回调来的那一刻（不是长帧开始时）：切页那一下的长帧，hash 往往已经换了，可能记到新页 */
const routeOf = (doc: Document): string => (doc.defaultView?.location.hash ?? '').replace(/^#\/?/, '').split(/[/?]/)[0] || '-';

export function watchJank(doc: Document, frame: (cb: () => void) => void, add: (line: string) => void): () => void {
  let on = false;
  let gen = 0;
  let last = -1;
  let n50 = 0;
  let max = 0;
  let maxRoute = '-';
  let timer: ReturnType<typeof setInterval> | undefined;
  const report = (): void => {
    if (n50 > 0) add(`jank n50=${n50} max=${Math.round(max)} route=${maxRoute}`);
    n50 = 0;
    max = 0;
  };
  const loop = (g: number): void =>
    frame(() => {
      if (g !== gen) return;
      const t = performance.now();
      if (last >= 0 && t - last > JANK_MS) {
        n50 += 1;
        if (t - last > max) {
          max = t - last;
          maxRoute = routeOf(doc);
        }
      }
      last = t;
      loop(g);
    });
  const start = (): void => {
    if (on) return;
    on = true;
    gen += 1;
    last = -1;
    loop(gen);
    timer = setInterval(report, JANK_PERIOD_MS);
  };
  const stop = (): void => {
    if (!on) return;
    on = false;
    gen += 1;
    clearInterval(timer);
    report();
  };
  const onVis = (): void => (doc.visibilityState === 'visible' ? start() : stop());
  doc.addEventListener('visibilitychange', onVis);
  onVis();
  return () => {
    doc.removeEventListener('visibilitychange', onVis);
    stop();
  };
}
