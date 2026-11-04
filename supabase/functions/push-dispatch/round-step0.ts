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
    const tzInvalid = () => {
      if (!tzNotes.has(q.user_id)) tzNotes.set(q.user_id, q.table_name);
    };
    let patch: { remind_at: number | null; next_date?: string | null } | null;
    try {
      if (q.table_name === 'events') {
        if (row.time !== null && row.time !== undefined && (typeof row.tz !== 'string' || !c.logic.isValidTz(row.tz))) {
          tzInvalid();
          return;
        }
        // 日程是固定时刻，不用 current_tz；prevRemindAt 照样传（R1：每个调用点都传这一行现在的 remind_at）
        patch = { remind_at: c.logic.remindAtOf('event', row, prof.current_tz, now, row.remind_at) };
      } else if (!c.logic.isValidTz(prof.current_tz)) {
        tzInvalid();
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
