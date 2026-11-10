// OUTBOX-cross-tab：真浏览器（chromium、webkit）里两个标签页各自 coldStart 同一个本机库（各有一份 outbox），
// 真的 tab-leader（navigator.locks 选主页、BroadcastChannel 发提醒）、真的 wireSync 和同步引擎，传输层是页面里记请求的假的。
// 非主页往已排队、还没发过的 patch 再合并一次（待发数不变）：主页不用等 30 秒的定时发送，马上发出合并后的内容，而且只发一次。
// 改之前这一步不提醒主页（outbox 的 refresh 摘要没变不通知 subscribe），主页要等定时发送。
// 测的是真代码：Node 侧用 esbuild 把 boot.ts、sync-wiring.ts、engine.ts 打包注入同源空白页（同 idb-tx-helpers.ts 的做法）；src 不改。
// 不碰真实的 planner-v4：用自己的库名，结束删库。
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import type { coldStart as ColdStartFn } from '../../src/core/boot.ts';
import type { PatchArgs } from '../../src/core/sync/types.ts';
import type { createSync as CreateSyncFn } from '../../src/core/sync/engine.ts';
import type { wireSync as WireSyncFn, WireSyncDeps } from '../../src/app/sync-wiring.ts';
import { expect, test } from './csp-fixture.ts';

interface Mod {
  coldStart: typeof ColdStartFn;
  createSync: typeof CreateSyncFn;
  wireSync: typeof WireSyncFn;
}

/** 页面里的状态：down 时会话检查回断网（引擎不动队列、不排退避）；sent 记发出去的请求 */
interface TabState {
  down: boolean;
  leader: boolean;
  ensures: number;
  sent: { kind: string; id: string; data: Record<string, unknown> }[];
  outbox?: { enqueue(i: unknown): Promise<unknown>; getStatus(): { pending: number } };
  stop?: () => Promise<void> | void;
  close?: () => void;
}

