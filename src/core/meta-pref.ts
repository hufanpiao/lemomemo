// 本机 meta 里记的一项界面偏好（smart-search 的“最近找过”、待办的收起状态共用这一份）
// • 模块里一份内存、订阅（给 useSyncExternalStore）；从本机缓存 getMeta 读一次，重复调 load 没关系
// • 还没启动好、读失败：先按内存里的（默认）算，标成读过，下次 load 再读；写 meta 失败不提示（meta 可重建，下次打开回到默认）
// • 读回来的值经 parse 认（认不出当没有）；merge 决定和读回来以前已经改过的内存怎么合（不给就用读回来的）
// 纯 TS：不准 import React
import { createSignal } from '../../shared/core/signal.ts';
import { getBoot } from './boot.ts';
import type { MetaKey, MetaMap } from './cache.ts';

export interface MetaPref<T> {
  get(): T;
  /** 本机那份读过了没有（读到、读不到、还没启动好，都算读过） */
  ready(): boolean;
  subscribe(fn: () => void): () => void;
  /** 读一次 */
  load(): Promise<void>;
  /** 改内存、通知、写 meta（不写 null：null 只当“没记过”的默认值） */
  set(v: NonNullable<T>): void;
  /** 丢掉内存回到默认，下次 load 重新读（换账号） */
  drop(): void;
  /** 测试用：回到刚建好的样子 */
  reset(): void;
}

export interface MetaPrefOpts<T> {
  parse(raw: unknown): T | undefined;
  merge?(stored: T, local: T): T;
}

export function createMetaPref<K extends MetaKey, T extends MetaMap[K] | null = MetaMap[K]>(key: K, fallback: T, opts: MetaPrefOpts<T>): MetaPref<T> {
  let value = fallback;
  let isReady = false;
  let loading: Promise<void> | null = null;
  const subs = createSignal();
  const settle = (): void => {
    isReady = true;
    subs.emit();
  };
  const openCache = () => {
    const c = getBoot()?.cache;
    return c && !c.isClosed() ? c : null;
  };
  return {
    get: () => value,
    ready: () => isReady,
    subscribe: subs.subscribe,
    load() {
      loading ??= (async () => {
        try {
          const c = openCache();
          if (!c) {
            loading = null;
            settle();
            return;
          }
          const v = opts.parse(await c.getMeta(key));
          if (v !== undefined) value = opts.merge ? opts.merge(v, value) : v;
          settle();
        } catch {
          loading = null;
          settle();
        }
      })();
      return loading;
    },
    set(v) {
      value = v;
      subs.emit();
      void openCache()?.setMeta(key, v).catch(() => undefined);
    },
    drop() {
      loading = null;
      value = fallback;
      subs.emit();
    },
    reset() {
      value = fallback;
      isReady = false;
      loading = null;
    },
  };
}
