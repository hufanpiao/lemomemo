// push-dispatch 第 1～8 步：到点、免打扰、认领、发送、resolve、设备写回（b13882b^ 的 round.ts 第 432～702 行）。
// 11-03 从 round.ts 原样搬来（REMIND-round-split：只搬家、不改行为）；流程总说明在 round.ts 文件头。
// 11-04 steps1to8 再拆成几段（REMIND-steps1to8-split：只搬家、不改行为）：这里留第 1、2 步和总调用，第 3～8 步在 round-send.ts。
// 11-05 REMIND-split-low L4：第 2 步 step2 改名 screenDnd；Cand、Item、UserData 从 round-types.ts 取。
import { AHEAD_MS, BEHIND_MS, type Cand, type Item, type LogRow, type RoundCtx, type RoundResult, type UserData } from './round-types.ts';
import { filterUsable, groupBy, isDue, isHandledAfterPush, logTzInvalid, parseDnd, pool, uniq } from './round-util.ts';
import { makeSender, remindOne, resolveOne, writeDeviceOutcomes } from './round-send.ts';

// ---------------- 第 1～8 步 ----------------

/** 第 1 步：到点的提醒候选和 resolve 的候选；只留账号能用的，每人每轮最多 perUser 条 */
async function collect(c: RoundCtx, now: number): Promise<{ cands: Cand[]; handled: Item[] }> {
  const lo = now - BEHIND_MS;
  const hi = now + AHEAD_MS;
  let cands: Cand[] = [];
  try {
    for (const { table, row } of await c.store.dueRows(lo, hi, c.limits.perUser, c.limits.due)) {
      const due = isDue(table, row, now);
      if (due !== null) cands.push({ table, row, due });
    }
  } catch {
    c.log('due_query_failed');
  }
  // resolve 的候选（排在提醒之后）
  let handled: Item[] = [];
  try {
    for (const x of await c.store.pushedRows(lo, now, c.limits.perUser, c.limits.due)) if (isHandledAfterPush(x.table, x.row)) handled.push(x);
  } catch {
    c.log('resolve_query_failed');
  }
  cands.sort((a, b) => a.due - b.due || a.table.localeCompare(b.table) || a.row.id.localeCompare(b.row.id));
  cands = cands.slice(0, c.limits.due);

  const usable = new Set(await filterUsable(uniq([...cands, ...handled].map((x) => x.row.user_id)), c.isUsable, c.log, c.limits.concurrency));
  cands = cands.filter((x) => usable.has(x.row.user_id));
  handled = handled.filter((x) => usable.has(x.row.user_id));
  // 每人每轮最多 perUser 条（按 due_at 先后；多出的留在窗口里，下一分钟再发）
  const perUser = new Map<string, number>();
  cands = cands.filter((x) => {
    const n = perUser.get(x.row.user_id) ?? 0;
    perUser.set(x.row.user_id, n + 1);
    return n < c.limits.perUser;
  });
  return { cands, handled };
}

/** 一次读出这几个人的 profile、设置、设备；读失败记 dispatch_read_failed，这一轮第 2～8 步都不做 */
async function readUsers(c: RoundCtx, users: string[]): Promise<UserData | null> {
  try {
    const [p, s, d] = await Promise.all([c.store.profiles(users), c.store.settings(users), c.store.devices(users)]);
    return { profiles: p, settings: s, devs: groupBy(d, (x) => x.user_id) };
  } catch {
    c.log('dispatch_read_failed');
    return null;
  }
}

// 第 2 步：免打扰。
//   R-316：current_tz 不认识时，有时刻的日程改用日程自己的 tz 算显示时刻和免打扰，照常推，记 tz_invalid（code 'profiles:event_tz'）；
//   待办、纪念日、全天日程没有自己的时区，这一轮跳过、留在窗口里（记 tz_invalid，code 'profiles'）。tz_invalid 每人每小时最多一条。
//   安全审查建议 ①：每个候选单独 try，isValidTz、dndDeferUntil 出错只影响这一条（记 dnd_failed，留在窗口里下一分钟再来）。
//   代码审查建议 ②：循环里看时间预算，到了就停（没处理的算 left）。
//   复审建议：这里加进 left 的是上界——剩下的候选里有的本来会因没有 profile、免打扰顺延、时区不认识或没有设备而不发，没逐条判断就全算上。
async function screenDnd(c: RoundCtx, logs: LogRow[], res: RoundResult, cands: Cand[], d: UserData, overBudget: () => boolean, now: number): Promise<Cand[]> {
  const { profiles, settings, devs } = d;
  const tzNotes = new Map<string, string>();
  const ready: Cand[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (overBudget()) {
      res.budget_hit = true;
      res.left += cands.length - i;
      break;
    }
    const x = cands[i] as Cand;
    const u = x.row.user_id;
    const prof = profiles.get(u);
    if (!prof) continue;
    let until: number | null;
    try {
      if (c.logic.isValidTz(prof.current_tz)) {
        x.tz = prof.current_tz;
      } else if (x.table === 'events' && x.row.time !== null && x.row.time !== undefined && typeof x.row.tz === 'string' && c.logic.isValidTz(x.row.tz)) {
        x.tz = x.row.tz;
        if (!tzNotes.has(u)) tzNotes.set(u, 'profiles:event_tz');
      } else {
        tzNotes.set(u, 'profiles');
        continue;
      }
      until = c.logic.dndDeferUntil(x.due, x.tz, parseDnd(settings.get(u)?.['remind.dnd']));
    } catch {
      c.log('dnd_failed');
      continue;
    }
    if (until !== null && until > x.due) {
      try {
        await c.store.setDeferUntil(x.table, x.row.id, u, until);
      } catch {
        c.log('defer_failed');
      }
      continue;
    }
    if (!(devs.get(u)?.length)) continue;   // 没有能收推送的设备：不认领（不算 claimed，也不算失败）
    ready.push(x);
  }
  await logTzInvalid(c, logs, tzNotes, now);
  return ready;
}

export async function steps1to8(c: RoundCtx, logs: LogRow[], res: RoundResult, overBudget: () => boolean): Promise<void> {
  const now = c.now();
  const { cands, handled } = await collect(c, now);
  if (cands.length === 0 && handled.length === 0) return;
  const d = await readUsers(c, uniq([...cands, ...handled].map((x) => x.row.user_id)));
  if (!d) return;
  const ready = await screenDnd(c, logs, res, cands, d, overBudget, now);

  const S = makeSender(c, logs, res, d.devs, overBudget);
  // 第 3～6 步：提醒
  await pool(ready, c.limits.concurrency, (x) => remindOne(c, S, d, x));
  // 第 5 步之二：resolve（Edge 等；苹果端点一律不发）
  await pool(handled, c.limits.concurrency, (x) => resolveOne(c, S, x));
  // 轮末：每台设备写一次
  await writeDeviceOutcomes(c, S.stats);
}
