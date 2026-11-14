// claude-intake（架构 5.7、第 6 节函数表 claude-intake 行、第 7 节防提示注入第 4、6 条；R-65；S-B3 中 6；B3 任务单 S14、BE-5、M2、M3）。
// 网关不验 JWT（config.toml 的 verify_jwt = false，check_backend.py F9 按“按哈希查表”一类核对），鉴权全靠这里：
//   方法（只收 POST；版本门免查 POST，shared/version-gate-list.ts）
//   → Authorization: Bearer <连接码>：格式不对不查库；按 SHA-256 查 api_tokens（未吊销、180 天内、scopes 含 create）→ 得到 user_id；
//     查不到、吊销、过期一律 401 unauthorized（不区分，不暴露码存不存在）
//   → 账号能不能用（isUsable：停用、冷静期一律 403，service role 绕过 RLS 不能只靠 is_active）
//   → 每个连接码每小时 60 次（claude-intake:<token_id>:<UTC 小时>）
//   → 请求体 {items: [...]} 或 {text}（≤ 2000 字）
//   → 有 text：本机规则先拆（shared/logic/parse，和客户端同一套）；有把握就用它、不调 AI；没把握、并且 aiAllowed、有额度才调 AI
//     （门和 ai-parse 共用 _shared/ai/gate.ts，扣同一个每人每天 50 次）；AI 失败或不让调就用本机结果
//     有 items：按 AI 输出同一套校验（shared/schema/ai.ts），只接受对这个人打开的类型，不合格整份 400
//   → 过去的月日、几号（confirm）、月份没有的日子：聊天里没法问，不存，回在 needs_confirm 里让 Claude 带上年份重发（R-166：不替用户猜）
//   → 每人每天 200 条（claude-intake-user:<user_id>:<UTC 日期>，安全审 M2）、每个连接码每天 200 条（claude-intake-items:<token_id>:<UTC 日期>），一条计一次，超了的不存
//   → 用 service role 写入：user_id 取自连接码（和模型输出无关），source = chat，有时刻的日程 tz 记 profiles.current_tz，
//     行由 shared/logic/capture-map.ts 生成（和客户端保存处同一份，M10）；同一次请求共用一个 batch_id
//   → 三张表一个事务写完（private.intake_insert）→ 记 api_tokens.last_used_at
//     写不进回 503 not_saved、created 为空；写库失败和记 last_used_at 失败各在 logs 表写一行 act intake_fail（只有错误码、status=、type=，B3 任务单补充 R3）
//   → 回 {created, needs_confirm（两个候选日子和给 Claude 的问法）, bad_day, skipped, over_limit, note, tips（只记了最近一次、具体时间请自己排）}。
// 只能新增：这里只 insert，不读、不改、不删已有条目（TC-B3-20）。日志只记错误码：不打印请求头（连接码）、请求体（A23）。
// 纯逻辑：依赖全部注入，不 import _shared/gen/、npm 包。
import { aiGate, settleFailure, type GateDeps } from '../_shared/ai/gate.ts';
import { aiFailCode, errNameOf, type AIProvider } from '../_shared/ai/provider.ts';
import type { AiKindLike, CheckCtx, CheckResult, ParseFail, ParseInput, ParseOk } from '../_shared/ai/parse-core.ts';
import { readJsonObjectCapped } from '../_shared/body.ts';
import { TOKEN_RE, tokenHash, tokenLive } from '../_shared/intake-token.ts';
import { utcDayKey, utcHourKey } from '../_shared/rate-key.ts';

export const HOURLY_LIMIT = 60;
export const DAILY_ITEMS = 200;
/** 每人每天写入总上限（安全审 M2：连接码可以有好几个，按码计封不住一个账号），和单码上限相同 */
export const USER_DAILY_ITEMS = 200;
export const MAX_BODY = 32 * 1024;
export const TEXT_MAX = 2000;

/** 识别结果里用到的字段（shared/schema/ai.ts 的 AiItem） */
export interface ItemLike {
  kind: AiKindLike;
  title: string;
  date: string | null;
  due: string | null;
  time: string | null;
  date_basis: 'ymd' | 'md' | 'd' | 'rel' | null;
  confirm: { past: string; next: string } | null;
}

