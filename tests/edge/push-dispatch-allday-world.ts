// push-dispatch 全天日程测试共用的场景（从 push-dispatch-allday.test.ts 拆出，11-04 二轮审查 N-M1 加用例后超过 300 行）：
// 首尔时区、日程日期 11-05；world() 起推送替身（每个测试一个，afterEach(closeWorld) 关掉），round(now) 跑一轮 handle()。
import { msAt, parseHm } from '../../shared/core/date.ts';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { createFakePush, newPushSubscriber, type FakePushService } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { eventRow, type MemDb, UA, uuid } from './push-dispatch-mem.ts';

export const SEOUL = 'Asia/Seoul';
export const DAY = '2026-11-05';
export const EVE = '2026-11-04';
export const at = (hm: string, day = DAY): number => msAt(day, parseHm(hm), SEOUL);

let fake: FakePushService | null = null;
export async function closeWorld(): Promise<void> {
  await fake?.close();
  fake = null;
}

export async function world(db: MemDb) {
  const v = await fakeVapid();
  const ep = `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
  const s = await newPushSubscriber(ep);
  db.device(UA, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
  fake = createFakePush({ subscribers: [s], vapid: { publicKey: v.pub } });
  const f = fake;
  let codes: string[] = [];
  const round = async (now: number) => {
    const deps = depsFor(db, v.keys, { fetch: f.fetch, now: () => now });
    const r = (await (await handle(cronReq(), deps)).json()) as { claimed: number; sent: number };
    codes = deps.codes;
    return r;
  };
  type P = { id: string; type: string; kind: string; title?: string; body?: string; ack?: unknown; done?: unknown };
  const sent = () => f.requests.filter((r) => r.payload !== null).map((r) => JSON.parse(r.payload as string) as P);
  return { round, sent, codes: () => codes };
}

/** 全天日程，入队（等于客户端新建或改了提醒，触发器 events_remind 放进 remind_queue） */
export function allDay(db: MemDb, remindDays: 0 | 1, title = '家庭聚会') {
  return db.put('events', eventRow(UA, { title, date: DAY, time: null, tz: null, remind_days: remindDays, remind_at: null }), true);
}
