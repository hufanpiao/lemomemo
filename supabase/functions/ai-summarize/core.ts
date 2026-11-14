// ai-summarize：把“＋”查出来的几条记录总结成一段话（架构 5.14 第 4 点、第 6 节 ai-summarize 行、第 7 节防提示注入；R-116；B4b-3）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/ai-summarize.test.ts）；不 import _shared/gen（CI unit 不生成 gen）、不 import npm 包。
// 顺序（每一步不过就直接回，后面的都不做）：
//   ① 只收 POST → ② requireActiveUser（JWT）→ ③ 请求体 ≤ MAX_BODY（边读边计数，超了 413），过 shared/schema/summarize.ts 的 summarizeReq、时区认得
//      （scope 不是 main 的——隐私记页面的总结这一批不做——和别的不合法请求一样 400 bad_request）；
//   ④ 按 id 读本人的日程、待办、随手记（fn_ai，没删、没撤销；store.ts）：读出隐私记（is_private）的整次 400 mixed_scope，不过门、不扣次数（0.23 N1）；
//      查不到的放进 missing（多半还没同步，0.23 L2）；一条都读不到的 400 all_missing（不过门、不扣次数；代定）；
//   ⑤ 共用的门（_shared/ai/gate.ts，同 ai-parse：同意、类型开关、模型配置、每分钟 6 次、谷歌额度、每人每天 50 次和全项目预扣），算 1 次；
//   ⑥ 拼 <data>：{ask, records:[{n, id, kind, title, when, where?, done?, text?}]}，每条正文前 BODY_MAX 字，标题、时间、地点、正文合计 ≤ TOTAL_MAX 字
//      （超了的那一条截短、后面的不送，不送的不能被 cited）；每个字段先过 parse-core.ts 的 sanitize（去控制字符、转义 <data>、</data>）；
//   ⑦ 提示词 summarize.v1（按 locale 用中文或韩文写，≤ 800 字，纯文本，不编造）、TASK_PARAMS.summarize、超时 SUMMARIZE_TIMEOUT_MS，不重试；
//   ⑧ 校验 summarizeRaw：summary 去控制字符（留换行），正文里的 [n] 改写成 cited 里的位置（relinkCites），截到 800 字（截在标记中间的去掉半截）（按 UTF-16 长度，和 zod 的 max 同一口径，不切开代理对），为空算 invalid；
//      cited 只留送进去的 id（去重）；回 {summary, cited, missing, quota_left}。
//   失败（服务商出错、超时、额度、输出不合格）：settleFailure 退回预扣的两次、quota 写 exhausted_until、invalid 只把原因写 logs，回 {fallback, reason}。
// 模型：用门给的 provider（app_config.ai.model，和 ai-parse 同一个；app_config 里没有单独给总结的模型，代定）。
// 日志只经 deps.log 记码和条数（不记请求体、原话、记录内容、总结，A23）。
import type { AuthResult } from '../_shared/auth-result.ts';
import { readJsonCapped } from '../_shared/body.ts';
import { json } from '../_shared/http.ts';
import { aiGate, clientReason, settleFailure, type GateDeps } from '../_shared/ai/gate.ts';
import { SUMMARIZE_TIMEOUT_MS, TASK_PARAMS } from '../_shared/ai/params.ts';
import { sanitize, wallOf } from '../_shared/ai/parse-core.ts';
import { SUMMARIZE_V1 } from '../_shared/ai/prompts/summarize.v1.ts';
import { aiFailCode, errNameOf, type AiResult } from '../_shared/ai/provider.ts';

// 上限和 shared/schema/summarize.ts 的同名常量相等（本文件不引 shared；tests/edge/ai-summarize.test.ts 钉住）
export const ITEMS_MAX = 50;
export const BODY_MAX = 500;
export const TOTAL_MAX = 20_000;
export const TEXT_MAX = 800;
export const ASK_MAX = 200;
export const TITLE_MAX = 160;
/** 请求体上限：50 个 {kind, id} 约 2.5 KB，原话 ≤ 800 个 UTF-16 单元约 2.4 KB */
export const MAX_BODY = 8 * 1024;
export const SRC = 'ai-summarize';

