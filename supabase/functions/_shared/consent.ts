// AI 同意的服务器端执行（架构 5.2、15.5，第二轮安全 N1、第三轮安全 X5；TC-B1-12）：走 AI 之前一律先过 aiAllowed，不通过就只走本地规则、一条都不送。
// 条件（四条全满足才放行）：
//   ① profiles.consent_ai_at 不为空（撤回同意时 record_consent_impl 把它清空，同时写 ai.enabled = false）；
//   ② profiles.consent_policy_ver >= app_config.notice.min_consent_ver（隐私说明有实质改动时调高 min_consent_ver，重新同意之前一条都不送）；
//   ③ settings 里 ai.enabled 为 true（没有这一行、行在“最近删除”里、撤销（undone）了、值不是布尔 true，都算没打开；撤销同软删）；
//   ④ 隐私记（opts.vault）另查 ai.vault：数据字典第 9 节默认 true（R-82），没有这一行按 true；值是 false 就挡——
//      不看 deleted_at、undone（审查必改 1；撤销（undone）同软删）：ai.vault 只能经服务器打开、客户端只能关，软删或撤销一行 false 不等于“打开”，
//      不然把那一行删进“最近删除”或撤销掉就绕过了；值为 true 的软删或撤销行按没有这一行处理（默认 true）；
//      ai.enabled 相反，软删、撤销都算关（没打开就不送，从严）。
// 版本号（架构 0.40、R-238）：policy_ver、min_consent_ver 只认 YYYY-MM-DD 或 YYYY-MM-DD-N（N 为 1～99），按“-”切段数字比、缺段按 0；空或格式不对一律不放行。
// 账号能不能用、会话在不在不归这里管：带 JWT 的函数先过 requireActiveUser，cron 按用户处理前先过 isUsable（_shared/auth.ts），再调 aiAllowed。
// ai-classify、ai-parse、ai-voice、claude-intake、ai-media、ai-embed、note-search、ai-summarize 共用这一份，不另写一套。
// 读不出来（出错、超时）抛 ConsentReadError，不当成“同意”，也不当成“不同意”：请求类函数回 503 try_later，cron 跳过这个人这一轮
// （当成“不同意”的话，ai-classify 会把这批记录写成 ai_status=rule，数据库一抖就降级了一批）。
// 不 import npm 包：admin 只要求下面 ConsentAdmin 这几个方法，用 service role 建的 supabase-js 客户端传进来即可（和 auth.ts 一样绕过 RLS，所以按 user_id 自己过滤）。

/** profiles 里和同意有关的两列（同意记录只由 record_consent 写，客户端改不了） */
export interface ConsentProfile {
  consent_ai_at: string | null;
  consent_policy_ver: string | null;
}

/** aiAllowed 判断用到的全部事实；undefined 表示 settings 里没有这一行 */
export interface ConsentFacts {
  /** 没有 profile 行时为 null */
  profile: ConsentProfile | null;
  aiEnabled: unknown;
  aiVault: unknown;
  /** app_config.notice.min_consent_ver；没配时为 null */
  minConsentVer: string | null;
}

export interface ConsentOpts {
  /** 送的是隐私记的内容（scope=vault、is_vault 的条目）：另查 ai.vault */
  vault?: boolean;
}

/** 版本号的唯一合法写法（R-238）：2026-10-29、2026-10-29-2 */
export const POLICY_VER_RE = /^\d{4}-\d{2}-\d{2}(-[1-9]\d?)?$/;

/**
 * 版本比较：a >= b。两边都要符合 POLICY_VER_RE，按“-”切成数字段逐段比，缺的段按 0（2026-10-29 小于 2026-10-29-1）。
 * 任何一边为空或格式不对一律 false——认不出来的版本不放行。
 */