declare global {
  interface Window {
    __oxt?: Mod;
    __s?: TabState;
  }
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BLANK = '/__outbox-cross-tab.html';
const USER = '00000000-0000-4000-8000-0000000000e2';
const ID = '00000000-0000-4000-8000-000000000091';

let bundle: string | null = null;
function build(): string {
  if (bundle !== null) return bundle;
  const text = buildSync({
    stdin: {
      contents: [
        "export { coldStart } from './src/core/boot.ts';",
        "export { createSync } from './src/core/sync/engine.ts';",
        "export { wireSync } from './src/app/sync-wiring.ts';",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: '__oxtMod',
    platform: 'browser',
    target: 'es2022',
    // sync-wiring 带进来的提示界面（sync-notice-gate 的按需块）有 CSS 模块和 JSX：样式不要，JSX 照 vite 的自动运行时
    loader: { '.css': 'empty', '.module.css': 'empty' },
    jsx: 'automatic',
    define: {
      __APP_VERSION__: JSON.stringify('0.0.0-e2e'),
      __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
      'import.meta.env': JSON.stringify({ MODE: 'e2e', DEV: false, PROD: true }),
    },
    write: false,
  }).outputFiles[0]?.text;
  if (!text) throw new Error('esbuild 没产出 sync-wiring.ts 的包');
  bundle = text;
  return text;
}

async function open(page: Page): Promise<void> {
  await page.route(`**${BLANK}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>outbox-cross-tab</title>' }),
  );
  await page.addInitScript({ content: `${build()}\nwindow.__oxt = __oxtMod;` });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BLANK);
  const ok = await page.evaluate(() => typeof window.__oxt?.wireSync === 'function');
  if (!ok) throw new Error(`真 sync-wiring.ts 没注入成功：${errors.join(' | ') || '没有页面报错'}`);
}

/** 在页面里：冷启动同一个库、接上真的 wireSync（真 tab-leader）、假传输层 */
async function start(page: Page, name: string): Promise<void> {
  await page.evaluate(
    async ({ name, user }) => {
      const M = window.__oxt;
      if (!M) throw new Error('mod_missing');
      const s: TabState = { down: false, leader: false, ensures: 0, sent: [] };
      window.__s = s;
      const net = { ok: false as const, error: { network: true } as never };
      const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
      let rev = 1;
      const boot = await M.coldStart({ userId: user, listen426: false, clearCacheStorage: async () => undefined, cacheOptions: { name } });
      if (boot.status !== 'ready' || !boot.outbox) throw new Error(`boot_${boot.status}`);
      s.outbox = boot.outbox as unknown as NonNullable<TabState['outbox']>;
      s.close = () => boot.cache?.close();
      const deps: WireSyncDeps = {
        transport: {
          ensureSession: () => {
            s.ensures++;
            return Promise.resolve(s.down ? ('network' as const) : ('ok' as const));
          },
          refreshSession: () => Promise.resolve('ok' as const),
          sessionId: () => 'sid-e2e',
          insertRow: (_table: string, data: Readonly<Record<string, unknown>>) => {
            if (s.down) return Promise.resolve(net);
            s.sent.push({ kind: 'insert', id: String(data['id']), data: { ...data } });
            return ok({ rev: rev++ });
          },
          applyPatch: (a: PatchArgs) => {
            if (s.down) return Promise.resolve(net);
            s.sent.push({ kind: 'patch', id: a.p_id, data: { ...a.p_patch } });
            const r = rev++;
            return ok({ status: 'ok' as const, rev: r + 1, prev_rev: r });
          },
          pullRows: () => ok([]),
          fetchByIds: () => ok([]),
          pullTombstones: () => ok([]),
          subscribe: () => () => undefined,
          fetchConfig: () => ok({ config: null, profile: null }),
          reportTz: () => ok('unchanged' as const),
        },
        clearCacheStorage: async () => undefined,
        clearLocalSessionIf: async () => true,
        goToAuth: () => undefined,
        setExitNotice: () => undefined,
        deviceId: () => 'dev-e2e',
        create: (b, o) => M.createSync(b, { ...o, skipConfig: true }),
        onLeader: (on: boolean) => {
          s.leader = on;
        },
        onActivity: () => () => undefined,
      };
      const sync = M.wireSync(boot, deps);
      s.stop = () => sync?.stop();
    },
    { name, user: USER },
  );
}

const state = (page: Page) => page.evaluate(() => ({ leader: window.__s?.leader ?? false, ensures: window.__s?.ensures ?? 0, sent: window.__s?.sent ?? [] }));
const enqueue = (page: Page, input: Record<string, unknown>) => page.evaluate(async (i) => void (await window.__s?.outbox?.enqueue(i)), input);
const setDown = (page: Page, down: boolean) => page.evaluate((d) => void (window.__s && (window.__s.down = d)), down);

const TODO = {
  id: ID, title: '待办', done: false, due: null, important: false, project: '', note: '', source: 'page', raw_text: '',
  batch_id: null, from_note_id: null, from_anniv_id: null, short: null, short_by: null, done_at: 0, remind_days: null,
  remind_time: '09:00', due_time: null, remind_before_min: null, push_show_title: null, notified_for: null, snooze_at: null,
  created_at: 1, updated_at: 1,
};

test('非主页往已排队的 patch 再合并一次（待发数不变）：主页马上发出合并后的内容，只发一次', async ({ page, context }) => {
  const name = `p-oxt-${Math.random().toString(36).slice(2, 8)}`;
  const other = await context.newPage();
  await open(page);
  await open(other);
  await start(page, name);
  await expect.poll(async () => (await state(page)).leader, { timeout: 5000 }).toBe(true);
  await start(other, name);
  await page.waitForTimeout(300);
  // 谁是主页以 onLeader 为准（两页都在前台，正常是先开的那页）
  const [lead, follow] = (await state(page)).leader ? [page, other] : [other, page];
  expect((await state(follow)).leader).toBe(false);

  // 主页断网（会话检查就断网：队列不动、没发过的项还能合并，也不排退避计时）
  await setDown(lead, true);
  const before = (await state(lead)).ensures;
  await enqueue(follow, { table: 'todos', id: ID, op: 'insert', data: TODO });
  await enqueue(follow, { table: 'todos', id: ID, op: 'patch', data: { title: '一' } });
  // 等主页收到提醒、试过发送（发不出去）
  await expect.poll(async () => (await state(lead)).ensures, { timeout: 5000 }).toBeGreaterThan(before);
  await lead.waitForTimeout(500);
  expect((await state(lead)).sent).toEqual([]);

  // 主页恢复（不触发任何发送），非主页再改一次：并进上一个 patch，待发数不变
  await setDown(lead, false);
  const pendingBefore = await follow.evaluate(() => window.__s?.outbox?.getStatus().pending);
  await enqueue(follow, { table: 'todos', id: ID, op: 'patch', data: { title: '二' } });
  expect(await follow.evaluate(() => window.__s?.outbox?.getStatus().pending)).toBe(pendingBefore);

  // 主页 3 秒内发出（定时发送是 30 秒）：insert 一次、合并后的 patch 一次
  await expect.poll(async () => (await state(lead)).sent.length, { timeout: 3000 }).toBe(2);
  await lead.waitForTimeout(500);
  const { sent } = await state(lead);
  expect(sent.map((x) => x.kind)).toEqual(['insert', 'patch']);
  expect(sent[1]?.data['title']).toBe('二');
  expect((await state(follow)).sent).toEqual([]);

  for (const p of [follow, lead]) await p.evaluate(async () => {
    await window.__s?.stop?.();
    window.__s?.close?.();
  });
  await page.evaluate(
    (n) =>
      new Promise<void>((res) => {
        const r = indexedDB.deleteDatabase(n);
        r.onsuccess = r.onerror = r.onblocked = () => res();
      }),
    name,
  );
  await other.close();
});
