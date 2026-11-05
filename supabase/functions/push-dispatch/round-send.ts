// push-dispatch 第 3～8 步：发送的共享状态、提醒发送、纪念日下一次、resolve、轮末设备写回。
// 11-04 从 round-dispatch.ts 的 steps1to8 原样拆出（REMIND-steps1to8-split：只搬家、不改行为）；流程总说明在 round.ts 文件头。
// 11-05 REMIND-split-low L4（只改名、挪类型，不改行为）：Cand、Item、UserData 挪到 round-types.ts；本地 annivNext 改名 writeAnnivNext；
//   remindOne 的 logs、res 收进 Sender（makeSender 本来就拿着这两样），参数从 6 个减到 4 个。
import { checkEndpoint } from '../_shared/push/endpoint.ts';
import type { PushOptions } from '../_shared/push/send.ts';
import { BEHIND_MS, LOG_SRC, SNOOZE_MIN, kindOf, type Cand, type DeviceOutcome, type DeviceRow, type Item, type LogRow, type Profile, type RoundCtx, type RoundResult, type UserData, type UserSettings } from './round-types.ts';
import { renderText, showTitleOf } from './round-util.ts';

export type Sender = ReturnType<typeof makeSender>;

/** 发送的共享状态（一轮一份）：每台设备的结果、发送名额、按设备发送；logs、res 也放在这里，remindOne 从 S 取 */
export function makeSender(c: RoundCtx, logs: LogRow[], res: RoundResult, devs: Map<string, DeviceRow[]>, overBudget: () => boolean) {
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
  /** 退还名额：只在认领没拿到时用（见 reserve 的说明） */
  const unreserve = (n: number): void => {
    sends -= n;
  };
  const sendTo = async (x: Item, targets: readonly DeviceRow[], payload: Uint8Array<ArrayBuffer>, opt: PushOptions, resolve: boolean): Promise<boolean> => {
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
  return { logs, res, stats, alive, reserve, unreserve, sendTo };
}

/** 提醒的负载（文案、两个按钮、occurrenceKey）；出错照原样抛出，由 remindOne 记原因码 */
function remindPayload(c: RoundCtx, x: Cand, prof: Profile, st: UserSettings | undefined): Uint8Array<ArrayBuffer> {
  const u = x.row.user_id;
  const kind = kindOf(x.table);
  const tz = x.tz ?? prof.current_tz;
  const allDay = x.table === 'events' && (x.row.time === null || x.row.time === undefined) && typeof x.row.date === 'string';
  // 全天日程的“开始”是当天的 remind.default_time（current_tz）；文案按 R-333 由 notify-text 写“今天 · / 明天 ·”，不写时刻
  const timeMs = x.table === 'events' ? (c.logic.eventStartAt(x.row, tz, st?.['remind.default_time']) ?? x.due) : x.due;
  const n = c.logic.notify({
    kind,
    title: String((x.table === 'anniversaries' ? x.row.name : x.row.title) ?? ''),
    source: String(x.row.source ?? ''),
    showTitle: showTitleOf(x.row, st),
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
  return c.buildPayload({ type: 'remind', user_id: u, kind, id: x.row.id, due_at: x.due, occurrenceKey: c.logic.occurrenceKey(kind, x.row, x.due, 'push'), title: text.title, body: text.body, snooze, ...second });
}

/** 第 6 步：纪念日推过以后算下一次（B5 填实现） */
async function writeAnnivNext(c: RoundCtx, x: Cand, prof: Profile, st: UserSettings | undefined): Promise<void> {
  try {
    const nx = c.logic.annivNext(x.row, { tz: prof.current_tz, now: x.due + 1, settings: st ?? {} });
    // 乐观条件：推完以后用户又改了这条纪念日（触发器已入队，第 0 步会按新值重算），就不覆盖
    if (nx && !(await c.store.writeRemind(x.table, x.row.id, x.row.user_id, { remind_at: nx.remind_at, next_date: nx.next_date }, x.row.remind_at))) c.log('anniv_next_stale');
  } catch {
    c.log('anniv_next_failed');
  }
}

/** 第 3～6 步：一条提醒（占名额 → 认领 → 组负载 → 发送 → 纪念日下一次） */
export async function remindOne(c: RoundCtx, S: Sender, d: UserData, x: Cand): Promise<void> {
  const { logs, res } = S;
  const u = x.row.user_id;
  const targets = S.alive(u, 'any');
  if (targets.length === 0) return;
  if (!S.reserve(targets.length)) {
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
    S.unreserve(targets.length);
    return;
  }
  res.claimed++;
  const prof = d.profiles.get(u) as Profile;
  let payload: Uint8Array<ArrayBuffer>;
  try {
    payload = remindPayload(c, x, prof, d.settings.get(u));
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
    ok = await S.sendTo(x, targets, payload, { ttl, urgency: 'high' }, false);
  } catch {
    c.log('send_crashed');   // 不该发生（deliver 自己吞错）；按“认领后没发出”算，不计 sent、failed
    return;
  }
  if (ok) res.sent++;
  else res.failed++;
  if (x.table === 'anniversaries') await writeAnnivNext(c, x, prof, d.settings.get(u));
}

/** 第 5 步之二：一条 resolve（Edge 等；苹果端点一律不发） */
export async function resolveOne(c: RoundCtx, S: Sender, x: Item): Promise<void> {
  const u = x.row.user_id;
  const pushedFor = x.row.pushed_for as number;
  const targets = S.alive(u, 'no-apple');
  if (!S.reserve(targets.length)) return;
  let mine: boolean;
  try {
    mine = await c.store.releasePushed(x.table, x.row.id, u, pushedFor);
  } catch {
    mine = false;
    c.log('release_failed');
  }
  if (!mine || targets.length === 0) {
    S.unreserve(targets.length);
    return;
  }
  let payload: Uint8Array<ArrayBuffer>;
  try {
    payload = c.buildPayload({ type: 'resolve', user_id: u, kind: kindOf(x.table), id: x.row.id, due_at: pushedFor, occurrenceKey: c.logic.occurrenceKey(kindOf(x.table), x.row, pushedFor, 'resolve') });
  } catch {
    return;
  }
  try {
    await S.sendTo(x, targets, payload, { ttl: 3600, urgency: 'normal' }, true);
  } catch {
    c.log('send_crashed');
  }
}

/** 轮末：每台设备写一次 */
export async function writeDeviceOutcomes(c: RoundCtx, stats: Sender['stats']): Promise<void> {
  const nowIso = new Date(c.now()).toISOString();
  for (const { dev, out } of stats.values()) {
    try {
      await c.store.deviceOutcome(dev, out, nowIso);
    } catch {
      c.log('device_write_failed');
    }
  }
}