/** 给 Claude 看的说明（聊天里没有弹窗，靠 Claude 问用户；add.ps1 原样输出，架构审第九节第 4 条） */
export const ASK_YEAR = '这个日子今年已经过了：请问用户记今年还是明年，再把这一条带上完整日期（YYYY-MM-DD）单独重发';
export const ASK_MONTH = '这个日子本月已经过了：请问用户记本月还是下个月，再把这一条带上完整日期（YYYY-MM-DD）单独重发';
export const ASK_BAD_DAY = '原话里的日子在那个月不存在，没有日子的条目没记：请和用户确认日子后，把这几条带上完整日期单独重发';
export const NOTE_RESEND = '已记下的不要重发；只重发 needs_confirm、bad_day 里的条目';
/** R-163：带重复说法的只记最近一次；R-200：“帮我安排时间”不排，只记待办（代码审建议 4：聊天这一路也带回给 Claude） */
export const TIP_RECUR = '重复要等新版本，这次只记了最近一次（请转告用户）';
export const TIP_ARRANGE = '具体时间请自己排（请转告用户）';

export interface TokenRow { id: string; user_id: string; scopes: string[] | null; created_at: string; revoked_at: string | null }
export interface Profile { current_tz: string; ui_locale: string }
export type Row = { table: 'events' | 'todos' | 'anniversaries'; row: Record<string, unknown> & { id: string } };

export interface Logic<Item extends ItemLike> {
  parseSplit(text: string, now: number, tz: string, locale: 'zh' | 'ko', projects: readonly string[], opts: { features: readonly AiKindLike[] }):
    { items: Item[]; hints: { bad_day: { month: number; day: number } | null } };
  confidence(r: { items: Item[] }): 'sure' | 'unsure';
  checkParseOutput(raw: unknown, ctx: CheckCtx): CheckResult<{ items: Item[] }>;
  parseWithAI(input: ParseInput, provider: AIProvider): Promise<ParseOk<{ items: Item[] }> | ParseFail>;
  captureRow(item: Item, ctx: {
    id: string; batchId: string; now: number; today: string; tz: string; source: 'chat'; rawText: string; origin: 'ai' | 'rule';
  }): Row | null;
  todayOf(now: number, tz: string): string;
  /** 原话带重复说法（每天、每周……）、带“帮我安排时间”（shared/logic/parse 的 recurHint、arrangeHint） */
  recurHint(text: string): boolean;
  arrangeHint(text: string): boolean;
  normLocale(v: unknown): 'zh' | 'ko';
  isValidTz(tz: string): boolean;
}

export interface Store {
  findToken(hash: string): Promise<TokenRow | null>;
  usable(userId: string): Promise<boolean>;
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  profile(userId: string): Promise<Profile | null>;
  /** 本人已有的项目名（events、todos 的 project 去重，最多 30 个，M3） */
  projects(userId: string): Promise<string[]>;
  /** 三张表一个事务写完（private.intake_insert，迁移 20261107100000）：任何一条写不进整份回滚、什么都没写，Claude 重试不会重复 */
  insertAll(userId: string, rows: Partial<Record<Row['table'], Record<string, unknown>[]>>): Promise<void>;
  touchToken(tokenId: string, at: number): Promise<void>;
  /** 写库失败写 logs 表一行（act intake_fail，R3）：fields 只有 status=HTTP 状态、type=异常类型名 */
  logFail(userId: string, code: string, fields: string[]): Promise<void>;
}

/** 写库出错时带上 PostgREST 的 HTTP 状态（只给日志用） */
export class StoreError extends Error {
  override name = 'StoreError';
  readonly status: number | undefined;
  constructor(status?: number) {
    super('db');
    this.status = status;
  }
}

/** 日志字段：只认 HTTP 状态和 1～40 个英文字母的类型名，别的一律不写 */
export function failFields(e: unknown): string[] {
  const out: string[] = [];
  const st = e instanceof StoreError ? e.status : undefined;
  if (typeof st === 'number' && Number.isInteger(st) && st >= 100 && st <= 599) out.push(`status=${st}`);
  out.push(`type=${errNameOf(e)}`);
  return out;
}

export interface Deps<Item extends ItemLike> {
  store: Store;
  /** 和 ai-parse 同一套门（同意、开关、每分钟、额度）；features 也从这里取 */
  gate: GateDeps;
  logic: Logic<Item>;
  uuid(): string;
}

import { json } from '../_shared/http.ts';
export { json };
const err = (status: number, code: string, extra: Record<string, unknown> = {}) => json(status, { error: code, ...extra });