export function policyVerAtLeast(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function parseVer(v: string | null | undefined): number[] | null {
  if (typeof v !== 'string' || !POLICY_VER_RE.test(v)) return null;
  return v.split('-').map(Number);
}

/** 纯判断（不读库）：四条全满足才 true */
export function decideAi(f: ConsentFacts, opts: ConsentOpts = {}): boolean {
  if (!f.profile || !f.profile.consent_ai_at) return false;                        // ① 没同意过，或已撤回
  if (!policyVerAtLeast(f.profile.consent_policy_ver, f.minConsentVer)) return false; // ② 同意的版本过旧（min 没配也不放行）
  if (f.aiEnabled !== true) return false;                                          // ③ AI 整理没打开
  if (opts.vault && f.aiVault === false) return false;                             // ④ 隐私记不交给 AI
  return true;
}

export class ConsentReadError extends Error {
  constructor(what: string) {
    super(`consent_read_failed:${what}`);
  }
}

type Res = { data: unknown; error: unknown };

/** 读库只用到的几个方法（supabase-js 的查询构造器在运行时就是这个形状） */
export interface ConsentQuery extends PromiseLike<Res> {
  eq(column: string, value: string | number): ConsentQuery;
  in(column: string, values: readonly string[]): ConsentQuery;
  maybeSingle(): PromiseLike<Res>;
}
export interface ConsentTable {
  select(columns: string): ConsentQuery;
}
/**
 * service role 的 supabase-js 客户端。from() 的返回值故意写成 unknown：supabase-js 的查询构造器泛型很深，
 * 直接按结构比对 deno check 报 TS2589（实例化过深），所以这里只要求“有 from”，取到以后在 tableOf 里按 ConsentTable 用
 */
export interface ConsentAdmin {
  from(table: string): unknown;
}

const tableOf = (admin: ConsentAdmin, table: string): ConsentTable => admin.from(table) as ConsentTable;

const READ_TIMEOUT_MS = 2000;   // 和 auth.ts 的查会话同一个上限

async function timed(p: PromiseLike<Res>, what: string): Promise<Res> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ConsentReadError(`${what}:timeout`)), READ_TIMEOUT_MS); });
  try {
    const r = await Promise.race([p, timeout]);
    if (r.error) throw new ConsentReadError(what);
    return r;
  } catch (e) {
    throw e instanceof ConsentReadError ? e : new ConsentReadError(what);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 读一个人判断要用的事实（三次查询并行）；任何一次出错或超时抛 ConsentReadError */
export async function readConsentFacts(admin: ConsentAdmin, userId: string): Promise<ConsentFacts> {
  const [prof, sets, cfg] = await Promise.all([
    timed(tableOf(admin, 'profiles').select('consent_ai_at, consent_policy_ver').eq('user_id', userId).maybeSingle(), 'profiles'),
    // 不按 deleted_at、undone 过滤（见文件头 ④），软删和撤销的行也读出来，在下面分开处理
    timed(tableOf(admin, 'settings').select('key, value, deleted_at, undone').eq('user_id', userId).in('key', ['ai.enabled', 'ai.vault']), 'settings'),
    timed(tableOf(admin, 'app_config').select('notice').eq('id', 1).maybeSingle(), 'app_config'),
  ]);

  const p = isObj(prof.data) ? { consent_ai_at: strOrNull(prof.data['consent_ai_at']), consent_policy_ver: strOrNull(prof.data['consent_policy_ver']) } : null;

  let aiEnabled: unknown;
  let aiVault: unknown;
  for (const row of Array.isArray(sets.data) ? sets.data : []) {
    if (!isObj(row)) continue;
    // 生效的行：没软删、也没撤销（undone 撤销同软删）
    const live = (row['deleted_at'] === null || row['deleted_at'] === undefined) && row['undone'] !== true;
    if (row['key'] === 'ai.enabled') {
      if (live) aiEnabled = row['value'];                     // 软删、撤销都算关
    } else if (row['key'] === 'ai.vault') {
      if (row['value'] === false) aiVault = false;            // 删没删都挡；(user_id, key) 唯一，正常只有一行，多行时有 false 就挡
      else if (aiVault === undefined && live) aiVault = row['value'];
    }
  }

  const notice = isObj(cfg.data) ? cfg.data['notice'] : null;
  const minConsentVer = isObj(notice) ? strOrNull(notice['min_consent_ver']) : null;

  return { profile: p, aiEnabled, aiVault, minConsentVer };
}

/**
 * 能不能把这个人的内容送 AI（架构 5.2 的 aiAllowed(userId, {vault})；admin 放第一个参数，和 isUsable(admin, userId) 一致）。
 * 调用前必须已过 requireActiveUser 或 isUsable；读库失败抛 ConsentReadError。
 */
export async function aiAllowed(admin: ConsentAdmin, userId: string, opts: ConsentOpts = {}): Promise<boolean> {
  return decideAi(await readConsentFacts(admin, userId), opts);
}
