// 新页显示出来没有、等它出来（这类事只在这里判断，架构约定 10.1）和换页动画的常量。
// 从 page-swap.ts 分出来留在首屏：App 冷启动等页面显示、收打字条要用；动画实现 page-swap.ts 首屏画完以后才下载（11-18 首屏预算）
const noop = (): void => undefined;

/** 新页分包还没到（页面的 Suspense 先什么都不画）时，最多等多久让它出来；过了就不动画了（App 等页面显示出来也用这个数） */
export const FADE_WAIT_MS = 1500;
/** 新页从第几毫秒起播（一帧，60Hz）：不画 opacity 0 的那一帧 */
export const FADE_SKIP_MS = 1000 / 60;
/**
 * 换页后这么久以内落在 main 里的点按吞掉（代码审查方案 B M8；沿用主持人 11-05 的规则“过渡开始很短时间内的点按算点在旧画面上”）：
 * 旧页在点页签那一刻就卸掉了，手指顺手再点一下原来那页的位置，人还没看清新页，会直接点中新页同一位置的删除 ×、勾选圈。
 * 新页第一帧约 17 ms 才画出来，再加人眼看清的最短时间，取 100 ms；底栏不在 main 里，连点页签不受影响
 */
export const FADE_GUARD_MS = 100;
/** “详细”长成的前多少（比例）新建页内容不露、打字条淡完 */
export const GROW_HOLD = 0.35;
/**
 * 这个元素此刻画在页面上没有（还在文档里、没被 display: none 藏起来）。新页分包没到时 Suspense 用内联 display: none 藏旧页、
 * 旧页仍在文档里（React 19 + flushSync，App 的注释和第二次复审第 1 条），只看 isConnected 判断不出来。
 * 换页动画等新页、显示旧页快照，App 等页面显示出来收打字条，都用这一个判断（这类事只在这里判断，架构约定 10.1；首屏画好没有另归 platform/root-paint.ts）
 */
export function pageVisible(el: Element | null): boolean {
  return el !== null && el.isConnected && el.getClientRects().length > 0;
}

/** 页面上第一个显示着的 <main>（真页面；快照外壳不是 main） */
export function shownMain(): HTMLElement | null {
  for (const m of document.querySelectorAll('main')) if (pageVisible(m)) return m;
  return null;
}

/**
 * 看着 body 等 test() 成立就调 hit(true)；已经成立就当场调；ms 内一直不成立调 hit(false)。返回停止（停了不再调 hit）。
 * 页签互切、“详细”长成等新页，App 等页面显示出来收打字条，都用这一个
 */
export function waitDom(test: () => boolean, ms: number, hit: (ok: boolean) => void): () => void {
  if (test()) {
    hit(true);
    return noop;
  }
  let live = true;
  const stop = (): void => {
    if (!live) return;
    live = false;
    mo.disconnect();
    clearTimeout(timer);
  };
  const mo = new MutationObserver(() => {
    if (!test()) return;
    stop();
    hit(true);
  });
  const timer = setTimeout(() => {
    stop();
    hit(false);
  }, ms);
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
  return stop;
}

/**
 * 页面级懒加载块还没出来时，它的 Suspense 占位上打的标记（kit 的 PagePending 画一个隐藏的 <i data-page-pending>）。
 * App 的页面那层、设置二级页那层用它（独立评审 11-20 第 2 条：设置二级页外层 main 先在、里面一层懒加载还空着，只看 main 会当场放行）
 */
export const PENDING_ATTR = 'data-page-pending';

/** 新页真的画出来了：有显示着的 <main>，页面级的懒加载块也都到了 */
export function pageReady(): boolean {
  return shownMain() !== null && document.querySelector(`[${PENDING_ATTR}]`) === null;
}
