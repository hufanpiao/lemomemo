// note-search：按意思查找（架构 5.13 第 6 点“查询流程”、第 6 节 note-search 行、第 8 点用量表；R-112、R-116；B4b-2）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/note-search.test.ts）。
// 顺序（每一步不过就直接回，后面的都不做）：
//   ① POST、请求体 ≤ 1 KB、{q（1～100 字）, scope: 'main'}；scope=vault（隐私记页面，D-16）这一批不做，和别的不合法请求一样 400；
//   ② requireActiveUser（JWT）；
//   ③ aiAllowed（没同意、ai.enabled 关着）→ {fallback: consent}；读不出 → 503 try_later（不当成同意，也不当成不同意）；
//   ④ 每人每分钟 RATE_PER_MIN 次（search-min:<uid>:<UTC 分钟>）→ 超了 {fallback: timeout}（“这次超时 · 再试一次”；不说“今天用完”，同 gate.ts 的 clientReason）；
//   ⑤′ 模型或密钥没配 → {fallback: timeout}（放在扣每天次数之前：不花钱的检查先做，没配不扣次数）；
//   ⑤ 每人每天按 user_limits.search_daily（null = 不设上限，负责人）；没有这一行用 app_config.ai.search_daily_default（朋友默认 200）；
//      计数键 search:<uid>:<太平洋日期>（窗口同 ai: 的 QUOTA_WINDOW_S，日期写在键里；不占 50 次，第 8 点）→ 用完 {fallback: quota}；
//      不设上限的人照样计数（给 my_ai_usage 的“今天按意思找了 N 次”），上限传 UNLIMITED；
//   ⑥ 嵌入查询（gemini-embedding-2、768 维，超时 EMBED_TIMEOUT_MS = 3 秒）：谷歌每天额度的 429 → {fallback: quota}；
//      每分钟的 429、超时、出错 → {fallback: timeout}（clientReason 把每分钟的改成 error）。按意思找失败不退回已扣的那一次（结果已经退回到关键词，次数宽裕，代定）；
//   ⑦ 只查这个人、当前模型、is_vault = false 的向量（scope=main 写死，带不带 vault 令牌都一样，0.23 N1），余弦相似度 ≥ MIN_SCORE，最多 30 条，
//      只回 [{kind, id, score}]，不回内容。删了的源头由客户端按本机缓存过滤（向量随源头硬删级联删掉，软删的 30 天内还在）。
// 日志只经 deps.log 记码（不记查询文字、向量、分数，A23）。
import { errorResponder, json, NO_STORE } from '../_shared/http.ts';
import { readJsonCapped } from '../_shared/body.ts';
import type { AuthResult } from '../_shared/auth-result.ts';
import { utcMinuteKey } from '../_shared/rate-key.ts';
import { clientReason, pacificDate } from '../_shared/ai/gate.ts';
import { QUOTA_WINDOW_S } from '../_shared/ai/store.ts';
import { queryText, type EmbedKind, type EmbedResult } from '../_shared/ai/embed.ts';
import { isObj } from '../_shared/obj.ts';

// 请求、响应只写这里用到的形状，不引 _shared/gen 下的 schema（带 npm:zod，Vitest 的 tsc 解析不了；同 file-check/core.ts）；
//   index.ts 把 shared/schema/search.ts 的 noteSearchReq 接进来时，deno check 按这里的形状核对
type Req = { q: string; scope: 'main' };
export type Hit = { kind: EmbedKind; id: string; score: number };

export const RATE_PER_MIN = 20;
export const EMBED_TIMEOUT_MS = 3_000;
/** 不设上限的人：照样计数，上限给一个用不到的数 */
export const UNLIMITED = 1_000_000;
/** 最多回几条（同 shared/schema/search.ts 的 SEARCH_HITS_MAX） */
export const HITS_MAX = 30;
/** 相似度门槛（代定，D-14 待负责人按实测定）：低于它的不要 */
export const MIN_SCORE = 0.55;

export interface SearchConfig {
  /** app_config.ai.embed_model；没配为 null */
  embedModel: string | null;
  /** app_config.ai.search_daily_default（朋友默认 200）；读不出按 200 */
  searchDailyDefault: number;
}

/** app_config.ai 里的 embed_model、search_daily_default（格式不对按没配、按 200） */
export function readSearchConfig(ai: unknown): SearchConfig {
  const o = isObj(ai) ? ai : {};
  const m = o['embed_model'];
  const d = o['search_daily_default'];
  return {
    embedModel: typeof m === 'string' && m !== '' ? m : null,
    searchDailyDefault: typeof d === 'number' && Number.isInteger(d) && d >= 0 ? d : 200,
  };
}

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  parse(v: unknown): Req | null;
  consent(userId: string): Promise<boolean>;
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  config(): Promise<SearchConfig>;
  /** private.user_limits.search_daily：没有这一行 undefined，这一行写着 null 为 null（不设上限） */
  searchDaily(userId: string): Promise<number | null | undefined>;
  /** null：模型或密钥没配 */
  embedder(model: string | null): ((texts: readonly string[], timeoutMs: number) => Promise<EmbedResult>) | null;
  nearest(userId: string, vec: readonly number[], model: string, limit: number, minScore: number): Promise<Hit[]>;
  now(): number;
  log(code: string): void;
}

type Code = 'bad_request' | 'method_not_allowed' | 'try_later';
const err = errorResponder<Code>();
const fallback = (reason: 'consent' | 'quota' | 'timeout'): Response => json(200, { fallback: reason }, NO_STORE);

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  try {
    const raw = await readJsonCapped(req.clone(), 1024);
    const r = raw === 'too_large' ? null : deps.parse(raw);
    if (!r) return err(400, 'bad_request');
    const auth = await deps.authenticate(req);
    if (!auth.ok) return auth.response;
    const uid = auth.user.userId;
    if (!(await deps.consent(uid))) {
      deps.log('fallback:consent');
      return fallback('consent');
    }
    const now = deps.now();
    if (!(await deps.takeRate(utcMinuteKey('search-min', uid, now), RATE_PER_MIN, 60))) {
      deps.log('fallback:rate');
      return fallback('timeout');
    }
    const cfg = await deps.config();
    const model = cfg.embedModel;
    const embed = deps.embedder(model);
    if (!embed || model === null) {
      deps.log('fallback:unconfigured');
      return fallback('timeout');
    }
    const own = await deps.searchDaily(uid);
    const limit = own === undefined ? cfg.searchDailyDefault : own ?? UNLIMITED;
    if (!(await deps.takeRate(`search:${uid}:${pacificDate(now)}`, limit, QUOTA_WINDOW_S))) {
      deps.log('fallback:daily');
      return fallback('quota');
    }
    const e = await embed([queryText(r.q)], EMBED_TIMEOUT_MS);
    if (!e.ok) {
      deps.log(`fallback:embed_${e.reason}${e.quotaKind ? ` kind=${e.quotaKind}` : ''}${e.status ? ` status=${e.status}` : ''}`);
      return fallback(clientReason(e) === 'quota' ? 'quota' : 'timeout');
    }
    const vec = e.vectors[0];
    if (!vec) return fallback('timeout');
    return json(200, { hits: await deps.nearest(uid, vec, model, HITS_MAX, MIN_SCORE) }, NO_STORE);
  } catch {
    deps.log('try_later');
    return err(503, 'try_later');
  }
}
