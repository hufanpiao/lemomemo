// 告警去重、恢复和发信限额（架构 6.1：同一件事 6 小时内只发一次，恢复后发一封“已恢复”；TC-B1-94 ②③④；K15 审查返工必改 1）。
//
// 规则：
// - 新出现的事发一封；还在、离上次发信满 6 小时再发一封“仍未恢复”（额度紧时排在最后）；标题变了（用量从提醒线升到紧急线）马上发一封；
// - **连续 2 轮正常**才发“已恢复”（时通时断不会一断一恢复地刷屏）；
// - 发出“已恢复”后这件事**冷却 6 小时**：期间出现 1 轮就消失的只记下、不发信；**连续出现 2 轮（30 分钟）及以上马上发一封“又出现了”**
//   （K15 复审必改：不然短暂恢复后真的长时间故障要等冷却过完才知道）；
// - **每天（UTC）最多发 20 封**（两个 cron 合计），其中 **3 封留给“监控连不上服务器”和“推送停了”**，其他告警只能用前 17 封；
//   其他告警到 17 封（或全部到 20 封）时只再发一封“今天告警已达上限”，之后只记下。Resend 每天 100 封的额度和登录验证码共用，监控不能把它耗光；
// - **先写 KV 再发信**：KV 写不进去（去重和限额都失效）就这一轮一封都不发，只记日志，避免每轮重发；
//   发信失败的事项退回原状态、退回额度，下一轮重试。
// 状态按 cron 分两个键（heartbeat、daily），发信额度另一个键两个 cron 共用。
// 数据库连不上时也要能去重，所以状态不能放 Supabase。

import type { Evaluation, Issue } from './rules.ts';

export const RESEND_AFTER_MS = 6 * 3600 * 1000;
export const COOLDOWN_MS = 6 * 3600 * 1000;
export const RECOVER_ROUNDS = 2;
export const DAILY_MAIL_CAP = 20;
/** 留给最要紧两类的额度：其他告警只能用前 DAILY_MAIL_CAP − RESERVED_FOR_PRIORITY 封 */
export const RESERVED_FOR_PRIORITY = 3;
/** 用保留额度的两类：监控连不上服务器、推送停了 */
export const PRIORITY_KEYS: readonly string[] = ['unreachable', 'hb:push-dispatch'];
/** 冷却期内连续出现几轮就马上发“又出现了” */
export const AGAIN_ROUNDS = 2;

export type Job = 'heartbeat' | 'daily';
export const stateKey = (job: Job) => `alert-state:${job}:v2`;
export const BUDGET_KEY = 'mail-budget:v1';

export interface IssueState {
  since: number;
  /** 上次发信时刻；还没发过（冷却中、额度用完、发信失败）是 null */
  lastSent: number | null;
  title: string;
  /** 负责人已经收到过这件事的告警（只有收到过的才发“已恢复”） */
  notified: boolean;
  /** 连续几轮没再出现 */
  okRounds: number;
  /** 连续几轮出现（冷却期内判“又出现了”用；旧状态没有这个字段按 0） */
  activeRounds?: number;
}

export interface AlertState {
  v: 2;
  issues: Record<string, IssueState>;
  /** key → 冷却到的时刻 */
  cooldown: Record<string, number>;
  /** 钩子出错告警：每个 UTC 小时一封，发失败的下一轮重试 */
  hook?: { hour: string; sent: boolean };
}

export interface Budget {
  day: string;
  sent: number;
  capNotice: boolean;
}

/** KV 里只用到 get、put 两个方法（测试用内存替身） */
export interface StateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export type MailKind = 'alert' | 'again' | 'still' | 'changed' | 'recovered' | 'hook' | 'cap';

export interface Mail {
  kind: MailKind;
  key: string;
  subject: string;
  text: string;
}

/** 发信：成功返回 true；失败返回 false（这件事下一轮再试，不记成已发） */
export type SendFn = (mail: Mail) => Promise<boolean>;
export type LogFn = (code: string) => void;

