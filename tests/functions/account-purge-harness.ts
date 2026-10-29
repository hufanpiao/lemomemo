// tests/functions/account-purge*.test.ts 共用（B1 第九批从 account-purge.test.ts 拆出）：内存版的库、R2、服务器备份和发件箱（world），
// 经 account 申请注销、跑一次 account-purge、铺库外数据的小工具，以及第一次满 7 天的时刻。
import { expect } from 'vitest';
import { handle, R2_BUCKETS } from '../../supabase/functions/account-purge/core.ts';
import { handle as accountHandle } from '../../supabase/functions/account/core.ts';
import { MemoryObjStore } from '../fakes/objstore-memory.ts';
import { putSeedObjects } from '../fakes/objstore-seed.ts';
import { A, accountDeps, accountReq, B, Clock, cronReq, FakeBackups, FakeDb, type Outbox, purgeDeps } from './account-fakes.ts';

export function world() {
  const clock = new Clock();
  const db = new FakeDb(clock);
  db.addUser(A, 'A@Test.local');
  db.addUser(B, 'b@test.local', { ui_locale: 'ko-KR' });
  const r2 = new MemoryObjStore(R2_BUCKETS);
  const backups = new FakeBackups();
  const box: Outbox[] = [];
  return { clock, db, r2, backups, box };
}

export type World = ReturnType<typeof world>;

export async function requestDeletion(w: World, uid: string) {
  const deps = accountDeps(w.db, w.box, { user: uid });
  const r = await accountHandle(accountReq({ action: 'delete', confirm: '注销' }), deps);
  await Promise.all(deps.bg);
  expect(r.status).toBe(200);
}

export async function runPurge(w: World, over: Parameters<typeof purgeDeps>[4] = {}) {
  const deps = purgeDeps(w.db, w.r2, w.backups, w.box, over);
  const res = await handle(cronReq(), deps);
  return { res, body: (await res.json()) as Record<string, unknown>, logs: deps.logs };
}

/** 两个人的库外数据：四个 R2 桶（seed）、两个日期的服务器备份 */
export async function seedOutside(w: World) {
  await putSeedObjects(w.r2);
  for (const d of ['20261101', '20261102']) for (const u of [A, B]) for (const t of ['notes', 'todos']) w.backups.files.add(`${d}/${u}/${t}.json.gz`);
}

/** 到“满 7 天后的第一次 03:30（首尔）”：申请在 10-29 12:00（首尔），+7 天是 11-05 12:00，下一次 03:30 是 11-06 03:30 = UTC 11-05 18:30 */
export const FIRST_RUN_AFTER = Date.parse('2026-11-05T18:30:00Z');
