// ai-parse、ai-voice 共用的门（架构第 6 节两行、第 7 节“正式的 ai-parse 也调它”、5.11 第 4、5 点、15.5；B3 任务单 BE-4、S12）。
// 顺序（每一步不过就直接回，后面的都不做）：
//   ① aiAllowed：没同意或关了 AI → {consent_required}，不调 Gemini、不扣次数（TC-B3-25）；读不出 → 503 try_later；
//   ② featureOn 算出这个人能用的类型：一种都没有 → {fallback, feature_off}（读 profiles 失败按 beta 为空算，由 index.ts 注入的 features 负责，TC-B3-26）；
//   ③ app_config.ai 读出模型、每人每天、全项目每天；模型没配、密钥没配 → {fallback, error}，不扣次数；
//   ④ 每人每分钟 6 次（ai-rate:<user_id>:<UTC 分钟>，private.take_rate，窗口 60 秒）→ 超了 429 rate_limited；
//   ⑤ ai_state.exhausted_until 还没过（谷歌额度用完：每天的到太平洋午夜，每分钟的只到几十秒后，见 exhaustedUntilFor）→ 不扣次数；
//      剩下不到 5 分钟（每分钟的停用）回 {fallback, error}，否则 {fallback, quota}（holdKind；客户端见到 quota 才记“今天用完”）；
//   ⑥ 预扣（takeDaily）：每人每天 per_user_daily 次（ai:<user_id>:<太平洋日期>），用完 → {quota_out, quota_left: 0}；
//      全项目每天 global_daily 次（ai:global:<太平洋日期>，没配按 0），用完 → 退回刚扣的个人那一次、{fallback, quota}；
//   放行后由调用方调 Gemini；失败时 settle 退回两边各 1 次、quota 按每天 / 每分钟写 exhausted_until、invalid 只把 invalid_reasons 写 logs；
//   本次撞了每分钟限额的，给客户端的 reason 也换成 error（clientReason）。
// “每天 50 次”的日期按太平洋时间（和谷歌重置时刻一致，R-187）。纯逻辑：依赖全部注入，不 import _shared/gen/、npm 包。
import type { AiConfig } from './router.ts';
import type { AIProvider, QuotaKind } from './provider.ts';
import type { AiKindLike, InvalidReasonLike } from './parse-core.ts';

export const PER_MINUTE_LIMIT = 6;
export const PACIFIC = 'America/Los_Angeles';

export interface QuotaStore {
  /** 计一次：没超过 limit 返回计数以后的值；超了返回 null（这一次已撤回，不留在计数里） */
  take(key: string, limit: number): Promise<number | null>;
  /** 退回 1 次（不会减到 0 以下） */
  refund(key: string): Promise<void>;
}

export interface GateDeps {
  consent(userId: string): Promise<boolean>;
  features(userId: string, appVersion: string): Promise<AiKindLike[]>;
  config(): Promise<AiConfig>;
  provider(cfg: AiConfig): AIProvider | null;
  /** private.take_rate(key, limit, window_s) */
  rate(key: string, limit: number, windowS: number): Promise<boolean>;
  quota: QuotaStore;
  /** private.ai_state 里 gemini 那一行的 exhausted_until（毫秒），没有为 null */
  exhaustedUntil(): Promise<number | null>;
  markExhausted(untilMs: number): Promise<void>;
  /** 只写 invalid_reasons（不写原文、issues） */
  logInvalid(userId: string, src: string, reasons: InvalidReasonLike[]): Promise<void>;
  now(): number;
  log(code: string): void;
}

/** hold：第 ⑤ 步拦下时停的是哪一种（holdKind；只给服务器日志用，不回给客户端） */
export type GateStop = { stop: true; status: number; body: Record<string, unknown>; hold?: 'minute' | 'day' };
export type GateGo = {
  stop: false;
  features: AiKindLike[];
  provider: AIProvider;
  /** 扣完以后还剩几次 */
  quotaLeft: number;
  userKey: string;
  globalKey: string;
};