export const SUBJECT_PREFIX = '【柠檬记监控】';
export const HOOK_TITLE = '登录令牌钩子出错，被移除的设备可能还能刷新';

export function emptyState(): AlertState {
  return { v: 2, issues: {}, cooldown: {} };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // 坏了就当没有：最坏多发一次，不会漏
  }
}

export async function loadState(store: StateStore, job: Job): Promise<AlertState> {
  const v = parse(await store.get(stateKey(job)));
  if (typeof v === 'object' && v !== null && (v as { v?: unknown }).v === 2) {
    const s = v as AlertState;
    if (typeof s.issues === 'object' && s.issues !== null && typeof s.cooldown === 'object' && s.cooldown !== null) return s;
  }
  return emptyState();
}

export async function loadBudget(store: StateStore, now: number): Promise<Budget> {
  const v = parse(await store.get(BUDGET_KEY));
  const day = utcDay(now);
  if (typeof v === 'object' && v !== null && (v as Budget).day === day && typeof (v as Budget).sent === 'number') {
    return { day, sent: (v as Budget).sent, capNotice: (v as Budget).capNotice === true };
  }
  return { day, sent: 0, capNotice: false };
}

function stamp(ms: number): string {
  // 负责人在韩国（UTC+9），邮件里给首尔时间；同时写 UTC，方便对日志
  const kst = new Date(ms + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const utc = new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
  return `${kst}（首尔） / ${utc} UTC`;
}

const COOLDOWN_RULE =
  '“已恢复”之后 6 小时内：同一件事只出现 1 轮（15 分钟）就消失的只记下、不发信；连续出现 2 轮（30 分钟）及以上会马上发一封“又出现了”。';
const FOOTER = `同一件事 6 小时内只发一封；连续两轮正常才发“已恢复”。${COOLDOWN_RULE}每天最多 20 封（3 封留给“监控连不上服务器”和“推送停了”）。`;

function alertMail(kind: 'alert' | 'again' | 'still' | 'changed', issue: Issue, since: number, now: number): Mail {
  const head = kind === 'still' ? `仍未恢复：${issue.title}` : kind === 'again' ? `又出现了：${issue.title}` : issue.title;
  const lines = [...issue.lines, '', `开始发现：${stamp(since)}`, `这次检查：${stamp(now)}`, '', FOOTER];
  return { kind, key: issue.key, subject: `${SUBJECT_PREFIX}${head}`, text: lines.join('\n') };
}

function recoveredMail(key: string, st: IssueState, now: number): Mail {
  const lines = [`“${st.title}”已恢复（连续 ${RECOVER_ROUNDS} 轮正常）。`, '', `开始发现：${stamp(st.since)}`, `确认恢复：${stamp(now)}`, '', COOLDOWN_RULE];
  return { kind: 'recovered', key, subject: `${SUBJECT_PREFIX}已恢复：${st.title}`, text: lines.join('\n') };
}

function capMail(now: number): Mail {
  const lines = [
    `今天（UTC）监控邮件到了上限（一般告警 ${DAILY_MAIL_CAP - RESERVED_FOR_PRIORITY} 封，另 ${RESERVED_FOR_PRIORITY} 封只留给“监控连不上服务器”和“推送停了”）。`,
    '今天剩下的其他告警和“已恢复”只记在监控状态里、不再发信；没发出去的告警明天（UTC 0 点，首尔上午 9 点）重新计数后补发。',
    '请到 Supabase 控制台和 Cloudflare 看一下情况。',
    '',
    `这次检查：${stamp(now)}`,
  ];
  return { kind: 'cap', key: 'cap', subject: `${SUBJECT_PREFIX}今天告警已达上限`, text: lines.join('\n') };
}

function hookMail(hour: string): Mail {
  const lines = ['最近两档（15 分钟一档）的 hook-err:global: 计数大于 0。', `所在小时（UTC）：${hour}`, '同一小时只发一封。'];
  return { kind: 'hook', key: `hook:${hour}`, subject: `${SUBJECT_PREFIX}${HOOK_TITLE}`, text: lines.join('\n') };
}

const matches = (list: readonly string[] | undefined, key: string) =>
  (list ?? []).some((s) => key === s || (s.endsWith(':') && key.startsWith(s)));

interface Planned {
  mail: Mail;
  /** 发信失败时把状态和额度退回去 */
  revert: (s: AlertState, b: Budget) => void;
}

type Take = 'ok' | 'cap' | 'blocked';

function take(b: Budget, priority: boolean): Take {
  if (b.sent < (priority ? DAILY_MAIL_CAP : DAILY_MAIL_CAP - RESERVED_FOR_PRIORITY)) {
    b.sent += 1;
    return 'ok';
  }
  if (!b.capNotice) {
    b.capNotice = true;
    return 'cap';
  }
  return 'blocked';
}

/**
 * 纯计算：按这一轮的结论算出新状态、新额度和要发的信（不发信、不写 KV）。
 * 状态和额度原地修改的是副本；返回 changed 表示要不要写 KV。
 */
export function plan(
  prev: AlertState,
  prevBudget: Budget,
  evs: readonly Evaluation[],
  now: number,
): { state: AlertState; budget: Budget; planned: Planned[]; changed: boolean } {
  const state: AlertState = structuredClone(prev);
  const budget: Budget = { ...prevBudget };
  const planned: Planned[] = [];
  const before = JSON.stringify(prev) + JSON.stringify(prevBudget);

  // 过期的冷却清掉
  for (const [k, until] of Object.entries(state.cooldown)) if (until <= now) delete state.cooldown[k];

  /** 要发一封：按额度决定发不发；到上限时改发一封“已达上限”。返回这封是否排上了 */
  const queue = (mail: Mail, revert: Planned['revert']): boolean => {
    const t = take(budget, PRIORITY_KEYS.includes(mail.key));
    if (t === 'ok') {
      planned.push({
        mail,
        revert: (s, b) => {
          revert(s, b);
          b.sent -= 1;
        },
      });
      return true;
    }
    if (t === 'cap') {
      planned.push({
        mail: capMail(now),
        revert: (_s, b) => {
          b.capNotice = false;
        },
      });
    }
    return false;
  };

  // “仍未恢复”最后排：额度紧时先保证新告警、变化、“已恢复”、钩子告警发得出去（不然没发出去的新事永远排不上）
  const stills: Array<() => void> = [];

  for (const ev of evs) {
    const activeKeys = new Set<string>();
    for (const issue of ev.active) {
      activeKeys.add(issue.key);
      const st = state.issues[issue.key];
      const old = st ? { ...st } : undefined;
      if (!st || !st.notified) {
        const entry: IssueState = st
          ? { ...st, okRounds: 0, title: issue.title, activeRounds: (st.activeRounds ?? 0) + 1 }
          : { since: now, lastSent: null, title: issue.title, notified: false, okRounds: 0, activeRounds: 1 };
        state.issues[issue.key] = entry;
        // 冷却中：只出现 1 轮的只记下；连续出现 2 轮及以上马上发“又出现了”（K15 复审必改）
        const cooling = (state.cooldown[issue.key] ?? 0) > now;
        if (cooling && (entry.activeRounds ?? 0) < AGAIN_ROUNDS) continue;
        const mail = alertMail(cooling ? 'again' : 'alert', issue, entry.since, now);
        if (queue(mail, (s) => void (s.issues[issue.key] = { ...entry, notified: false, lastSent: null }))) {
          entry.notified = true;
          entry.lastSent = now;
        }
        continue;
      }
      const entry: IssueState = { ...st, okRounds: 0, activeRounds: (st.activeRounds ?? 0) + 1 };
      state.issues[issue.key] = entry;
      let kind: 'changed' | 'still' | null = null;
      if (st.title !== issue.title) kind = 'changed';
      else if (st.lastSent === null || now - st.lastSent >= RESEND_AFTER_MS) kind = 'still';
      if (!kind) continue;
      const mail = alertMail(kind, issue, st.since, now);
      const send = () => {
        if (queue(mail, (s) => void (s.issues[issue.key] = { ...(old as IssueState), okRounds: 0 }))) {
          entry.title = issue.title;
          entry.lastSent = now;
        }
      };
      if (kind === 'still') stills.push(send);
      else send();
    }

    for (const [key, st] of Object.entries(state.issues)) {
      if (activeKeys.has(key)) continue;
      if (matches(ev.drop, key)) {
        delete state.issues[key];
        continue;
      }
      if (!matches(ev.scopes, key)) continue; // 这一轮没查过（例如调不通时的心跳几项）：原样留着
      const entry: IssueState = { ...st, okRounds: st.okRounds + 1, activeRounds: 0 };
      state.issues[key] = entry;
      if (entry.okRounds < RECOVER_ROUNDS) continue;
      if (!entry.notified) {
        delete state.issues[key]; // 没发过告警的，悄悄删掉
        continue;
      }
      const old = { ...entry };
      if (queue(recoveredMail(key, entry, now), (s) => {
        s.issues[key] = old;
        delete s.cooldown[key];
      })) {
        delete state.issues[key];
        state.cooldown[key] = now + COOLDOWN_MS;
      }
    }

    if (ev.hookHour !== undefined && state.hook?.hour !== ev.hookHour) state.hook = { hour: ev.hookHour, sent: false };
  }

  if (state.hook && !state.hook.sent) {
    const hour = state.hook.hour;
    if (queue(hookMail(hour), (s) => void (s.hook = { hour, sent: false }))) state.hook = { hour, sent: true };
  }
  for (const send of stills) send();

  const changed = JSON.stringify(state) + JSON.stringify(budget) !== before;
  return { state, budget, planned, changed };
}

/**
 * 跑一轮：读状态 → 算 → **先写 KV** → 发信 → 有发失败的退回后再写一次。
 * KV 写失败：这一轮不发任何信（不然每轮都当新事重发），只记日志错误码。
 *
 * **每封信最多发一次，可能丢**（K15 复审低 1，有意取舍：宁可丢一封，也不能重复刷屏）：
 * - 写完 KV（已记成“发过”）以后、发信之前或发信途中 Worker 被中断（超时、重新部署）：这封不会再发；
 * - 发信失败后退回状态的那次 KV 写入也失败：KV 里仍记着“发过”，这封不会重试；
 * 两种情况下这件事如果一直没好，满 6 小时会发“仍未恢复”，不会一直不知道；短暂的事可能整件漏掉。
 */
export async function runAlerts(store: StateStore, job: Job, evs: readonly Evaluation[], now: number, send: SendFn, log: LogFn): Promise<Mail[]> {
  const prev = await loadState(store, job);
  const prevBudget = await loadBudget(store, now);
  const { state, budget, planned, changed } = plan(prev, prevBudget, evs, now);
  if (!changed) return [];
  try {
    await store.put(stateKey(job), JSON.stringify(state));
    if (planned.length > 0) await store.put(BUDGET_KEY, JSON.stringify(budget));
  } catch {
    log('kv_write_failed');
    return [];
  }
  const sent: Mail[] = [];
  let failed = false;
  for (const p of planned) {
    if (await send(p.mail)) sent.push(p.mail);
    else {
      failed = true;
      p.revert(state, budget);
    }
  }
  if (failed) {
    log('mail_send_failed');
    try {
      await store.put(stateKey(job), JSON.stringify(state));
      await store.put(BUDGET_KEY, JSON.stringify(budget));
    } catch {
      log('kv_write_failed');
    }
  }
  return sent;
}
