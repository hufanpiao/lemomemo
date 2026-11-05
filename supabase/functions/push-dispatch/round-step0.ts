// push-dispatch 第 0 步：打租约出队、重算 remind_at、按租约收尾（b13882b^ 的 round.ts 第 338～430 行）。
// 11-03 从 round.ts 原样搬来（REMIND-round-split：只搬家、不改行为）；流程总说明在 round.ts 文件头。
// 11-04 改成租约式出队（REMIND-queue-crash-loss 方案丙，R-348；迁移 20261104130000）：出队不删，处理完调一次 finishQueue，
//   放回的（读行失败、预算到了、乐观写回不成立）清租约，其余按租约删。中途崩了（CPU 硬上限、墙钟超时）不调 finish，
//   租约 QUEUE_LEASE_S 过期后别的轮重取，重算是幂等的；取过 5 次都没处理完的由出队函数丢掉、以 claim 为空返回，这里记 queue_poison。
// 11-04 审查返工（代码审查 H1 / 安全审查必改 1）、11-05 安全复审 N1：每轮分两段出队——
//   ① 单项重试：popQueue(…, retry = true) 只取取过的项（attempts ≥ 1）、一次 1 项，处理完单独 finish 再取下一项；
//      取空、做满 limits.queueRetryPops 次（QUEUE_RETRY_POPS = 20）、这一轮过了 limits.queueRetryMs（5 秒）或总预算到了就停。
//      一批崩了以后同批的项一项一项单独重算，只有一算就崩的那一项次数会涨到 5、被丢掉，别的项不被连坐。
//   ② 新项按批：不管重试项还剩多少，都再 popQueue(queuePop, …, retry = false) 一次，只取 attempts = 0 的项（每人 50、总数 500）。
//      重试项再多也挡不住别人新改的项（11-04 版有重试项时不按批出队，一批 500 项崩一次，全站新改的项要等约 25 分钟）。
//   ①里取到的项崩了（进程死掉）这一轮就没有②；那一项下次被重取最早在租约（3 分钟）过期后，所以②最多耽误这一轮。
// 第 0 步的结果（安全审查必改 3）记进心跳：queue_ok（这一轮出队、读行、收尾都没出错是 1，否则 0）、queue_poison（这一轮丢掉的有毒项个数；
//   core.ts 再按首尔当天累计），lemo-ops 据此提示（workers/lemo-ops/src/push-queue.ts）。
import type { ItemRow, LogRow, Profile, QueueItem, QueueRef, RoundCtx, UserSettings } from './round-types.ts';
import { groupBy, logTzInvalid, pool, uniq } from './round-util.ts';

// ---------------- 第 0 步：打租约出队、重算 remind_at、按租约收尾 ----------------

/** 第 0 步这一轮的结果（进心跳 detail 的 queue_ok、queue_poison） */
export interface QueueStat { ok: boolean; poison: number }

export async function step0(c: RoundCtx, logs: LogRow[], overBudget: () => boolean): Promise<QueueStat> {
  const stat: QueueStat = { ok: true, poison: 0 };
  /** 出队一次并处理；出队失败返回 null，否则返回取到几项（含有毒项） */
  const once = async (retry: boolean): Promise<number | null> => {
    let got: QueueItem[];
    try {
      got = await c.store.popQueue(retry ? 1 : c.limits.queuePop, c.limits.queueLeaseS, retry);
    } catch {
      c.log('queue_pop_failed');
      stat.ok = false;
      return null;
    }
    for (const x of got) {
      if (x.claim === null) {
        c.log('queue_poison');   // 有毒项：出队函数已删掉，不再处理
        stat.poison++;
      }
    }
    const items = got.filter((x) => x.claim !== null);
    if (items.length > 0) await batch(c, logs, overBudget, items, stat);
    return got.length;
  };
  // ① 单项重试
  for (let i = 0; i < c.limits.queueRetryPops; i++) {
    if (overBudget() || c.now() - c.t0 >= c.limits.queueRetryMs) break;
    const n = await once(true);
    if (n === null) return stat;   // 出队函数调不到（例如回滚到旧版、签名对不上）：②也一样调不到
    if (n === 0) break;
  }
  // ② 新项按批：每轮都做
  if (!overBudget()) await once(false);
  return stat;
}

/** 处理出队函数交出的一批（同一个租约号）：读行、重算、写回，最后按租约收尾 */
async function batch(c: RoundCtx, logs: LogRow[], overBudget: () => boolean, items: readonly QueueItem[], stat: QueueStat): Promise<void> {
  const claim = items[0]?.claim;   // 同一批同一个租约号
  if (!claim) return;
  // 收尾：release 里的放回，这个租约的其余项删掉。失败不重试：租约过期以后别的轮重取，最多晚几分钟、多算一次
  const finish = async (release: readonly QueueRef[]) => {
    try {
      await c.store.finishQueue(claim, release.map((x) => ({ table_name: x.table_name, id: x.id })));
    } catch {
      c.log('queue_finish_failed');
      stat.ok = false;
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
    stat.ok = false;
    await finish(items);   // 整批放回
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
    if (!row || row.user_id !== q.user_id) return;   // 读的时候已经没了（不放回：finish 按租约删掉；孤儿本来也由出队函数删）
    const prof = profiles.get(q.user_id);
    if (!prof) {
      // 安全审查建议 ③：profiles 里没有这个人（注销清理到一半等）。出队函数已判过 account_usable，这里不放回（放回只会每分钟再来一次），
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
      c.log(`recalc_failed:${q.table_name}`);   // 行里的值不合格（例如时刻串坏了）：跳过这一行，不放回（放回只会每分钟再错一次）
      return;
    }
    if (patch === null) return;
    const same = patch.remind_at === row.remind_at && (patch.next_date === undefined || patch.next_date === (row.next_date ?? null));
    if (same) return;
    try {
      // 乐观条件（代码审查建议 ④）：读完以后行又被改了就不写，放回队列下一轮按新值重算
      if (!(await c.store.writeRemind(q.table_name, q.id, q.user_id, patch, row.remind_at))) back.push(q);
    } catch {
      back.push(q);
    }
  });
  await finish(back);
  await logTzInvalid(c, logs, tzNotes, now);
}
