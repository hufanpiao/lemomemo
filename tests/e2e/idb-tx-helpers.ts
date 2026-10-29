// P-idb-tx（b1-idb-tx.spec.ts）的页面准备：把真的 src/core/cache.ts（连同 cache-migrations.ts、cache-schema.ts 及其依赖）
// 在 Node 侧用 esbuild 打成一段 IIFE，addInitScript 注入同源空白页，挂到 window.__cache 上给用例调用——测的是真代码，src 一改测试跟着变。
// esbuild 是精确版本的 devDependency（package.json，0.28.2，和 vite 带的同一版）；src 不改。
// 页面：page.route 在同源造一个空白页（不跑 App 启动，不碰真实的 planner-v4，没有 CSP），每条用例用自己的库名，结束删库。
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import type { Cache, CacheClosedError, OpenCacheOptions, OpenCacheResult } from '../../src/core/cache.ts';
import type { cacheStores as CacheStoresFn } from '../../src/core/cache-schema.ts';
import { cacheStores } from '../../src/core/cache-schema.ts';

/** 注入页面的真模块 */
export interface CacheModule {
  openCache(opts?: OpenCacheOptions): Promise<OpenCacheResult>;
  CacheClosedError: typeof CacheClosedError;
  DB_NAME: string;
  DB_VERSION: number;
  cacheStores: typeof CacheStoresFn;
}

/** 页面里的小工具：只经真 Cache 的接口读写，或调原生 deleteDatabase */
export interface PageUtils {
  /** 每个仓写两行（键 a、b），一个 readwrite 事务 */
  seed(cache: Cache): Promise<void>;
  /** 库里每个仓的行数 */
  counts(cache: Cache): Promise<Record<string, number>>;
  sleep(ms: number): Promise<void>;
  del(name: string): Promise<void>;
}

declare global {
  interface Window {
    __cache?: CacheModule;
    __u?: PageUtils;
    /** 各用例在页面里放的东西（Cache、日志、结果） */
    __t?: Record<string, unknown>;
  }
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 真代码打成的 IIFE（每个 worker 打一次） */
const BUNDLE = buildSync({
  stdin: {
    contents: [
      "export { openCache, CacheClosedError, DB_NAME } from './src/core/cache.ts';",
      "export { DB_VERSION } from './src/core/cache-migrations.ts';",
      "export { cacheStores } from './src/core/cache-schema.ts';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: '__cacheMod',
  platform: 'browser',
  target: 'es2022',
  // 和 vite 构建时一样替换的常量：vite.config.ts 的 define，以及 import.meta.env（src/platform/env.ts 在加载时读，经 sign-out.ts 打进来）。
  // cache.ts 不看这些，给占位值；e2e 模式、公开配置留空
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-e2e'),
    __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
    'import.meta.env': JSON.stringify({ MODE: 'e2e', DEV: false, PROD: true }),
  },
  write: false,
}).outputFiles[0]?.text;
if (!BUNDLE) throw new Error('esbuild 没产出 cache.ts 的包');

function installUtils(): void {
  const utils: PageUtils = {
    seed: async (cache) => {
      const defs = cache.stores;
      await cache.tx(
        defs.map((d) => d.name),
        'readwrite',
        async (t) => {
          for (const d of defs) {
            for (const k of ['a', 'b']) {
              const row: Record<string, unknown> = { [d.keyPath]: k, payload: `${d.name}:${k}` };
              for (const i of d.indexes) row[i.keyPath] = `${d.name}:${k}`;
              await t.put(d.name, row);
            }
          }
        },
      );
    },
    counts: async (cache) => {
      const names = cache.storeNames();
      return cache.tx(names, 'readonly', async (t) => {
        const out: Record<string, number> = {};
        for (const n of names) out[n] = (await t.getAll(n)).length;
        return out;
      });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    del: (name) =>
      new Promise((resolve) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = () => resolve();
        r.onerror = () => resolve();
        r.onblocked = () => resolve();
      }),
  };
  window.__u = utils;
  window.__t = {};
}

const STORES = cacheStores();
export const SYNC = STORES.find((d) => d.kind === 'sync')?.name ?? 'meta';
export const KEEP = STORES.filter((d) => !d.rebuildable).map((d) => d.name).sort();
export const REBUILD = STORES.filter((d) => d.rebuildable).map((d) => d.name).sort();
const BLANK = '/__idb-tx-blank.html';

/** 打开同源空白页，注入真 cache.ts 和小工具 */
export async function blank(page: Page): Promise<void> {
  await page.route(`**${BLANK}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>idb-tx</title>' }),
  );
  await page.addInitScript({ content: `${BUNDLE}\nwindow.__cache = __cacheMod;` });
  await page.addInitScript(installUtils);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BLANK);
  const ok = await page.evaluate(() => typeof window.__cache?.openCache === 'function' && window.__u !== undefined);
  if (!ok) throw new Error(`真 cache.ts 没注入成功：${errors.join(' | ') || '没有页面报错'}`);
}

export function dbName(tag: string): string {
  return `p-idb-tx-${tag}-${Math.random().toString(36).slice(2, 8)}`;
}