export const hourKey = (tokenId: string, ms: number) => utcHourKey('claude-intake', tokenId, ms);
export const itemsKey = (tokenId: string, ms: number) => utcDayKey('claude-intake-items', tokenId, ms);
export const userItemsKey = (userId: string, ms: number) => utcDayKey('claude-intake-user', userId, ms);

/** 有 text：本机规则优先，没把握才走 AI（门不过、AI 失败都用本机结果） */
async function fromText<Item extends ItemLike>(
  deps: Deps<Item>, userId: string, text: string, now: number, tz: string, locale: 'zh' | 'ko', projects: string[], appVersion: string,
): Promise<{ items: Item[]; origin: 'ai' | 'rule'; badDay: { month: number; day: number } | null }> {
  const features = await deps.gate.features(userId, appVersion);
  const local = deps.logic.parseSplit(text, now, tz, locale, projects, { features });
  const rule = { items: local.items, origin: 'rule' as const, badDay: local.hints.bad_day };
  if (deps.logic.confidence(local) === 'sure') return rule;
  const gate = await aiGate(deps.gate, userId, appVersion);
  if (gate.stop) return rule;
  let r: ParseOk<{ items: Item[] }> | ParseFail;
  try {
    r = await deps.logic.parseWithAI({ text, now, tz, locale, projects, features: gate.features }, gate.provider);
  } catch {
    r = { ok: false, reason: 'error' };
  }
  if (!r.ok) {
    deps.gate.log(aiFailCode(r));
    await settleFailure(deps.gate, gate, userId, 'claude-intake', r);
    return rule;
  }
  return { items: r.value.items, origin: 'ai', badDay: null };
}

/** 写 logs 失败不影响回答，只记错误码 */
async function logFail<Item extends ItemLike>(deps: Deps<Item>, userId: string, code: string, fields: string[]): Promise<void> {
  try {
    await deps.store.logFail(userId, code, fields);
  } catch {
    deps.gate.log('log_write_failed');
  }
}