/** 某时刻在太平洋时间是哪一天（YYYY-MM-DD） */
export function pacificDate(ms: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** 太平洋时间的下一个午夜（毫秒）：ai_state.exhausted_until 写这个（第 7 节） */
export function nextPacificMidnight(ms: number): number {
  const today = pacificDate(ms);
  // 往后按小时找第一个日期变了的整点，再在那一小时里按分钟找（夏令时切换在凌晨 2 点，不影响午夜）
  let t = Math.floor(ms / 3_600_000) * 3_600_000;
  while (pacificDate(t) === today) t += 3_600_000;
  let lo = t - 3_600_000;
  while (t - lo > 60_000) {
    const mid = lo + Math.floor((t - lo) / 120_000) * 60_000;
    if (pacificDate(mid) === today) lo = mid;
    else t = mid;
  }
  return t;
}

/** 撞了每分钟限额、谷歌没给 retryDelay 时停多久 */
export const MINUTE_HOLD_DEFAULT_MS = 60_000;
/** 撞了每分钟限额最多停多久（retryDelay 给得再长也不超过） */
export const MINUTE_HOLD_MAX_MS = 5 * 60_000;
/** 撞了每分钟限额最少停多久（retryDelay 给 "0s" 时也等 1 秒，不立刻再撞） */
export const MINUTE_HOLD_MIN_MS = 1_000;

/**
 * 撞了每分钟限额等多久（毫秒）：谷歌给了 retryDelay 就用它，没给 60 秒；夹在 1 秒到 5 分钟之间。
 * 服务器写 exhausted_until（exhaustedUntilFor）和评测重试同一句前的等待（tests/ai/run-core.ts）共用这一处。
 */
export function minuteWaitMs(retryMs: number | null | undefined): number {
  const ms = typeof retryMs === 'number' && Number.isFinite(retryMs) ? retryMs : MINUTE_HOLD_DEFAULT_MS;
  return Math.min(Math.max(ms, MINUTE_HOLD_MIN_MS), MINUTE_HOLD_MAX_MS);
}

/**
 * 额度用完后 exhausted_until 写到哪（11-13 ai-eval #2：每分钟限额撞一下就停一整天的根因）：
 * minute → now + minuteWaitMs(retryDelay)；day、unknown、没带类型 → 太平洋时间下一个午夜（和原来一样，保守）。
 * ai-parse、ai-voice、claude-intake、ai-classify（都经 settleFailure）共用这一处。
 */
export function exhaustedUntilFor(now: number, q: { quotaKind?: QuotaKind | undefined; retryMs?: number | null | undefined }): number {
  return q.quotaKind === 'minute' ? now + minuteWaitMs(q.retryMs) : nextPacificMidnight(now);
}

/**
 * 门第 ⑤ 步拦下时，停的是哪一种：剩下不到 MINUTE_HOLD_MAX_MS（5 分钟）的按 minute，否则 day。
 * 库里只存了 exhausted_until，没存类型，只能按剩多久判：每天用完、离太平洋午夜不到 5 分钟的也会判成 minute（无害：只是客户端这次不锁到午夜，
 * 下一次照样被门拦下回 error，过了午夜就恢复）。
 */
export const holdKind = (untilMs: number, now: number): 'minute' | 'day' => (untilMs - now <= MINUTE_HOLD_MAX_MS ? 'minute' : 'day');

/**
 * 给客户端的失败原因（11-13 评审：客户端看到 reason quota 就记“今天用完”、本机 AI 关到午夜）：
 * 每分钟限额回 error（客户端按“这次 AI 没成”走本机规则，不记 quota_out），其余照原样。服务器日志照旧用 aiFailCode 记 ai_quota kind=minute。
 */
export const clientReason = <R extends string>(f: { reason: R; quotaKind?: QuotaKind | undefined }): R | 'error' =>
  f.reason === 'quota' && f.quotaKind === 'minute' ? 'error' : f.reason;

/** 计数键（附录 A 三段写法；第三段不准有冒号） */
export const userQuotaKey = (userId: string, ms: number) => `ai:${userId}:${pacificDate(ms)}`;
export const globalQuotaKey = (ms: number) => `ai:global:${pacificDate(ms)}`;
export const minuteKey = (userId: string, ms: number) => `ai-rate:${userId}:${new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, '')}`;

const stop = (status: number, body: Record<string, unknown>): GateStop => ({ stop: true, status, body });

/**
 * 预扣每人每天、全项目每天各 1 次（aiGate 第 ⑥ 步和 ai-classify 共用）：
 * user：个人用完（没扣上）；global：全项目用完（已退回个人那一次）；
 * failed：计数出错（userTaken：个人那一下已经扣上、还没退。aiGate 不退，ai-classify 退回个人的；全项目那一下扣没扣上不知道，都不退，宁可多算）。
 * 不抛错。
 */
export type DailyTake = { ok: true; used: number } | { ok: false; out: 'user' | 'global' } | { ok: false; out: 'failed'; userTaken: boolean };
export async function takeDaily(
  quota: QuotaStore, cfg: Pick<AiConfig, 'per_user_daily' | 'global_daily'>, userKey: string, globalKey: string,
): Promise<DailyTake> {
  let userTaken = false;
  try {
    const used = await quota.take(userKey, cfg.per_user_daily);
    if (used === null) return { ok: false, out: 'user' };
    userTaken = true;
    if ((await quota.take(globalKey, cfg.global_daily ?? 0)) !== null) return { ok: true, used };
    userTaken = false;   // 下面这次退回出错时，调用方不再退第二次
    await quota.refund(userKey);
    return { ok: false, out: 'global' };
  } catch {
    return { ok: false, out: 'failed', userTaken };
  }
}

export async function aiGate(deps: GateDeps, userId: string, appVersion: string): Promise<GateStop | GateGo> {
  const now = deps.now();
  // ①
  let allowed: boolean;
  try {
    allowed = await deps.consent(userId);
  } catch {
    deps.log('consent_read_failed');
    return stop(503, { error: 'try_later' });
  }
  if (!allowed) return stop(200, { consent_required: true });
  // ②
  const features = await deps.features(userId, appVersion);
  if (features.length === 0) return stop(200, { fallback: true, reason: 'feature_off' });
  // ③
  let cfg: AiConfig;
  try {
    cfg = await deps.config();
  } catch {
    deps.log('config_read_failed');
    return stop(200, { fallback: true, reason: 'error' });
  }
  const provider = deps.provider(cfg);
  if (!provider) {
    deps.log('ai_not_configured');
    return stop(200, { fallback: true, reason: 'error' });
  }
  try {
    // ④
    if (!(await deps.rate(minuteKey(userId, now), PER_MINUTE_LIMIT, 60))) return stop(429, { error: 'rate_limited' });
    // ⑤ 每分钟的停用回 error：客户端走本机规则、不记“今天用完”（见 holdKind、clientReason）
    const until = await deps.exhaustedUntil();
    if (until !== null && until > now) {
      const hold = holdKind(until, now);
      return { ...stop(200, { fallback: true, reason: hold === 'minute' ? 'error' : 'quota' }), hold };
    }
  } catch {
    return storeFailed(deps);
  }
  // ⑥
  const userKey = userQuotaKey(userId, now);
  const globalKey = globalQuotaKey(now);
  const t = await takeDaily(deps.quota, cfg, userKey, globalKey);
  if (t.ok) return { stop: false, features, provider, quotaLeft: Math.max(0, cfg.per_user_daily - t.used), userKey, globalKey };
  if (t.out === 'user') return stop(200, { quota_out: true, quota_left: 0 });
  if (t.out === 'global') {
    deps.log('global_quota_out');
    return stop(200, { fallback: true, reason: 'quota' });
  }
  return storeFailed(deps);
}

function storeFailed(deps: Pick<GateDeps, 'log'>): GateStop {
  deps.log('store_failed');
  return stop(503, { error: 'try_later' });
}

// 失败退回额度是负责人 R-356 的决定；已知风险是可被刷，见安全审 M1
/** settleFailure 要的依赖：ai-classify 没有 logInvalid（它的失败不带 invalid_reasons） */
export type SettleDeps = Pick<GateDeps, 'quota' | 'markExhausted' | 'now' | 'log'> & { logInvalid?: GateDeps['logInvalid'] };

/**
 * AI 调完没成功：退回预扣的两次；quota 按类型写 exhausted_until（exhaustedUntilFor）；invalid 只把原因写 logs。出错只记 settle_failed，不影响给客户端的回答。
 * ai-parse、ai-voice、claude-intake（经 aiGate 拿到 go）和 ai-classify（自己按人拼两个键）共用。
 */
export async function settleFailure(
  deps: SettleDeps, go: Pick<GateGo, 'userKey' | 'globalKey'>, userId: string, src: string,
  fail: { reason: 'quota' | 'timeout' | 'invalid' | 'error'; invalid_reasons?: InvalidReasonLike[]; quotaKind?: QuotaKind; retryMs?: number | null },
): Promise<void> {
  const jobs: Promise<unknown>[] = [deps.quota.refund(go.userKey), deps.quota.refund(go.globalKey)];
  if (fail.reason === 'quota') jobs.push(deps.markExhausted(exhaustedUntilFor(deps.now(), fail)));
  if (fail.reason === 'invalid' && fail.invalid_reasons?.length && deps.logInvalid) jobs.push(deps.logInvalid(userId, src, fail.invalid_reasons));
  const r = await Promise.allSettled(jobs);
  if (r.some((x) => x.status === 'rejected')) deps.log('settle_failed');
}
