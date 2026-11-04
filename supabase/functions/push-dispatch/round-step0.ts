// push-dispatch 第 0 步：出队即删、重算 remind_at（原 round.ts 第 338～430 行）。
// 11-03 从 round.ts 原样搬来（REMIND-round-split：只搬家、不改行为）；流程总说明在 round.ts 文件头。
import type { ItemRow, LogRow, Profile, QueueItem, QueueRef, RoundCtx, UserSettings } from './round-types.ts';
import { groupBy, logTzInvalid, pool, uniq } from './round-util.ts';

// ---------------- 第 0 步：出队即删、重算 remind_at ----------------

export async function step0(c: RoundCtx, logs: LogRow[], overBudget: () => boolean): Promise<void> {
  if (overBudget()) return;
  let items: QueueItem[];
  try {
    items = await c.store.popQueue(c.limits.queuePop);
  } catch {
    c.log('queue_pop_failed');
    return;
  }
  if (items.length === 0) return;
  const requeue = async (xs: readonly QueueRef[]) => {
    if (!xs.length) return;
    try {
      await c.store.requeue(xs.map((x) => ({ table_name: x.table_name, id: x.id })));
    } catch {
      c.log('requeue_failed');
    }
  };

  const users = uniq(items.map((x) => x.user_id));
  let profiles: Map<string, Profile>;
  let settings: Map<string, UserSettings>;
  const rows = new Map<string, ItemRow>();
  try {
    [profiles, settings] = await Promise.all([c.store.profiles(users), c.store.settings(users)]);
    for (const [table, xs] of groupBy(items, (x) => x.table_name)) {
      for (let i = 0; i < xs.length; i += 100) {
        for (const r of await c.store.rows(table, xs.slice(i, i + 100).map((x) => x.id))) rows.set(`${table}:${r.id}`, r);
      }
    }
  } catch {
    c.log('recalc_read_failed');
    await requeue(items);
    return;
  }

  const back: QueueRef[] = [];
  const tzNotes = new Map<string, string>();
  const now = c.now();
  await pool(items, c.limits.concurrency, async (q) => {
    if (overBudget()) {
      back.push(q);
      return;
    }
    const row = rows.get(`${q.table_name}:${q.id}`);
    if (!row || row.user_id !== q.user_id) return;   // 读的时候已经没了（孤儿下一轮由出队函数删；这里不必插回）
    const prof = profiles.get(q.user_id);
    if (!prof) {
      // 安全审查建议 ③：profiles 里没有这个人（注销清理到一半等）。出队函数已判过 account_usable，这里不插回（插回只会每分钟再来一次），
      // 丢弃、记原因码；以后这个人的行再被改，触发器会重新入队
      c.log('recalc_no_profile');
      return;
    }
    // 原因码：日程自己的 tz 不认识记表名 events；current_tz 不认识（待办、纪念日、全天日程）记 profiles（11-04 主持人定，和 R-316 一致）
    const tzInvalid = (code: string = q.table_name) => {
      if (!tzNotes.has(q.user_id)) tzNotes.set(q.user_id, code);
    };
    let patch: { remind_at: number | null; next_date?: string | null } | null;
    try {
      if (q.table_name === 'events') {
        // 有时刻的日程：只有 tz 不为空而且认不出时才跳过、记 events（PUSH-tz-null-event，11-04 主持人定）。tz 为空的照 shared
        //   eventRemindAt 算出 null（不提醒），不记原因码；这种行受 0002 的 check (time is null or tz is not null) 保护，真库里存不进来
        if (row.time !== null && row.time !== undefined && typeof row.tz === 'string' && !c.logic.isValidTz(row.tz)) {
          tzInvalid();
          return;
        }
        // 全天日程（time 为空）是浮动时刻，按 current_tz（架构 4.6）：current_tz 不认识照 R-316 跳过、记 tz_invalid，原因码 profiles
        //   （和第 2 步同一口径；不让 msAt 抛错落到 recalc_failed:events）
        if ((row.time === null || row.time === undefined) && !c.logic.isValidTz(prof.current_tz)) {
          tzInvalid('profiles');
          return;
        }
        // 有时刻的日程是固定时刻，不用 current_tz；全天日程按 current_tz 和设置 remind.default_time（第 6 个参数，只有全天日程当天提醒用）；
        // prevRemindAt 照样传（R1：每个调用点都传这一行现在的 remind_at）
        patch = { remind_at: c.logic.remindAtOf('event', row, prof.current_tz, now, row.remind_at, settings.get(q.user_id)?.['remind.default_time']) };
        // R-336（11-04 负责人定）：全天日程“推过没有”按“这条日程 + 这一天”认，不按具体时刻认——
        //   新算出的 remind_at 和原值不同，但这一行的 pushed_for（服务器推过）或 notified_for（按过“知道了”）按 current_tz 和新 remind_at
        //   落在同一天，就当这一天已经提醒过：remind_at 保持原值、不写回（改 remind.default_time、换了同一天里的时刻都不再推第二次）。
        //   换了“哪一次提醒”（挪日期、改 remind_days、time 在空和非空之间变）由迁移 20261104100000 的触发器 events_occ_reset
        //   清空 notified_for、pushed_for，到这里就不会被压住（二轮审查 N-M1）。被压住时 remind_at 保留旧值，只供第 1 步到点判断用（N-L2）。
        if ((row.time === null || row.time === undefined) && patch.remind_at !== null && patch.remind_at !== row.remind_at) {
          const day = c.logic.dayOf(patch.remind_at, prof.current_tz);
          if ([row.pushed_for, row.notified_for].some((x) => typeof x === 'number' && c.logic.dayOf(x, prof.current_tz) === day)) return;
        }
      } else if (!c.logic.isValidTz(prof.current_tz)) {
        tzInvalid('profiles');   // 待办、纪念日：current_tz 不认识，原因码 profiles（R-316，架构 5.3 第 2 步；11-04 主持人定第 0 步同一口径）
        return;
      } else if (q.table_name === 'todos') {
        patch = { remind_at: c.logic.remindAtOf('todo', row, prof.current_tz, now, row.remind_at) };
      } else {
        const nx = c.logic.annivNext(row, { tz: prof.current_tz, now, settings: settings.get(q.user_id) ?? {} });
        patch = nx ? { remind_at: nx.remind_at, next_date: nx.next_date } : null;
      }
    } catch {
      c.log(`recalc_failed:${q.table_name}`);   // 行里的值不合格（例如时刻串坏了）：跳过这一行，不插回（插回只会每分钟再错一次）
      return;
    }
    if (patch === null) return;
    const same = patch.remind_at === row.remind_at && (patch.next_date === undefined || patch.next_date === (row.next_date ?? null));
    if (same) return;
    try {
      // 乐观条件（代码审查建议 ④）：读完以后行又被改了就不写，插回队列下一轮按新值重算
      if (!(await c.store.writeRemind(q.table_name, q.id, q.user_id, patch, row.remind_at))) back.push(q);
    } catch {
      back.push(q);
    }
  });
  await requeue(back);
  await logTzInvalid(c, logs, tzNotes, now);
}
