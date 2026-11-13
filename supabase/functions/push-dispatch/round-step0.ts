// push-dispatch 第 0 步：打租约出队、重算 remind_at、按租约收尾（架构 5.3 第 0 步；方案-提醒队列重写 3.3、3.7；迁移 20261113100000）。
// 每轮两段出队：① 单项重试（只取取过的项、一次 1 项，至多 queueRetryPops 次、只在头 queueRetryMs 毫秒）；② 新项按批（每轮都做，先全站 prio 0）。
// 每批读行、重算、带乐观条件写回，最后 finish：放回的清租约，其余按租约删；中途崩了不调 finish，租约过期后重取，取满有毒次数的由出队函数丢掉。
// 每项一个结果：不是 same / gone 的记一行函数日志 recalc:<结果>:<表>:<id 前 8 位>；prio 0 的 written、ack、r336、failed 另进 logs（act = recalc）。
// fresh 的待办（新建或改了截止）不传 prevRemindAt：提前量已过时回落到截止时刻（R-411 Q2）；其余一律传这一行现在的 remind_at（R1）。
import { LOG_SRC, type ItemRow, type LogRow, type Profile, type QueueItem, type QueueRef, type RoundCtx, type UserSettings } from './round-types.ts';
import { failCode, groupBy, logTzInvalid, pool, uniq } from './round-util.ts';

/** 第 0 步这一轮的结果：ok、poison 进心跳的 queue_ok、queue_poison；written（含 ack）、r336、failed 进心跳的 recalc_* */
export interface QueueStat { ok: boolean; poison: number; written: number; r336: number; failed: number }

/**
 * 一项重算的结果（方案 3.7）：written 写回了；ack 按 S1 例外写回（notified_for = 新 remind_at）；r336 全天日程这一天已提醒过、不写回；
 * tz_invalid 时区认不出、跳过；no_profile profiles 里没有这个人；owner_mismatch 行的主人和队列项对不上；failed 行里的值算不出；
 * released 放回队列（预算到了、乐观条件不成立、写回出错）；same 算出来和原值一样；gone 行已经没了（硬删的孤儿，finish 删掉）。
 * 除 released 外都不放回（放回只会每分钟再来一次；以后这一行再被改，触发器会重新入队）
 */
export type RecalcResult = 'written' | 'ack' | 'r336' | 'tz_invalid' | 'no_profile' | 'owner_mismatch' | 'failed' | 'released' | 'same' | 'gone';

