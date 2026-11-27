// 测试用：把真的 sw.ts（连同真的 workbox）装进 Node 里跑。只替身浏览器全局：Cache Storage、fetch、Request 的相对地址、
// install / activate / fetch 事件。sw-nav-shell.test.ts（导航）、sw-prev-assets.test.ts（上一版分包多留一版）共用
import { vi } from 'vitest';

export const ORIGIN = 'https://lemomemo.com';
export const SCOPE = `${ORIGIN}/app/`;

/** 相对地址按 SCOPE 解析（Node 的 Request 没有页面地址，workbox 会 new Request('/app/index.html')） */
export class Req extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, SCOPE).href : input, init);
  }
}

export const urlOf = (r: RequestInfo | URL): string => (typeof r === 'string' ? new URL(r, SCOPE).href : r instanceof URL ? r.href : r.url);
const sameUrl = (a: string, b: string, o?: CacheQueryOptions): boolean =>
  o?.ignoreSearch ? a.split('?')[0] === b.split('?')[0] : a === b;

export class FakeCache {
  readonly m = new Map<string, Response>();
  match(r: RequestInfo | URL, o?: CacheQueryOptions): Promise<Response | undefined> {
    const u = urlOf(r);
    for (const [k, v] of this.m) if (sameUrl(k, u, o)) return Promise.resolve(v.clone());
    return Promise.resolve(undefined);
  }
  put(r: RequestInfo | URL, res: Response): Promise<void> {
    this.m.set(urlOf(r), res);
    return Promise.resolve();
  }
  delete(r: RequestInfo | URL, o?: CacheQueryOptions): Promise<boolean> {
    const u = urlOf(r);
    let hit = false;
    for (const k of [...this.m.keys()]) if (sameUrl(k, u, o)) hit = this.m.delete(k) || hit;
    return Promise.resolve(hit);
  }
  keys(): Promise<Request[]> {
    return Promise.resolve([...this.m.keys()].map((u) => new Req(u)));
  }
}

export class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  open(n: string): Promise<FakeCache> {
    let c = this.stores.get(n);
    if (!c) {
      c = new FakeCache();
      this.stores.set(n, c);
    }
    return Promise.resolve(c);
  }
  has(n: string): Promise<boolean> {
    return Promise.resolve(this.stores.has(n));
  }
  delete(n: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(n));
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }
  async match(r: RequestInfo | URL, o?: MultiCacheQueryOptions): Promise<Response | undefined> {
    const names = o?.cacheName ? [o.cacheName] : [...this.stores.keys()];
    for (const n of names) {
      const hit = await this.stores.get(n)?.match(r, o);
      if (hit) return hit;
    }
    return undefined;
  }
  /** 某个缓存里的地址（路径部分，含查询串），排好序 */
  async paths(n: string): Promise<string[]> {
    const c = this.stores.get(n);
    if (!c) return [];
    return (await c.keys()).map((r) => r.url.slice(ORIGIN.length)).sort();
  }
}

export class FakeExtendableEvent {
  readonly waits: Promise<unknown>[] = [];
  stopped = false;
  readonly type: string;
  constructor(type: string) {
    this.type = type;
  }
  waitUntil(p: Promise<unknown>): void {
    this.waits.push(p);
  }
  stopImmediatePropagation(): void {
    this.stopped = true;
  }
}

export class FakeFetchEvent extends FakeExtendableEvent {
  responded: Promise<Response> | null = null;
  readonly request: Request;
  constructor(request: Request) {
    super('fetch');
    this.request = request;
  }
  respondWith(p: Promise<Response>): void {
    this.responded = p;
  }
}

type Listener = (e: FakeExtendableEvent) => void;

/** 替身全局（每个用例一次）；fetch 交给 net。返回大家共用的 Cache Storage（换 SW 版本时不换） */
export function stubSwGlobals(net: (url: string) => Promise<Response>): FakeCaches {
  const caches = new FakeCaches();
  const location = { origin: ORIGIN, href: `${SCOPE}sw.js` };
  vi.stubGlobal('location', location);
  vi.stubGlobal('caches', caches);
  vi.stubGlobal('Request', Req);
  vi.stubGlobal('ExtendableEvent', FakeExtendableEvent);
  vi.stubGlobal('FetchEvent', FakeFetchEvent);
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => net(urlOf(input)));
  return caches;
}

export interface LoadedSw {
  /** 派一个 install / activate 事件，等它 waitUntil 的都做完 */
  lifecycle(type: 'install' | 'activate'): Promise<void>;
  /** 派一个 fetch 事件；SW 没接（没 respondWith）回 null */
  fetch(path: string, mode?: string): FakeFetchEvent;
}

/** 装一份新的 sw.ts（一个新版本的 SW）：清模块缓存、换一个新的 self，带上这一版的预缓存清单 */
export async function loadSw(caches: FakeCaches, manifest: Array<{ url: string; revision: string | null }>): Promise<LoadedSw> {
  vi.resetModules();
  const listeners: Record<string, Listener[]> = {};
  vi.stubGlobal('self', {
    __WB_MANIFEST: manifest,
    __WB_DISABLE_DEV_LOGS: true,
    location: { origin: ORIGIN, href: `${SCOPE}sw.js` },
    registration: { scope: SCOPE },
    caches,
    clients: {},
    skipWaiting: () => Promise.resolve(),
    addEventListener: (t: string, fn: Listener) => {
      (listeners[t] ??= []).push(fn);
    },
  });
  // 用变量路径：sw.ts 按 webworker 类型写（tsconfig.sw.json），不让测试这边的 tsconfig 去解析它
  const swPath = '../../src/sw/sw.ts';
  await import(/* @vite-ignore */ swPath);
  const run = (e: FakeExtendableEvent): void => {
    for (const fn of listeners[e.type] ?? []) {
      fn(e);
      if (e.stopped) break;
    }
  };
  return {
    async lifecycle(type) {
      const e = new FakeExtendableEvent(type);
      run(e);
      // waitUntil 可能在前面的 promise 里才调（workbox 的 activate）：直到不再多出来
      for (let n = -1; n !== e.waits.length; ) {
        n = e.waits.length;
        await Promise.all(e.waits);
      }
    },
    fetch(path, mode = 'cors') {
      const req = new Req(`${ORIGIN}${path}`);
      Object.defineProperty(req, 'mode', { value: mode });
      const ev = new FakeFetchEvent(req);
      run(ev);
      return ev;
    },
  };
}
