// D3 第 6 点第一条，按原数跑（B2 任务单 BE-2 验收）：替身每个请求拖 3 秒、造 300 条（15 人 × 20 条、每人一台设备，“少量设备、每台多条”），
// 一轮 25 秒内返回、budget_hit 对、left 是没认领的条数；推送服务恢复正常后剩下的在后面几轮发完，每条只发一次。
// 一轮约 22 秒，但不起子进程、不用重型库，按 tests/arch/coverage.test.ts 的规则不算重型，不进 SLOW_NODE_TESTS（留在 node 分组），本条自带 90 秒超时；缩小版在 push-dispatch-round.test.ts。
import { afterEach, describe, expect, it } from 'vitest';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { createFakePush, newPushSubscriber, type FakePushService, type PushSubscriber } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { MemDb, todoRow, uuid } from './push-dispatch-mem.ts';

let fake: FakePushService | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe('D3 第 6 点：时间预算（原数）', () => {
  it('替身每个请求拖 3 秒、300 条：一轮 25 秒内返回 200，budget_hit 为真，剩下的之后发完、每条只发一次', async () => {
    const v = await fakeVapid();
    const db = new MemDb();
    const subs: PushSubscriber[] = [];
    const users = Array.from({ length: 15 }, (_, i) => `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-0000000000bb`);
    for (const u of users) {
      db.user(u);
      const ep = `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
      const s = await newPushSubscriber(ep);
      db.device(u, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
      subs.push(s);
    }
    fake = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub }, delayMs: 3000 });
    const now0 = Date.now();
    for (let i = 0; i < 300; i++) db.put('todos', todoRow(users[i % 15] as string, { remind_at: now0 - 30_000 + i }));

    const t0 = Date.now();
    const res = await handle(cronReq(), depsFor(db, v.keys, { fetch: fake.fetch }));
    const took = Date.now() - t0;
    expect(res.status).toBe(200);
    const r1 = (await res.json()) as { claimed: number; sent: number; failed: number; budget_hit: boolean; left: number };
    expect(took).toBeLessThan(25_000);
    expect(r1.budget_hit).toBe(true);
    expect(r1.claimed).toBeGreaterThan(0);
    expect(r1.sent).toBe(r1.claimed);
    expect(r1.left).toBe(300 - r1.claimed);
    expect(db.beats.at(-1)).toEqual({ claimed: r1.claimed, sent: r1.sent, failed: 0, budget_hit: true, queue_ok: 1, queue_poison: 0, left: r1.left });

    fake.setDelay(0);
    let total = r1.claimed;
    for (let i = 0; i < 10 && total < 300; i++) {
      const r = await handle(cronReq(), depsFor(db, v.keys, { fetch: fake.fetch }));
      total += ((await r.json()) as { claimed: number }).claimed;
    }
    expect(total).toBe(300);
    const ids = fake.requests.filter((r) => r.payload !== null).map((r) => (JSON.parse(r.payload as string) as { id: string }).id);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
  }, 90_000);
});