export type SummaryKind = 'event' | 'todo' | 'note';
type Ref = { kind: SummaryKind; id: string };
/** 请求体只写这里用到的形状，不引 _shared/gen 下的 schema（同 note-search/core.ts）；index.ts 接 summarizeReq 时 deno check 按这里核对 */
export type Req = { ids: Ref[]; ask?: string | undefined; now: number; tz: string; locale?: string | undefined; scope: 'main' };

/**
 * store.ts 读出来的一行：event 的 date、time 是它自己时区（tz）里的日子和时刻，todo 的是截止日子和时刻（浮动时间，不带时区）；
 * note 带 createdAt（毫秒）、isPrivate
 */
export interface SummaryRow {
  kind: SummaryKind;
  id: string;
  title: string | null;
  body: string | null;
  date?: string | null;
  time?: string | null;
  /** 日程记的时区（events.tz；null 是全天或旧数据） */
  tz?: string | null;
  where?: string | null;
  done?: boolean;
  createdAt?: number;
  isPrivate?: boolean;
}

export interface Deps extends GateDeps {
  authenticate(req: Request): Promise<AuthResult>;
  /** shared/schema/summarize.ts 的 summarizeReq（不合格为 null） */
  parse(v: unknown): Req | null;
  isValidTz(tz: string): boolean;
  /** shared/schema/ai.ts 的 normLocale */
  normLocale(v: unknown): 'zh' | 'ko';
  /** shared/schema/summarize.ts 的 summarizeRaw（不合格为 null） */
  checkRaw(v: unknown): { summary: string; cited: string[] } | null;
  /** shared/schema/ai.ts 的 stripCtlText（去控制字符、双向覆盖字符，留换行和制表符） */
  stripCtl(s: string): string;
  /** 按 id 读本人的（store.ts 的 loadRows，经 withAiUser）；读库出错抛 */
  loadRows(userId: string, ids: { event: string[]; todo: string[]; note: string[] }): Promise<SummaryRow[]>;
}

const cp = (s: string): number => [...s].length;

/** 截到最多 max 个 UTF-16 单元，不切开代理对（zod 的 string().max 按 UTF-16 长度量） */
export function cutUnits(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const wallText = (ms: number, tz: string): string => {
  const w = wallOf(ms, tz);
  return `${w.today} ${w.time}`;
};

/** tz 里的墙上时间（YYYY-MM-DD、HH:MM）→ 毫秒；格式不对、时区认不得回 null。按 wallOf 量出的偏移修两次（夏令时切换那一小时取前一个偏移） */
export function wallToMs(date: string, time: string, tz: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) return null;
  const want = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const asUtc = (ms: number): number => {
    const w = wallOf(ms, tz);
    return Date.UTC(Number(w.today.slice(0, 4)), Number(w.today.slice(5, 7)) - 1, Number(w.today.slice(8, 10)), Number(w.time.slice(0, 2)), Number(w.time.slice(3, 5)));
  };
  try {
    let ms = want;
    for (let i = 0; i < 2; i += 1) ms += want - asUtc(ms);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;   // 时区认不得（Intl 抛 RangeError）
  }
}

/**
 * 一条记录的“时间”，都按请求的时区（用户设备的时区，评审第 16 条）：
 * 日程带时刻、记了时区的换算过去（全天的、没带时区的、时区认不得的照原值）；待办是截止日子加时刻（浮动时间，没有截止的为空）；随手记是写下的时间
 */
function whenOf(r: SummaryRow, tz: string): string {
  if (r.kind === 'note') {
    if (r.createdAt === undefined || !Number.isFinite(r.createdAt)) return '';
    return wallText(r.createdAt, tz);
  }
  if (r.kind === 'event' && r.date && r.time && r.tz && r.tz !== tz) {
    const ms = wallToMs(r.date, r.time, r.tz);
    if (ms !== null) return wallText(ms, tz);
  }
  return [r.date ?? '', r.time ?? ''].filter((x) => x !== '').join(' ');
}

