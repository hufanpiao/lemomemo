// 订阅、通知的小集合（改善报告第七节“低风险的重复清理”：原来各模块手写 new Set + for (const fn of [...set]) fn() + 退订）
// • emit 先拍快照再逐个叫：叫的过程中新订的这一轮不叫、退订的这一轮照叫（和原来各处的 [...set] 写法一样）
// • 同一个函数订两次只算一次（Set）；退订函数调几次都没关系
// • 不兜错：一个回调抛错，后面的这一轮不叫（和原来一样）。要“各自兜底”的（app/sync-notice-store.ts）不走这里
// 纯 TS，不碰 DOM、时钟，前端各层、SW 都能用
export interface Signal<A extends unknown[] = []> {
  /** 订阅；返回退订函数 */
  subscribe(fn: (...a: A) => void): () => void;
  /** 按订阅顺序叫一遍 */
  emit(...a: A): void;
  /** 全部退订（换账号、关库、测试复位） */
  clear(): void;
  /** 现在有几个订阅 */
  readonly size: number;
}

export function createSignal<A extends unknown[] = []>(): Signal<A> {
  const fns = new Set<(...a: A) => void>();
  return {
    subscribe(fn) {
      fns.add(fn);
      return () => {
        fns.delete(fn);
      };
    },
    emit(...a) {
      for (const fn of [...fns]) fn(...a);
    },
    clear() {
      fns.clear();
    },
    get size() {
      return fns.size;
    },
  };
}