export async function handle<Item extends ItemLike>(req: Request, deps: Deps<Item>): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const log = deps.gate.log;
  const now = deps.gate.now();

  // ---- 连接码 ----
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  const token = m?.[1] ?? '';
  if (!TOKEN_RE.test(token)) return err(401, 'unauthorized');
  let row: TokenRow | null;
  try {
    row = await deps.store.findToken(await tokenHash(token));
  } catch {
    log('store:token');
    return err(503, 'try_later');
  }
  if (!row || !tokenLive(row, now) || !(row.scopes ?? []).includes('create')) return err(401, 'unauthorized');
  const userId = row.user_id;
  try {
    if (!(await deps.store.usable(userId))) return err(403, 'account_disabled');
    if (!(await deps.store.takeRate(hourKey(row.id, now), HOURLY_LIMIT, 3600))) return err(429, 'rate_limited');
  } catch {
    log('store:gate');
    return err(503, 'try_later');
  }

  // ---- 请求体 ----
  const read = await readJsonObjectCapped(req, MAX_BODY);   // 边读边计字节（安全审建议 1：这个函数网关不验 JWT）
  if (read === 'too_large') return err(413, 'too_large');
  const body = read;
  const hasText = typeof body?.['text'] === 'string';
  const hasItems = Array.isArray(body?.['items']);
  if (!body || hasText === hasItems) return err(400, 'bad_request');
  if (hasText && ([...(body['text'] as string)].length > TEXT_MAX || (body['text'] as string).trim() === '')) return err(400, 'bad_request');

  let profile: Profile | null;
  let projects: string[];
  try {
    [profile, projects] = await Promise.all([deps.store.profile(userId), deps.store.projects(userId)]);
  } catch {
    log('store:profile');
    return err(503, 'try_later');
  }
  if (!profile || !deps.logic.isValidTz(profile.current_tz)) return err(503, 'try_later');
  const tz = profile.current_tz;
  const locale = deps.logic.normLocale(profile.ui_locale);
  const appVersion = req.headers.get('x-app-version') ?? '';

  let items: Item[];
  let origin: 'ai' | 'rule';
  let badDay: { month: number; day: number } | null = null;
  const rawText = hasText ? (body['text'] as string) : '';
  if (hasText) {
    ({ items, origin, badDay } = await fromText(deps, userId, rawText, now, tz, locale, projects, appVersion));
  } else {
    const features = await deps.gate.features(userId, appVersion);
    const v = deps.logic.checkParseOutput({ items: body['items'] }, { now, tz, features });
    if (!v.ok) return err(400, 'invalid_items', { invalid_reasons: v.invalid_reasons });
    items = v.value.items;
    origin = 'ai';
  }

  // ---- 过去的日子先问（聊天里问不了，不存）----
  // R-166：不替用户猜。同一请求里其他条照常保存，这几条单列、写清两个候选日子
  const needsConfirm = items.filter((it) => it.confirm !== null).map((it) => ({
    kind: it.kind, title: it.title, candidates: [it.confirm?.past, it.confirm?.next], ask: it.date_basis === 'd' ? ASK_MONTH : ASK_YEAR,
  }));
  // 月份没有的日子（本机规则的 bad_day）：那一条的日子是空的，没日子的条目同样不存，提示原话（宁可少记，不记成没日子的）
  const undated = (it: Item) => (it.kind === 'event' ? it.date : it.kind === 'todo' ? it.due : 'x') === null;
  const badItems = badDay ? items.filter((it) => it.confirm === null && undated(it)) : [];
  const ready = items.filter((it) => it.confirm === null && !badItems.includes(it));

  // ---- 每天 200 条、写库 ----
  const batchId = deps.uuid();
  const today = deps.logic.todayOf(now, tz);
  const rows: Row[] = [];
  let skipped = 0;
  for (const it of ready) {
    const r = deps.logic.captureRow(it, { id: deps.uuid(), batchId, now, today, tz, source: 'chat', rawText, origin });
    if (!r) {
      skipped++;
      continue;
    }
    rows.push(r);
  }
  const allowed: Row[] = [];
  try {
    // 先扣码、再扣人（安全审查第 13 条）：两道都是同一个 UTC 日的键，计数不退。先扣人的话，码那一道不过时人已多计一条，
    // 这个人别的连接码当天少记一条；先扣码，人那一道不过时码多计一条——人当天已用完，换哪个码都写不进，多计不影响什么
    for (const r of rows) {
      if (!(await deps.store.takeRate(itemsKey(row.id, now), DAILY_ITEMS, 86400))) break;
      if (!(await deps.store.takeRate(userItemsKey(userId, now), USER_DAILY_ITEMS, 86400))) break;
      allowed.push(r);
    }
  } catch {
    log('store:items_rate');
    return err(503, 'try_later');
  }
  const over = rows.length - allowed.length;
  if (rows.length > 0 && allowed.length === 0) return err(429, 'daily_limit');
  try {
    const byTable: Partial<Record<Row['table'], Record<string, unknown>[]>> = {};
    for (const table of ['events', 'todos', 'anniversaries'] as const) {
      const part = allowed.filter((r) => r.table === table).map((r) => r.row);
      if (part.length) byTable[table] = part;
    }
    if (Object.keys(byTable).length) await deps.store.insertAll(userId, byTable);
  } catch (e) {
    // 一条都没存上（一个事务整份回滚）：回 503、错误码 not_saved、created 为空，让 Claude 知道没存上（R3：每天 200 条的计数不退回，偏安全一侧）；
    // logs 表记一行 intake_fail（只有错误码、HTTP 状态、类型名）
    log('store:insert');
    await logFail(deps, userId, 'not_saved', failFields(e));
    return err(503, 'not_saved', { created: [] });
  }
  try {
    await deps.store.touchToken(row.id, now);
  } catch (e) {
    log('store:touch_token');   // 条目已经存上了：只记错误码，照常回成功（重试会写出重复条目）
    await logFail(deps, userId, 'touch_token_failed', failFields(e));
  }
  const created = allowed.map((r) => ({
    id: r.row.id, kind: r.table === 'events' ? 'event' : r.table === 'todos' ? 'todo' : 'anniv', title: r.row['title'] ?? r.row['name'],
    date: r.row['date'] ?? r.row['due'] ?? null, time: r.row['time'] ?? r.row['due_time'] ?? null,
  }));
  const bad = badDay ? { month: badDay.month, day: badDay.day, raw_text: rawText, titles: badItems.map((it) => it.title), ask: ASK_BAD_DAY } : null;
  const tips = [
    ...(hasText && deps.logic.recurHint(rawText) ? [TIP_RECUR] : []),
    ...(hasText && deps.logic.arrangeHint(rawText) ? [TIP_ARRANGE] : []),
  ];
  return json(200, {
    created, needs_confirm: needsConfirm, bad_day: bad, skipped, over_limit: over,
    ...(needsConfirm.length || bad ? { note: NOTE_RESEND } : {}),
    ...(tips.length ? { tips } : {}),
  });
}