type Record_ = { n: number; id: string; kind: SummaryKind; title: string; when: string; where?: string; done?: boolean; text?: string };

/**
 * 拼 <data> 里的 JSON（按请求的顺序）。每个字段先 sanitize（第 7 节防提示注入：去控制字符、转义 <data>、</data>）再量长度；
 * 标题、时间、地点、正文合计到 TOTAL_MAX 为止：放不下的那一条把正文截短（截完还放不下就不送），后面的都不送。sent：真正送进去的 id
 */
export function buildData(rows: readonly SummaryRow[], ask: string, tz: string): { data: string; sent: Set<string> } {
  const records: Record_[] = [];
  const sent = new Set<string>();
  let total = 0;
  for (const r of rows) {
    const title = sanitize(r.title ?? '', TITLE_MAX);
    const when = whenOf(r, tz);
    const where = r.kind === 'event' ? sanitize(r.where ?? '', TITLE_MAX) : '';
    let text = sanitize(r.body ?? '', BODY_MAX);
    const head = cp(title) + cp(when) + cp(where);
    const room = TOTAL_MAX - total;
    if (head + cp(text) > room) {
      if (head >= room) break;
      text = [...text].slice(0, room - head).join('');
    }
    total += head + cp(text);
    records.push({
      n: records.length + 1, id: r.id, kind: r.kind, title, when,
      ...(where !== '' ? { where } : {}), ...(r.kind === 'todo' ? { done: r.done === true } : {}), ...(text !== '' ? { text } : {}),
    });
    sent.add(r.id);
    if (total >= TOTAL_MAX) break;
  }
  return { data: JSON.stringify({ ask: sanitize(ask, ASK_MAX), records }), sent };
}

/** 正文里的引用标记：[3]、[1][2]，也认 [1,2]、[1，2]、[1、2]（模型偶尔这样写） */
const CITE = /\[(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\]/g;

/**
 * 正文里的 [n]（n 是送出去的第几条，buildData 的 n）改写成 [m]，m 是这条在 cited 里的位置（从 1 起）：
 * cited 按正文里第一次被引的顺序排，模型另给的 cited（只留送出去的）排在后面——客户端依据列表的序号就和角标对上（返工，线框 22）。
 * n 超出送出的条数、0 的标记删掉；连写、逗号写法拆成一个个 [m]
 */
export function relinkCites(summary: string, modelCited: readonly string[], order: readonly string[]): { summary: string; cited: string[] } {
  const cited: string[] = [];
  const pos = (id: string): number => {
    const i = cited.indexOf(id);
    if (i >= 0) return i + 1;
    cited.push(id);
    return cited.length;
  };
  const text = summary.replace(CITE, (_m, list: string) =>
    list
      .split(/[,，、]/)
      .map((s) => order[Number(s.trim()) - 1])
      .filter((id): id is string => id !== undefined)
      .map((id) => `[${pos(id)}]`)
      .join(''),
  );
  const sent = new Set(order);
  for (const id of modelCited) if (sent.has(id) && !cited.includes(id)) cited.push(id);
  return { summary: text, cited };
}

/** 填 summarize.v1 的占位符（这里只放今天、时区、语言，不放任何用户内容）；now 是服务器时钟（handle 传 deps.now()，不用客户端传的） */
export function summarizePrompt(now: number, tz: string, locale: 'zh' | 'ko'): string {
  const w = wallOf(now, tz);
  const map: Record<string, string> = { TODAY: w.today, WEEKDAY: w.weekday, TZ: tz, LANG: locale === 'ko' ? '韩文' : '中文' };
  return SUMMARIZE_V1.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (Object.hasOwn(map, k) ? map[k] : undefined) ?? m);
}

