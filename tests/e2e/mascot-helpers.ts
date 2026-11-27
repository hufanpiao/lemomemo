// 吉祥物 e2e 共用：起假会话和假后端、取角色身上一定按得中的点（mascot.spec.ts 默认组、mascot-aldo.spec.ts 快读组共用）
import type { Page } from '@playwright/test';
import { fakeRest } from './fake-rest.ts';
import { readRunLogInPage } from './page-helpers.ts';
import { expect, seedFakeSession } from './session-fixture.ts';

export const USER = '0e2e0000-0000-4000-8000-000000000001';
export const rid = (n: number) => `0e2e0000-0000-4000-8000-0000000d7a${String(n).padStart(2, '0')}`;

export interface BootOpts {
  admin?: boolean;
  todos?: Record<string, unknown>[];
}

export async function boot(page: Page, baseURL: string | undefined, picked?: string, o: BootOpts = {}): Promise<{ writes: { table: string; body: unknown }[] }> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: new Date(now).toISOString() };
  const settings = [{ id: rid(1), ...c, key: 'ai.enabled', value: true }];
  if (picked) settings.push({ id: rid(2), ...c, key: 'ui.mascot', value: { v: 1, id: picked } as unknown as boolean });
  // 待办要带齐服务器上的列才进得了本机库（同 todo-autodel-pull.spec.ts）
  const item = { project: '', source: 'page', raw_text: '', short: null, short_by: null, push_show_title: null, batch_id: null, notified_for: null, snooze_at: null };
  const todos = (o.todos ?? []).map((t) => ({
    ...c, ...item, note: '', due: null, done: false, important: false, priority: 'mid', sort_key: null, from_note_id: null, from_anniv_id: null, done_at: now,
    remind_days: null, remind_time: '09:00', due_time: null, remind_before_min: null, ...t,
  }));
  const rest = await fakeRest(page, {
    user: USER,
    tables: { settings, todos },
    profile: { consent_ai_at: c.synced_at },
    writeRev: 2,
    ...(o.todos ? { store: { patch: true } } : {}),
    fixed: {
      // 勾完待办走 rpc apply_patch：假后端回成功（不回的话写入失败会被当成服务器上没了，转成一次删除）
      ...(o.todos ? { apply_patch: { status: 'ok', rev: 2, prev_rev: 1 } } : {}),
      ...(o.admin === undefined ? {} : { my_ai_usage: { ai_used: 0, ai_limit: 50, pacific_date: '2026-11-26', ai_unlimited: o.admin } }),
    },
  });
  return { writes: rest.writes };
}

/**
 * 等角色就绪，把指针停到角色身上，返回按下去一定算“点中”的屏幕坐标。
 * 角色会跟着指针动（lookAt），指针移过去以后原来量到的点可能变成透明处（ci #516：Linux webkit 帧慢，6 次里 5 次按空）。
 * 所以先等运行日志的 mascot ready，取点、移过去、等姿势跟上，再核一次这个点还是不透明，不是就重取。
 */
export async function opaquePoint(page: Page): Promise<{ x: number; y: number }> {
  await page.waitForSelector('[data-testid="mascot"] canvas');
  await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 30_000 }).toContain('mascot ready');
  let p = { x: 0, y: 0 };
  await expect(async () => {
    p = await solidPoint(page);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(600);
    const alpha = await page.evaluate(({ x, y }) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="mascot"] canvas');
      const g = c?.getContext('2d');
      if (!c || !g) return 0;
      const b = c.getBoundingClientRect();
      const k = c.width / b.width;
      return g.getImageData(Math.floor((x - b.left) * k), Math.floor((y - b.top) * k), 1, 1).data[3] ?? 0;
    }, p);
    expect(alpha, '指针停稳后这一点应当还在角色身上').toBeGreaterThanOrEqual(230);
  }).toPass({ timeout: 30_000 });
  return p;
}

/** 连续两次取样（隔 400ms）都不透明、四周 5px 也不透明的点里，离重心最近的一个 */
export async function solidPoint(page: Page): Promise<{ x: number; y: number }> {
  await page.evaluate(() => {
    delete (window as Window & { __mascotSolid?: Set<number> }).__mascotSolid;
  });
  const handle = await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="mascot"] canvas');
    if (!c || c.width === 0 || getComputedStyle(c).opacity !== '1') return null;
    const g = c.getContext('2d');
    if (!g) return null;
    const box = c.getBoundingClientRect();
    const host = c.parentElement?.getBoundingClientRect();
    if (!host) return null;
    const W = c.width;
    const H = c.height;
    const d = g.getImageData(0, 0, W, H).data;
    const m = Math.ceil((5 * W) / box.width);
    const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && (d[(y * W + x) * 4 + 3] ?? 0) >= 230;
    const solid = new Set<number>();
    for (let y = 0; y < H; y += 6) {
      for (let x = 0; x < W; x += 6) {
        if (on(x, y) && on(x - m, y) && on(x + m, y) && on(x, y - m) && on(x, y + m)) solid.add(y * W + x);
      }
    }
    const w = window as Window & { __mascotSolid?: Set<number> };
    const prev = w.__mascotSolid;
    w.__mascotSolid = solid;
    if (!prev) return null;
    const pts: { x: number; y: number }[] = [];
    for (const k of solid) {
      if (!prev.has(k)) continue;
      const px = box.left + ((k % W) / W) * box.width;
      const py = box.top + (Math.floor(k / W) / H) * box.height;
      if (px < host.left || px > host.right || py < host.top || py > host.bottom) continue;
      pts.push({ x: px, y: py });
    }
    if (pts.length <= 20) return null;
    // 取离重心最近的那个真实不透明点（重心本身可能落在镂空处）
    const mx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
    const my = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    return pts.reduce((b, q) => (Math.hypot(q.x - mx, q.y - my) < Math.hypot(b.x - mx, b.y - my) ? q : b));
  }, undefined, { timeout: 30_000, polling: 400 });
  return (await handle.jsonValue()) as { x: number; y: number };
}

/** 减少动态效果时只等画布上有不透明像素（画布是淡入的，不看 opacity） */
export async function opaquePointReduced(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="mascot"] canvas');
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="mascot"] canvas');
    const g = c && c.width > 0 ? c.getContext('2d') : null;
    return g ? g.getImageData(0, 0, c!.width, c!.height).data.some((v, i) => i % 4 === 3 && v > 230) : false;
  }, undefined, { timeout: 30_000 });
}
