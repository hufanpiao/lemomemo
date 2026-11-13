// ai-parse、ai-voice、claude-intake 的计数和 ai_state 读写（service role 的 supabase-js；B3 任务单 BE-4）。
// private.take_rate（每分钟限流等，原子计一次）、private.ai_quota_take / ai_quota_refund（AI 每天额度，迁移 20261107100000）、
// private.ai_state（service_role 有 select、insert、update）、public.logs。
//
// 额度按太平洋日期计（键 ai:<user_id>:<太平洋日期>）。预扣、退回都在库里一个函数里做完（架构审第九节第 8 条）：
//   先对这个键取 advisory 锁，再把这个键所有窗口行合计（一个太平洋日期偶尔跨两个 take_rate 窗口），没到上限才 +1；
//   退回从最新的、计数大于 0 的窗口行减 1。设置里的 my_ai_usage() 按同一口径合计（TC-B3-29）。
// 出错一律抛错（调用方回 503 或记 settle_failed），日志只记错误码。
import type { QuotaStore } from './gate.ts';

export const QUOTA_WINDOW_S = 2_678_400;

type Res = { data: unknown; error: unknown };
interface Q extends PromiseLike<Res> {
  select(cols: string): Q;
  eq(col: string, v: string | number): Q;
  or(filters: string): Q;
  order(col: string, o: { ascending: boolean }): Q;
  limit(n: number): Q;
  update(v: Record<string, unknown>): Q;
  upsert(v: Record<string, unknown>, o?: Record<string, unknown>): Q;
  insert(v: Record<string, unknown>): Q;
  maybeSingle(): PromiseLike<Res>;
}
interface Schema {
  from(t: string): unknown;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res>;
}
/** service role 的 supabase-js 客户端（只要求这几个方法；from 写成 unknown，原因同 _shared/consent.ts 的 ConsentAdmin） */
export interface StoreAdmin {
  from(t: string): unknown;
  schema(s: 'private'): unknown;
}

const must = (r: Res, what: string): unknown => {
  if (r.error) throw new Error(`db:${what}`);
  return r.data;
};

function priv(admin: StoreAdmin): Schema {
  return admin.schema('private') as Schema;
}
const tbl = (s: { from(t: string): unknown }, t: string): Q => s.from(t) as Q;

/** private.take_rate */
export async function takeRate(admin: StoreAdmin, key: string, limit: number, windowS: number): Promise<boolean> {
  const d = must(await priv(admin).rpc('take_rate', { p_key: key, p_limit: limit, p_window_s: windowS }), 'take_rate');
  return d === true;
}

/** AI 额度：take 返回扣了以后这一天的合计，到上限返回 null；refund 退回一次 */
export function quotaStore(admin: StoreAdmin): QuotaStore {
  return {
    async take(key, limit) {
      const d = must(await priv(admin).rpc('ai_quota_take', { p_key: key, p_limit: limit }), 'quota_take');
      return typeof d === 'number' ? d : null;
    },
    async refund(key) {
      must(await priv(admin).rpc('ai_quota_refund', { p_key: key }), 'quota_refund');
    },
  };
}

/** ai_state：谷歌额度用完到什么时候（第 7 节）；provider 固定 gemini */
export async function exhaustedUntil(admin: StoreAdmin): Promise<number | null> {
  const d = must(await tbl(priv(admin), 'ai_state').select('exhausted_until').eq('provider', 'gemini').maybeSingle(), 'ai_state_read');
  const v = (d as { exhausted_until?: unknown } | null)?.exhausted_until;
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 写 exhausted_until：只许往后延，不许缩短（11-13 评审：先撞每天限额写了午夜，同一时刻另一个请求撞每分钟限额写“12 秒后”，会把午夜盖掉）。
 * ① 先保证 gemini 这一行在（0001 建表时没有种子行；已有就不动，insert … on conflict do nothing）；
 * ② 再带条件 update：exhausted_until 为空或比新值早才写（Postgres 按行加锁后重新判条件，两个请求同时写也是晚的那个留下）。
 * PostgREST 的 or=(…) 里冒号、点是保留字符，时间串要用双引号包起来（supabase-js 会把整段再做 URL 编码）。
 */
export async function markExhausted(admin: StoreAdmin, untilMs: number): Promise<void> {
  const iso = new Date(untilMs).toISOString();
  must(await tbl(priv(admin), 'ai_state').upsert({ provider: 'gemini' }, { onConflict: 'provider', ignoreDuplicates: true }), 'ai_state_write');
  must(
    await tbl(priv(admin), 'ai_state').update({ exhausted_until: iso }).eq('provider', 'gemini').or(`exhausted_until.is.null,exhausted_until.lt."${iso}"`),
    'ai_state_write',
  );
}

/** ai-voice 失败：固定错误码 + status / type / bytes 区间（架构审第九节第 2 条；不写转写、正文、请求头） */
export async function logVoiceFail(admin: StoreAdmin, userId: string, code: string, fields: readonly string[], now: number): Promise<void> {
  must(await tbl(admin, 'logs').insert({ user_id: userId, t: now, kind: 'ai', act: 'voice_fail', src: 'ai-voice', fields: fields.slice(0, 20), code: code.slice(0, 64) }), 'logs_write');
}

/** claude-intake 写库失败（B3 任务单补充 R3）：固定错误码 + status / type，不写条目内容、原话、请求头 */
export async function logIntakeFail(admin: StoreAdmin, userId: string, code: string, fields: readonly string[], now: number): Promise<void> {
  must(await tbl(admin, 'logs').insert({ user_id: userId, t: now, kind: 'intake', act: 'intake_fail', src: 'claude-intake', fields: fields.slice(0, 20), code: code.slice(0, 64) }), 'logs_write');
}

/** 校验没过：只把原因写进 logs（不写原文、issues；第 7 节） */
export async function logInvalid(admin: StoreAdmin, userId: string, src: string, reasons: readonly string[], now: number): Promise<void> {
  must(await tbl(admin, 'logs').insert({ user_id: userId, t: now, kind: 'ai', act: 'invalid', src, fields: reasons.slice(0, 20), code: 'invalid' }), 'logs_write');
}