/** Gemini responseSchema（OpenAPI 子集） */
export const SUMMARY_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: { summary: { type: 'STRING' }, cited: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['summary', 'cited'],
});

const split = (ids: readonly Ref[]) => ({
  event: ids.filter((x) => x.kind === 'event').map((x) => x.id),
  todo: ids.filter((x) => x.kind === 'todo').map((x) => x.id),
  note: ids.filter((x) => x.kind === 'note').map((x) => x.id),
});

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const uid = auth.user.userId;

  const raw = await readJsonCapped(req, MAX_BODY);
  if (raw === 'too_large') return json(413, { error: 'too_large' });
  const body = deps.parse(raw);
  if (!body || !deps.isValidTz(body.tz)) return json(400, { error: 'bad_request' });

  let rows: SummaryRow[];
  try {
    rows = await deps.loadRows(uid, split(body.ids));
  } catch {
    deps.log('store_failed');
    return json(503, { error: 'try_later' });
  }
  if (rows.some((r) => r.isPrivate === true)) {
    deps.log('mixed_scope');
    return json(400, { error: 'mixed_scope' });
  }
  // 按请求的顺序、kind 和 id 都对上才算（store 按 kind 分表查，不会串，这里再核一次）
  const byKey = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
  const ordered = body.ids.map((x) => byKey.get(`${x.kind}:${x.id}`)).filter((r): r is SummaryRow => r !== undefined);
  const missing = body.ids.filter((x) => !byKey.has(`${x.kind}:${x.id}`)).map((x) => x.id);
  if (ordered.length === 0) {
    deps.log(`all_missing n=${missing.length}`);
    return json(400, { error: 'all_missing' });
  }

  const gate = await aiGate(deps, uid, req.headers.get('x-app-version') ?? '');
  if (gate.stop) return json(gate.status, gate.body);

  const { data, sent } = buildData(ordered, body.ask ?? '', body.tz);
  if (missing.length > 0) deps.log(`missing n=${missing.length}`);
  if (sent.size < ordered.length) deps.log(`truncated sent=${sent.size} rows=${ordered.length}`);

  let r: AiResult;
  try {
    r = await gate.provider.generate({
      // 今天按服务器时钟、用户时区算（评审第 16 条：客户端传的 now 可能不准，只当请求的一部分校验）
      system: summarizePrompt(deps.now(), body.tz, deps.normLocale(body.locale)),
      parts: [{ text: `<data>${data}</data>` }],
      schema: { ...SUMMARY_SCHEMA },
      params: TASK_PARAMS.summarize,
      timeoutMs: SUMMARIZE_TIMEOUT_MS,
    });
  } catch (e) {
    r = { ok: false, reason: 'error', errName: errNameOf(e) };
  }
  if (!r.ok) {
    deps.log(aiFailCode(r));
    await settleFailure(deps, gate, uid, SRC, r);
    return json(200, { fallback: true, reason: clientReason(r) });   // 每分钟限额回 error，客户端不记“今天用完”
  }
  const out = deps.checkRaw(r.json);
  // 先把 [n] 改写成 cited 里的位置，再截到 800 字；截断落在标记中间的，把那半截去掉
  const linked = out ? relinkCites(deps.stripCtl(out.summary).trim(), out.cited, [...sent]) : null;
  const summary = linked ? cutUnits(linked.summary, TEXT_MAX).replace(/\[\d*$/, '').trim() : '';
  if (!out || !linked || summary === '') {
    const reason = out ? 'empty' : 'schema';
    deps.log(`ai_invalid ${reason}`);
    await settleFailure(deps, gate, uid, SRC, { reason: 'invalid', invalid_reasons: [reason] });
    return json(200, { fallback: true, reason: 'invalid' });
  }
  const cited = linked.cited.slice(0, ITEMS_MAX);
  const dropped = out.cited.filter((id) => !sent.has(id)).length;
  if (dropped > 0) deps.log(`cited_dropped n=${dropped}`);
  return json(200, { summary, cited, missing, quota_left: gate.quotaLeft });
}
