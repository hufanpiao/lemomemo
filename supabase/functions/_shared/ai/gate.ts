// ai-parse、ai-voice 共用的门（架构第 6 节两行、第 7 节“正式的 ai-parse 也调它”、5.11 第 4、5 点、15.5；B3 任务单 BE-4、S12）。
// 顺序（每一步不过就直接回，后面的都不做）：
//   ① aiAllowed：没同意或关了 AI → {consent_required}，不调 Gemini、不扣次数（TC-B3-25）；读不出 → 503 try_later；
//   ② featureOn 算出这个人能用的类型：一种都没有 → {fallback, feature_off}（读 profiles 失败按 beta 为空算，由 index.ts 注入的 features 负责，TC-B3-26）；
//   ③ app_config.ai 读出模型、每人每天、全项目每天；模型没配、密钥没配 → {fallback, error}，不扣次数；读出错时先看第 ③' 步，没有自己的密钥才回 {fallback, error}；
//   ③' 这个人在“我的 AI”里用着自己的密钥、这项归它做（R-494，deps.own）：用他那家，只过第 ④ 步，跳过 ⑤⑥（不占每天 50 次、不占全项目），
//      失败也不退、不写 exhausted_until（settleFailure 看 go.own）；读出错按没有，照常用柠檬记的；
//      他那家用不了（负责人 11-23：欠费、额度满 402/429，密钥失效 401/403、Gemini API_KEY_INVALID）→ 这一次自动改用柠檬记的（ownFirst）：
//      照第 ⑤⑥ 步查停用、扣每天 50 次和全项目各 1 次，go.own 改成 false（之后失败照常退回、写停用），并记 deps.ownMark（“我的 AI”页提示“你的密钥用不了，这次用了柠檬记的 AI”）；
//      柠檬记的也用不了（没配好、停用中、次数用完）就回他那家的失败，额度类改报 error（errName own_quota：不是柠檬记的额度，客户端不记“今天用完”）；
//   ④ 每人每分钟 6 次（ai-rate:<user_id>:<UTC 分钟>，private.take_rate，窗口 60 秒）→ 超了 429 rate_limited；管理员不限（负责人 11-22“每分钟也放开”）；
//   ⑤ 这一家（服务商名，ai_state 按服务商分行）的 exhausted_until 还没过（额度用完：每天的到太平洋午夜，每分钟的只到几十秒后，见 exhaustedUntilFor）→ 不扣次数；
//      剩下不到 5 分钟（每分钟的停用）回 {fallback, error}，否则 {fallback, quota}（holdKind；客户端见到 quota 才记“今天用完”）；
//   ⑥ 预扣（takeDaily）：每人每天 per_user_daily 次（ai:<user_id>:<太平洋日期>），用完 → {quota_out, quota_left: 0}；
//      管理员（private.admins 里的人，负责人 11-22“上面的额度管理员是没有限制的”）个人这一项不设上限（dailyCap），照样计数好让“今天 N 次”有数，
//      永远不回 quota_out，quota_left 按满额回（客户端不会把本机额度记成 0）；读 admins 出错按不是管理员算（宁可多拦）；
//      全项目每天 global_daily 次（ai:global:<太平洋日期>，没配按 0），用完 → 退回刚扣的个人那一次、{fallback, quota}；
//      全项目每天是成本保护（防服务商费用失控），管理员照样算在里面、用完照样被拦；
//   管理员只放开两项：第 ④ 步每人每分钟、第 ⑥ 步个人每天。是不是管理员在第 ④ 步之前读一次（adminOf）；
//   放行后由调用方调服务商；失败时 settle 退回两边各 1 次、quota 按每天 / 每分钟写这家的 exhausted_until、invalid 只把 invalid_reasons 写 logs；
//   本次撞了每分钟限额的，给客户端的 reason 也换成 error（clientReason）。
// “每天 50 次”的日期按太平洋时间（和谷歌重置时刻一致，R-187）。纯逻辑：依赖全部注入，不 import _shared/gen/、npm 包。
import { utcMinuteKey } from '../rate-key.ts';
import { PER_USER_DAILY_DEFAULT, type AiConfig } from './router.ts';
import type { AiRequest, AiResult, AIProvider, ChatProvider, ChatRequest, ChatResult, QuotaKind } from './provider.ts';
import type { AiKindLike, InvalidReasonLike } from './parse-core.ts';

