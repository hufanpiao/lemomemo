// push-dispatch-round*.test.ts 共用：按“每人几个端点”造一个世界（内存库 + 测试开发的推送替身 tests/fakes/push-service.ts），跑一轮。
// 11-05 从 push-dispatch-round.test.ts 拆出（代码审查复审：那个文件超过 max-lines 300）。
import { expect } from 'vitest';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { createFakePush, newPushSubscriber, type FakePushService, type PushSubscriber } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { MemDb, uuid } from './push-dispatch-mem.ts';

let fakes: FakePushService[] = [];
/** 测试文件里 afterEach(closeFakes)：关掉这一条用例开的推送替身 */
export async function closeFakes(): Promise<void> {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
}

export const fcm = () => `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
export const apple = () => `https://web.push.apple.com/${uuid('a')}`;

export async function world(endpoints: Record<string, string[]>, opt: { delayMs?: number } = {}) {
  const v = await fakeVapid();
  const db = new MemDb();
  const subs: PushSubscriber[] = [];
  const devOf = new Map<number, string>();
  for (const [user, eps] of Object.entries(endpoints)) {
    db.user(user);
    for (const ep of eps) {
      const s = await newPushSubscriber(ep);
      const d = db.device(user, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
      devOf.set(subs.length, d.id);
      subs.push(s);
    }
  }
  const f = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub }, ...(opt.delayMs ? { delayMs: opt.delayMs } : {}) });
  fakes.push(f);
  const deps = (over: Parameters<typeof depsFor>[2] = {}) => depsFor(db, v.keys, { fetch: f.fetch, ...over });
  const pushes = () => f.requests.filter((r) => r.payload !== null).map((r) => ({ dev: devOf.get(r.subscriber?.index ?? -1), p: JSON.parse(r.payload as string) as Record<string, unknown>, headers: r.headers }));
  return { db, f, deps, pushes, v };
}

export async function round(deps: ReturnType<typeof depsFor>) {
  const r = await handle(cronReq(), deps);
  expect(r.status).toBe(200);
  return (await r.json()) as { ok: true; claimed: number; sent: number; failed: number; budget_hit: boolean; left: number };
}
