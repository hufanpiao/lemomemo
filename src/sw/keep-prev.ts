// 上一版的分包多留一版（同步层审查第 6 条之二，主持人 11-14 定方案 A）
// 两个标签页：A 页按“重新打开”让新 SW 接管，B 页也跟着归新 SW 管、但还在跑旧代码，之后按需加载旧版带哈希的分包。
// workbox 的 PrecacheController.activate 会立刻删掉不在新清单里的条目，线上也只剩新版文件 → B 页落空。
// 所以 sw.ts 在调 workbox 的 activate 之前先调这里：把预缓存里这一版用不到的 /app/assets/ 条目挪进 prevName 那份缓存，
// 旧页再要时由 sw.ts 的上一版分包路由（CacheFirst，不写缓存）回。
// • 只留一版：每次先把 prevName 整个删掉再写，所以里面永远只有“刚被换下来的那一版”独有的分包，下一次激活就清掉，不累积
// • 只挪 /app/assets/（带哈希的分包和样式）：index.html 这类按 revision 存的不挪，导航只认当前版本（sw.ts）
// • 只读预缓存、不删预缓存里的东西（删由 workbox 的 activate 做）；只往 prevName 里写。tests/build/sw-no-user-data.test.ts 按写法逐处核对
// Cache Storage 由 sw.ts 传进来（self.caches），这里不碰全局；行为见 tests/build/sw-prev-assets.test.ts

/** 多留一版的只有这个目录下的文件（sw.ts 的上一版分包路由也只接这个目录） */
export const PREV_ASSETS_DIR = '/app/assets/';

export interface KeepPrevious {
  /** workbox 预缓存的缓存名（PrecacheController 的 strategy.cacheName） */
  readonly precacheName: string;
  /** 这一版预缓存清单里的全部 cacheKey（完整地址） */
  readonly current: ReadonlySet<string>;
  /** 多留一版的那份缓存名 */
  readonly prevName: string;
}

/** 新 SW 激活时、workbox 清预缓存之前调用。返回挪了几个 */
export async function keepPreviousAssets(storage: CacheStorage, d: KeepPrevious): Promise<number> {
  const from = await storage.open(d.precacheName);
  const stale = (await from.keys()).filter((r) => !d.current.has(r.url) && new URL(r.url).pathname.startsWith(PREV_ASSETS_DIR));
  // 只留一版：先整个删掉再写（更早那一版的一起清掉）
  await storage.delete(d.prevName);
  const to = await storage.open(d.prevName);
  let n = 0;
  for (const r of stale) {
    const res = await from.match(r);
    if (!res) continue;
    await to.put(r, res);
    n++;
  }
  return n;
}