export async function step0(c: RoundCtx, logs: LogRow[], overBudget: () => boolean): Promise<QueueStat> {
  const stat: QueueStat = { ok: true, poison: 0, written: 0, r336: 0, failed: 0 };
  const L = c.limits;
  /** 出队一次并处理；出队失败返回 null，否则返回取到几项（含有毒项） */
  const once = async (retry: boolean): Promise<number | null> => {
    let got: QueueItem[];
    try {
      got = await c.store.popQueue(retry ? 1 : L.queuePop, L.queueLeaseS, retry, L.queuePerUser, L.queuePoison, c.logic.rulesVer);
    } catch (e) {
      c.log(failCode('queue_pop_failed', e));
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
  for (let i = 0; i < L.queueRetryPops; i++) {
    if (overBudget() || c.now() - c.t0 >= L.queueRetryMs) break;
    const n = await once(true);
    if (n === null) return stat;   // 出队函数调不到（例如签名对不上）：②也一样调不到
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
    } catch (e) {
      c.log(failCode('queue_finish_failed', e));
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
  } catch (e) {
    c.log(failCode('recalc_read_failed', e));
    stat.ok = false;
    await finish(items);   // 整批放回
    return;
  }

  const back: QueueRef[] = [];
  const tzNotes = new Map<string, string>();
  const now = c.now();
  const note = (q: QueueItem, r: RecalcResult) => {
    if (r === 'released') back.push(q);
    if (r === 'written' || r === 'ack') stat.written++;
    else if (r === 'r336') stat.r336++;
    else if (r === 'failed') stat.failed++;
    if (r === 'same' || r === 'gone') return;   // 只计数不逐条打：批量时一轮最多 500 项
    c.log(`recalc:${r}:${q.table_name}:${q.id.slice(0, 8)}`);
    if (q.prio === 0 && (r === 'written' || r === 'ack' || r === 'r336' || r === 'failed')) {
      logs.push({ user_id: q.user_id, t: now, device: null, kind: 'run', act: 'recalc', src: LOG_SRC, coll: q.table_name, item_id: q.id, code: r });
    }
  };

  /** 一项：算出新的 remind_at（纪念日另有 next_date）并带乐观条件写回 */
  const one = async (q: QueueItem): Promise<RecalcResult> => {
    if (overBudget()) return 'released';
    const row = rows.get(`${q.table_name}:${q.id}`);
    if (!row) return 'gone';
    if (row.user_id !== q.user_id) return 'owner_mismatch';
    const prof = profiles.get(q.user_id);
    // profiles 里没有这个人（注销清理到一半等；安全审查建议 ③）：出队函数已判过 account_usable，丢弃
    if (!prof) return 'no_profile';
    // tz_invalid 的 logs 原因码：日程自己的 tz 不认识记表名 events；current_tz 不认识（待办、纪念日、全天日程）记 profiles（R-316，11-04 主持人定）
    const tzInvalid = (code: string = q.table_name): RecalcResult => {
      if (!tzNotes.has(q.user_id)) tzNotes.set(q.user_id, code);
      return 'tz_invalid';
    };
    const allDay = row.time === null || row.time === undefined;
    let patch: { remind_at: number | null; next_date?: string | null } | null;
    let ackAt: number | undefined;   // S1 例外时 = 读到的 notified_for（安全审查 A4）
    try {
      if (q.table_name === 'events') {
        // 有时刻的日程是固定时刻，按它自己的 tz（tz 为空的 shared 算出 null，不记原因码；0002 的 check 保证真库里存不进来）；
        // 全天日程是浮动时刻，按 current_tz 和设置 remind.default_time（架构 4.6）
        if (!allDay && typeof row.tz === 'string' && !c.logic.isValidTz(row.tz)) return tzInvalid();
        if (allDay && !c.logic.isValidTz(prof.current_tz)) return tzInvalid('profiles');
        patch = { remind_at: c.logic.remindAtOf('event', row, prof.current_tz, now, row.remind_at, settings.get(q.user_id)?.['remind.default_time']) };
        // R-336：全天日程“推过没有”按“这条日程 + 这一天”认——新算出的 remind_at 和原值不同，但 pushed_for 或 notified_for 按 current_tz
        //   和新 remind_at 落在同一天，就当这一天已提醒过：保留原值、不写回（换了“哪一次”时 remind_reset 已清空这两列，不会被压住）。
        //   例外 S1（REMIND-shown-persist）：notified_for 正好等于新算出的 remind_at（客户端按“知道了”写的是本机现算的新时刻）就照写回，
        //   写回时另要求 notified_for 还是这个值（安全审查 A4）
        if (allDay && patch.remind_at !== null && patch.remind_at !== row.remind_at) {
          const at = patch.remind_at;
          if (row.notified_for === at) ackAt = at;
          else if ([row.pushed_for, row.notified_for].some((x) => c.logic.sameRemindDay(x, at, prof.current_tz))) return 'r336';
        }
      } else if (!c.logic.isValidTz(prof.current_tz)) {
        return tzInvalid('profiles');
      } else if (q.table_name === 'todos') {
        patch = { remind_at: c.logic.remindAtOf('todo', row, prof.current_tz, now, q.fresh ? undefined : row.remind_at) };
      } else {
        const nx = c.logic.annivNext(row, { tz: prof.current_tz, now, settings: settings.get(q.user_id) ?? {} });
        patch = nx ? { remind_at: nx.remind_at, next_date: nx.next_date } : null;
      }
    } catch {
      return 'failed';   // 行里的值不合格（例如时刻串坏了）
    }
    if (patch === null) return 'same';
    if (patch.remind_at === row.remind_at && (patch.next_date === undefined || patch.next_date === (row.next_date ?? null))) return 'same';
    try {
      // 乐观条件（代码审查建议 ④）：读完以后行又被改了就不写，放回队列下一轮按新值重算
      if (!(await c.store.writeRemind(q.table_name, q.id, q.user_id, patch, row.remind_at, ackAt))) return 'released';
    } catch (e) {
      c.log(failCode('recalc_write_failed', e));
      return 'released';
    }
    return ackAt === undefined ? 'written' : 'ack';
  };

  await pool(items, c.limits.concurrency, async (q) => note(q, await one(q)));
  await finish(back);
  await logTzInvalid(c, logs, tzNotes, now);
}