/** 门要的服务商最少有名字和模型名（AIProvider、ChatProvider 都是） */
export interface Named {
  readonly name: string;
  readonly model: string;
}

export const PER_MINUTE_LIMIT = 6;
export const PACIFIC = 'America/Los_Angeles';

export interface QuotaStore {
  /** 计一次：没超过 limit 返回计数以后的值；超了返回 null（这一次已撤回，不留在计数里） */
  take(key: string, limit: number): Promise<number | null>;
  /** 退回 1 次（不会减到 0 以下） */
  refund(key: string): Promise<void>;
}

/** P：门第 ③ 步要的服务商类型（默认 AIProvider；ai-chat 传 ChatProvider，R-492，同一个门不另写一套） */
export interface GateDeps<P extends Named = AIProvider> {
  consent(userId: string): Promise<boolean>;
  /** 在不在 private.admins 里（_shared/user-reads.ts 的 isAdmin，和 invite-admin 同一个查法）；出错抛错，门按不是管理员算 */
  isAdmin(userId: string): Promise<boolean>;
  features(userId: string, appVersion: string): Promise<AiKindLike[]>;
  config(): Promise<AiConfig>;
  /** 按用途选的服务商（R-494：密钥要先读 Vault，所以可以是异步的） */
  provider(cfg: AiConfig): P | null | Promise<P | null>;
  /**
   * 这个人自己的密钥（R-494“我的 AI”；负责人 11-22“用自己密钥的不占每天 50 次”）：设了、正在用、这项归它做时回服务商，否则 null；读出错抛错（门按没有算）。
   * 不给（ai-media 这类不归自己密钥的）就不查
   */
  own?(userId: string): Promise<P | null>;
  /** 自己的密钥用不了、这次改用了柠檬记的（ownFirst）：记下时刻和原因，“我的 AI”页提示用；出错只记日志 */
  ownMark?(userId: string, code: OwnDead): Promise<void>;
  /** private.take_rate(key, limit, window_s) */
  rate(key: string, limit: number, windowS: number): Promise<boolean>;
  quota: QuotaStore;
  /** private.ai_state 里这家服务商（适配器 name）那一行的 exhausted_until（毫秒），没有为 null */
  exhaustedUntil(provider: string): Promise<number | null>;
  markExhausted(untilMs: number, provider: string): Promise<void>;
  /** 只写 invalid_reasons（不写原文、issues） */
  logInvalid(userId: string, src: string, reasons: InvalidReasonLike[]): Promise<void>;
  now(): number;
  log(code: string): void;
}

