// push-dispatch 第 1～8 步：到点、免打扰、认领、发送、resolve、设备写回（b13882b^ 的 round.ts 第 432～702 行）。
// 11-03 从 round.ts 原样搬来（REMIND-round-split：只搬家、不改行为）；流程总说明在 round.ts 文件头。
import { checkEndpoint } from '../_shared/push/endpoint.ts';
import type { PushOptions } from '../_shared/push/send.ts';
import { AHEAD_MS, BEHIND_MS, LOG_SRC, SNOOZE_MIN, kindOf, type DeviceOutcome, type DeviceRow, type ItemRow, type LogRow, type Profile, type RoundCtx, type RoundResult, type Table, type UserSettings } from './round-types.ts';
import { filterUsable, groupBy, isDue, isHandledAfterPush, logTzInvalid, parseDnd, pool, renderText, showTitleOf, uniq } from './round-util.ts';

// ---------------- 第 1～8 步 ----------------

/** tz：第 2 步定下的显示和免打扰时区（current_tz；R-316 时区坏了的日程用它自己的 tz） */
type Cand = { table: Table; row: ItemRow; due: number; tz?: string };

export async function steps1to8(c: RoundCtx, logs: LogRow[], res: RoundResult, overBudget: () => boolean): Promise<void> {
  const now = c.now();
  const lo = now - BEHIND_MS;
  const hi = now + AHEAD_MS;

  // 第 1 步：到点的
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
  let handled: { table: Table; row: ItemRow }[] = [];
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
  if (cands.length === 0 && handled.length === 0) return;

  const users = uniq([...cands, ...handled].map((x) => x.row.user_id));
  let profiles: Map<string, Profile>;
  let settings: Map<string, UserSettings>;
  let devs: Map<string, DeviceRow[]>;
  try {
    const [p, s, d] = await Promise.all([c.store.profiles(users), c.store.settings(users), c.store.devices(users)]);
    profiles = p;
    settings = s;
    devs = groupBy(d, (x) => x.user_id);
  } catch {
    c.log('dispatch_read_failed');
    return;
  }

  // 第 2 步：免打扰。
  //   R-316：current_tz 不认识时，有时刻的日程改用日程自己的 tz 算显示时刻和免打扰，照常推，记 tz_invalid（code 'profiles:event_tz'）；
  //   待办、纪念日、全天日程没有自己的时区，这一轮跳过、留在窗口里（记 tz_invalid，code 'profiles'）。tz_invalid 每人每小时最多一条。
  //   安全审查建议 ①：每个候选单独 try，isValidTz、dndDeferUntil 出错只影响这一条（记 dnd_failed，留在窗口里下一分钟再来）。
  //   代码审查建议 ②：循环里看时间预算，到了就停（没处理的算 left）。
  //   复审建议：这里加进 left 的是上界——剩下的候选里有的本来会因没有 profile、免打扰顺延、时区不认识或没有设备而不发，没逐条判断就全算上。
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

  // 发送的共享状态
  const stats = new Map<string, { dev: DeviceRow; out: DeviceOutcome }>();
  const statOf = (d: DeviceRow) => {
    let s = stats.get(d.id);
    if (!s) stats.set(d.id, (s = { dev: d, out: { ok: false, fails: 0, drop: false } }));
    return s;
  };
  const alive = (u: string, apple: 'any' | 'no-apple') => (devs.get(u) ?? []).filter((d) => {
    if (stats.get(d.id)?.out.drop) return false;
    if (apple === 'any') return true;
    const ep = checkEndpoint(d.push_endpoint);
    return !ep.ok || !ep.apple;   // 不合格的端点交 deliver 判 bad_endpoint、置空；苹果的一律不发 resolve
  });
  let sends = 0;
  let stopped = false;
  /**
   * 认领前占发送名额；时间或条数到了就停（budget_hit），回 false。
   * 名额只增不退（代码审查建议 ⑩）：发失败、设备中途被判 drop、组负载失败都不退——按“尝试过的设备数”封顶，宁可这一轮少发几条，
   * 也不让坏设备多的人把一轮拖长；唯一退还的是认领没拿到（别的轮已经推了），那时一条都没发
   */
  const reserve = (n: number): boolean => {
    if (stopped) return false;
    if (overBudget() || (sends > 0 && sends + n > c.limits.sendLimit)) {
      stopped = true;
      res.budget_hit = true;
      return false;
    }
    sends += n;
    return true;
  };
  const sendTo = async (x: { table: Table; row: ItemRow }, targets: readonly DeviceRow[], payload: Uint8Array<ArrayBuffer>, opt: PushOptions, resolve: boolean): Promise<boolean> => {
    let anyOk = false;
    // 代码审查建议 ②：同一条目的几台设备并发发，结果按设备顺序记
    const live = targets.filter((d) => !stats.get(d.id)?.out.drop);
    const rs = await Promise.all(live.map(async (d) => [d, await c.deliver(d, payload, opt)] as const));
    for (const [d, r] of rs) {
      const s = statOf(d);
      const base = { user_id: x.row.user_id, t: c.now(), device: d.id, kind: 'run' as const, src: LOG_SRC, coll: x.table, item_id: x.row.id, ...(resolve ? { fields: ['resolve'] } : {}) };
      if (r.outcome === 'ok') {
        anyOk = true;
        s.out.ok = true;
        logs.push({ ...base, act: 'push_ok', code: 'ok' });
      } else if (r.outcome === 'bad_endpoint' || r.outcome === 'bad_keys') {
        s.out.drop = true;
        logs.push({ ...base, act: 'push_bad_endpoint', code: r.outcome === 'bad_endpoint' ? r.reason : 'bad_keys' });
      } else if (r.outcome === 'gone') {
        s.out.drop = true;
        logs.push({ ...base, act: 'push_failed', code: 'gone' });
      } else {
        s.out.fails++;
        logs.push({ ...base, act: 'push_failed', code: r.outcome });
      }
    }
    return anyOk;
  };

  // 第 3～6 步：提醒
  await pool(ready, c.limits.concurrency, async (x) => {
    const u = x.row.user_id;
    const targets = alive(u, 'any');
    if (targets.length === 0) return;
    if (!reserve(targets.length)) {
      res.left++;
      return;
    }
    let mine: boolean;
    try {
      mine = await c.store.claim(x.table, x.row.id, u, x.due);
    } catch {
      mine = false;
      c.log('claim_failed');
    }
    if (!mine) {
      sends -= targets.length;
      return;
    }
    res.claimed++;
    const prof = profiles.get(u) as Profile;
    let payload: Uint8Array<ArrayBuffer>;
    try {
      const kind = kindOf(x.table);
      const tz = x.tz ?? prof.current_tz;
      const allDay = x.table === 'events' && (x.row.time === null || x.row.time === undefined) && typeof x.row.date === 'string';
      // 全天日程的“开始”是当天的 remind.default_time（current_tz）；文案按 R-333 由 notify-text 写“今天 · / 明天 ·”，不写时刻
      const timeMs = x.table === 'events' ? (c.logic.eventStartAt(x.row, tz, settings.get(u)?.['remind.default_time']) ?? x.due) : x.due;
      const n = c.logic.notify({
        kind,
        title: String((x.table === 'anniversaries' ? x.row.name : x.row.title) ?? ''),
        source: String(x.row.source ?? ''),
        showTitle: showTitleOf(x.row, settings.get(u)),
        timeMs,
        dueTime: x.table === 'todos' ? (x.row.due_time ?? null) : null,
        tz,
        allDay: allDay ? { date: x.row.date as string, at: x.due } : null,
      });
      const text = renderText(n, c.logic.t, prof.ui_locale);
      // R-294、R-307、R-308：通知上两个按钮（action 名 snooze、done、ack，SW 由前端 A 接）
      const snooze = { label: c.logic.t('remind.push.action.snooze', {}, prof.ui_locale), minutes: SNOOZE_MIN };
      // R-308：待办“推迟 + 完成”，日程、纪念日“推迟 + 知道了”（和 shared/logic/notify-text.ts 的 actionsFor 一致，测试核对）
      const second = kind === 'todo'
        ? { done: { label: c.logic.t('remind.push.action.done', {}, prof.ui_locale) } }
        : { ack: { label: c.logic.t('remind.push.action.ack', {}, prof.ui_locale) } };
      // REMIND-close-occkey：带上“同一次提醒”的标识（shared 的 occurrenceKey，SW 撤回通知时比它）
      payload = c.buildPayload({ type: 'remind', user_id: u, kind, id: x.row.id, due_at: x.due, occurrenceKey: c.logic.occurrenceKey(kind, x.row, x.due, 'push'), title: text.title, body: text.body, snooze, ...second });
    } catch (e) {
      // 最多一次：已认领，这一条不再推（App 的“错过的提醒”兜底）；只记原因码
      const code = (e as { code?: unknown })?.code;
      res.failed++;
      logs.push({ user_id: u, t: c.now(), device: null, kind: 'run', act: 'push_failed', src: LOG_SRC, coll: x.table, item_id: x.row.id, code: code === 'bad_payload' || code === 'payload_too_large' ? code : 'build_failed' });
      return;
    }
    const ttl = Math.max(60, Math.floor((x.due + BEHIND_MS - c.now()) / 1000));
    let ok: boolean;
    try {
      ok = await sendTo(x, targets, payload, { ttl, urgency: 'high' }, false);
    } catch {
      c.log('send_crashed');   // 不该发生（deliver 自己吞错）；按“认领后没发出”算，不计 sent、failed
      return;
    }
    if (ok) res.sent++;
    else res.failed++;
    // 第 6 步：纪念日推过以后算下一次（B5 填实现）
    if (x.table === 'anniversaries') {
      try {
        const nx = c.logic.annivNext(x.row, { tz: prof.current_tz, now: x.due + 1, settings: settings.get(u) ?? {} });
        // 乐观条件：推完以后用户又改了这条纪念日（触发器已入队，第 0 步会按新值重算），就不覆盖
        if (nx && !(await c.store.writeRemind(x.table, x.row.id, u, { remind_at: nx.remind_at, next_date: nx.next_date }, x.row.remind_at))) c.log('anniv_next_stale');
      } catch {
        c.log('anniv_next_failed');
      }
    }
  });

  // 第 5 步之二：resolve（Edge 等；苹果端点一律不发）
  await pool(handled, c.limits.concurrency, async (x) => {
    const u = x.row.user_id;
    const pushedFor = x.row.pushed_for as number;
    const targets = alive(u, 'no-apple');
    if (!reserve(targets.length)) return;
    let mine: boolean;
    try {
      mine = await c.store.releasePushed(x.table, x.row.id, u, pushedFor);
    } catch {
      mine = false;
      c.log('release_failed');
    }
    if (!mine || targets.length === 0) {
      sends -= targets.length;
      return;
    }
    let payload: Uint8Array<ArrayBuffer>;
    try {
      payload = c.buildPayload({ type: 'resolve', user_id: u, kind: kindOf(x.table), id: x.row.id, due_at: pushedFor, occurrenceKey: c.logic.occurrenceKey(kindOf(x.table), x.row, pushedFor, 'resolve') });
    } catch {
      return;
    }
    try {
      await sendTo(x, targets, payload, { ttl: 3600, urgency: 'normal' }, true);
    } catch {
      c.log('send_crashed');
    }
  });

  // 轮末：每台设备写一次
  const nowIso = new Date(c.now()).toISOString();
  for (const { dev, out } of stats.values()) {
    try {
      await c.store.deviceOutcome(dev, out, nowIso);
    } catch {
      c.log('device_write_failed');
    }
  }
}