/** hold：第 ⑤ 步拦下时停的是哪一种（holdKind；只给服务器日志用，不回给客户端） */
export type GateStop = { stop: true; status: number; body: Record<string, unknown>; hold?: 'minute' | 'day' };
export type GateGo<P extends Named = AIProvider> = {
  stop: false;
  features: AiKindLike[];
  provider: P;
  /** 扣完以后还剩几次（管理员按满额 per_user_daily 回） */
  quotaLeft: number;
  /** 管理员：个人每天不设上限（dailyCap） */
  unlimited: boolean;
  /**
   * 用的是这个人自己的密钥（R-494）：没扣每人每天、全项目每天，失败也不退、不写 exhausted_until（settleFailure 看它）。
   * 他那家用不了、这次自动改用了柠檬记的（ownFirst）以后变成 false
   */
  own: boolean;
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
export const minuteKey = (userId: string, ms: number) => utcMinuteKey('ai-rate', userId, ms);

const stop = (status: number, body: Record<string, unknown>): GateStop => ({ stop: true, status, body });

/** 管理员个人每天的上限：int4 最大值（private.ai_quota_take 的 p_limit 是 int），等于不设上限，计数照常 */
export const ADMIN_DAILY_CAP = 2_147_483_647;

/** 这个人每天的个人上限：管理员不设上限；全项目每天 global_daily 不看是不是管理员（成本保护） */
export const dailyCap = (cfg: Pick<AiConfig, 'per_user_daily'>, admin: boolean): number => (admin ? ADMIN_DAILY_CAP : cfg.per_user_daily);

/** 是不是管理员；读出错按不是（记 admin_read_failed，宁可按普通人拦，不放开个人上限） */
export async function adminOf(deps: { isAdmin(userId: string): Promise<boolean>; log(code: string): void }, userId: string): Promise<boolean> {
  try {
    return await deps.isAdmin(userId);
  } catch {
    deps.log('admin_read_failed');
    return false;
  }
}

/**
 * 预扣每人每天、全项目每天各 1 次（aiGate 第 ⑥ 步和 ai-classify 共用；userCap 用 dailyCap 算，管理员不设上限）：
 * user：个人用完（没扣上）；global：全项目用完（已退回个人那一次）；
 * failed：计数出错（userTaken：个人那一下已经扣上、还没退。aiGate、ai-classify 都退回个人的（R-356 失败退回额度）；全项目那一下扣没扣上不知道，都不退，宁可多算）。
 * 不抛错。
 */
export type DailyTake = { ok: true; used: number } | { ok: false; out: 'user' | 'global' } | { ok: false; out: 'failed'; userTaken: boolean };
export async function takeDaily(
  quota: QuotaStore, cfg: Pick<AiConfig, 'global_daily'>, userCap: number, userKey: string, globalKey: string,
): Promise<DailyTake> {
  let userTaken = false;
  try {
    const used = await quota.take(userKey, userCap);
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

/** 柠檬记的这家：第 ⑤ 步停用、第 ⑥ 步预扣（aiGate 和自己的密钥用不了时改用柠檬记的 ownFirst 共用）。过了回扣完还剩几次 */
async function lemoTake<P extends Named>(
  deps: GateDeps<P>, cfg: AiConfig, admin: boolean, provider: P, userKey: string, globalKey: string, now: number,
): Promise<GateStop | { quotaLeft: number }> {
  try {
    // ⑤ 每分钟的停用回 error：客户端走本机规则、不记“今天用完”（见 holdKind、clientReason）
    const until = await deps.exhaustedUntil(provider.name);
    if (until !== null && until > now) {
      const hold = holdKind(until, now);
      return { ...stop(200, { fallback: true, reason: hold === 'minute' ? 'error' : 'quota' }), hold };
    }
  } catch {
    return storeFailed(deps);
  }
  // ⑥
  const t = await takeDaily(deps.quota, cfg, dailyCap(cfg, admin), userKey, globalKey);
  if (t.ok) return { quotaLeft: admin ? cfg.per_user_daily : Math.max(0, cfg.per_user_daily - t.used) };
  if (t.out === 'user') return stop(200, { quota_out: true, quota_left: 0 });
  if (t.out === 'global') {
    deps.log('global_quota_out');
    return stop(200, { fallback: true, reason: 'quota' });
  }
  // 计数出错：个人那一下扣上了就退回（和 ai-classify 一致；退回也出错只记 settle_failed，照样回 503）
  if (t.out === 'failed' && t.userTaken) await deps.quota.refund(userKey).catch(() => deps.log('settle_failed'));
  return storeFailed(deps);
}

export async function aiGate<P extends Named = AIProvider>(deps: GateDeps<P>, userId: string, appVersion: string): Promise<GateStop | GateGo<P>> {
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
  // ③ 读出错先不回：用着自己的密钥的照样能用（第 ③' 步）
  let cfg: AiConfig | null = null;
  try {
    cfg = await deps.config();
  } catch {
    deps.log('config_read_failed');
  }
  // ③' 自己的密钥（R-494）：正在用、这项归它做 → 只过每分钟限速（第 ④ 步），不看停用、不扣每天的两项；读出错按没有（照常用柠檬记的）
  let mine: P | null = null;
  if (deps.own) {
    try {
      mine = await deps.own(userId);
    } catch {
      deps.log('own_read_failed');
    }
  }
  const provider = mine ?? (cfg ? await deps.provider(cfg) : null);
  if (!provider) {
    if (cfg) deps.log('ai_not_configured');
    return stop(200, { fallback: true, reason: 'error' });
  }
  const admin = await adminOf(deps, userId);
  try {
    // ④ 管理员不限（第 ⑥ 步的全项目每天照算）
    if (!admin && !(await deps.rate(minuteKey(userId, now), PER_MINUTE_LIMIT, 60))) return stop(429, { error: 'rate_limited' });
  } catch {
    return storeFailed(deps);
  }
  const userKey = userQuotaKey(userId, now);
  const globalKey = globalQuotaKey(now);
  if (mine) {
    deps.log('own_key');
    const go: GateGo<P> = { stop: false, features, provider: mine, quotaLeft: cfg?.per_user_daily ?? PER_USER_DAILY_DEFAULT, unlimited: admin, own: true, userKey, globalKey };
    // 他那家用不了：这一次改用柠檬记的（见文件头 ③'）。柠檬记的过不了第 ⑤⑥ 步就不换（回 null）
    go.provider = ownFirst(mine, async (dead) => {
      if (!cfg) return null;
      const lemo = await Promise.resolve(deps.provider(cfg)).catch(() => null);
      if (!lemo) return null;
      const took = await lemoTake(deps, cfg, admin, lemo, userKey, globalKey, now);
      if ('stop' in took) return null;
      go.own = false;
      go.quotaLeft = took.quotaLeft;
      deps.log(`own_fallback ${dead}`);
      await deps.ownMark?.(userId, dead).catch(() => deps.log('own_mark_failed'));
      return lemo;
    });
    return go;
  }
  // cfg 一定在：没有自己的密钥时 provider 只能来自 deps.provider(cfg)
  if (!cfg) return stop(200, { fallback: true, reason: 'error' });
  const took = await lemoTake(deps, cfg, admin, provider, userKey, globalKey, now);
  if ('stop' in took) return took;
  return { stop: false, features, provider, quotaLeft: took.quotaLeft, unlimited: admin, own: false, userKey, globalKey };
}

/** 自己的密钥为什么用不了：quota 欠费或额度满（402、429、适配器报的 quota），auth 密钥失效（401、403、Gemini 的 API_KEY_INVALID） */
export type OwnDead = 'quota' | 'auth';
type Res = { ok: boolean; reason?: string; status?: number; errName?: string };
export function ownDeadOf(r: Res): OwnDead | null {
  if (r.ok) return null;
  if (r.reason === 'quota' || r.status === 402) return 'quota';
  if (r.status === 401 || r.status === 403 || r.errName === 'API_KEY_INVALID') return 'auth';
  return null;
}

/** 自己那家的额度失败不是柠檬记的：改报 error（errName own_quota），客户端不会当成“今天 50 次用完” */
const ownFix = <R extends Res>(r: R): R => (!r.ok && r.reason === 'quota' ? ({ ok: false, reason: 'error', errName: 'own_quota' } as unknown as R) : r);

/**
 * 先用自己的密钥；第一次碰到“用不了”（ownDeadOf）就问 toLemo 要柠檬记的那家，拿到了这一次和以后都用它（同一个请求里只换一次、换了不回头）。
 * 拿不到就回自己那家的失败（ownFix）。name、model、caps 跟着现在用的那家走（settleFailure 按 name 写停用、ai-classify 记 model）。
 * 对话一轮中途（带着 resume，第 2 次往返起）才用不了的：**不换**，直接回自己那家的失败（ownFix），不问 toLemo、不扣柠檬记的次数。
 * 理由：resume 里的 turn 是自己那家产生的，别家不认（必然 bad_turn），换过去只会白扣一次再失败；丢掉 resume 从头来又得重跑这一轮已经做过的查库、联网（联网还要再扣），
 * 不如这一轮按失败收尾，下一轮第一次往返时再换（那时没有 resume）。
 */
export function ownFirst<P extends Named>(mine: P, toLemo: (dead: OwnDead) => Promise<P | null>): P {
  let cur: P = mine;
  let tried = false;
  const call = async <R extends Res>(f: (p: P) => Promise<R>, canSwitch = true): Promise<R> => {
    const p = cur;
    const r = await f(p);
    if (p !== mine) return r;
    const dead = tried || !canSwitch ? null : ownDeadOf(r);
    if (dead === null) return ownFix(r);
    tried = true;
    const lemo = await toLemo(dead);
    if (!lemo) return ownFix(r);
    cur = lemo;
    return f(lemo);
  };
  const m = mine as unknown as Partial<AIProvider & ChatProvider>;
  const out = {
    get name(): string {
      return cur.name;
    },
    get model(): string {
      return cur.model;
    },
    get caps(): unknown {
      return (cur as unknown as Partial<ChatProvider>).caps;
    },
    ...(typeof m.generate === 'function' ? { generate: (req: AiRequest): Promise<AiResult> => call((p) => (p as unknown as AIProvider).generate(req)) } : {}),
    ...(typeof m.chat === 'function' ? { chat: (req: ChatRequest): Promise<ChatResult> => call((p) => (p as unknown as ChatProvider).chat(req), req.resume === undefined) } : {}),
  };
  return out as unknown as P;
}

function storeFailed(deps: { log(code: string): void }): GateStop {
  deps.log('store_failed');
  return stop(503, { error: 'try_later' });
}

// 失败退回额度是负责人 R-356 的决定；已知风险是可被刷，见安全审 M1
/** settleFailure 要的依赖：ai-classify 没有 logInvalid（它的失败不带 invalid_reasons） */
export type SettleDeps = Pick<GateDeps, 'quota' | 'markExhausted' | 'now' | 'log'> & { logInvalid?: GateDeps['logInvalid'] };

/**
 * AI 调完没成功：退回预扣的两次；quota 按类型写这家（go.provider.name）的 exhausted_until（exhaustedUntilFor）；invalid 只把原因写 logs。
 * 出错只记 settle_failed，不影响给客户端的回答。ai-parse、ai-voice、claude-intake、ai-chat、ai-summarize（经 aiGate 拿到 go）和 ai-classify（自己按人拼两个键）共用。
 * refund false：不退两边的预扣（ai-chat 一轮里已经多次往返或联网过才失败的：前面的调用真用掉了，退回就能白用，第 2 段独立评审第 1 条），其余照旧。
 */
export async function settleFailure(
  deps: SettleDeps, go: { userKey: string; globalKey: string; provider: Named; own?: boolean }, userId: string, src: string,
  fail: { reason: 'quota' | 'timeout' | 'invalid' | 'error'; invalid_reasons?: InvalidReasonLike[]; quotaKind?: QuotaKind; retryMs?: number | null },
  refund = true,
): Promise<void> {
  // 自己的密钥（R-494）：本来就没扣，不退；他那家的额度用完也不是柠檬记的，不写 exhausted_until
  const jobs: Promise<unknown>[] = go.own || !refund ? [] : [deps.quota.refund(go.userKey), deps.quota.refund(go.globalKey)];
  if (fail.reason === 'quota' && !go.own) jobs.push(deps.markExhausted(exhaustedUntilFor(deps.now(), fail), go.provider.name));
  if (fail.reason === 'invalid' && fail.invalid_reasons?.length && deps.logInvalid) jobs.push(deps.logInvalid(userId, src, fail.invalid_reasons));
  const r = await Promise.allSettled(jobs);
  if (r.some((x) => x.status === 'rejected')) deps.log('settle_failed');
}
