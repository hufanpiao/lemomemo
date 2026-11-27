// ai-provider 的联网搜索对比 admin_web_compare（对比用，负责人 11-24：按照3你调查一下，对比一下）。
// 同一批问题让 Brave、Tavily、DeepSeek 搜索用各自存的项目密钥各搜一次（DeepSeek 用对话那家的 ai_key_deepseek），看哪家结果好；
// 不改联网用哪家、不存任何东西。同意、限速由 core.ts 先查（和试调同一套，整批算一次）。
// • 问题一条一条搜（同一条三家同时搜）：Brave 有每秒限速，十条一起发容易撞 429。每家每条 TEST_TIMEOUT_MS 超时，十条最长约 100 秒。
// • “今天”按首尔算（COMPARE_TZ）：搜索词里的“明天”、DeepSeek 的 after: 都按它，和对话里联网的加工一样（websearch.ts 的 webQueryOf）。
// • 失败照试调归类（fail.ts 的 testFailOf）；没存密钥的那家回 no_key、不搜。
// • 日志只记条数和每家的码（admin_web_compare n=3、admin_web_compare brave ok=2 quota:429=1），不记搜索词和结果（A23）。
// 回包形状以 shared/schema/ai-provider.ts 的 webCompareRes 为准（本文件不引 shared，tests/edge/ai-provider.test.ts 按它解析）。
import { json } from '../_shared/http.ts';
import { wallOf } from '../_shared/ai/parse-core.ts';
import type { WebSearchResult } from '../_shared/ai/provider.ts';
import { plainOf, type WebCompareName } from '../_shared/ai/websearch.ts';
import type { Deps } from './core.ts';
import { AI_AUTH_STATUS, TEST_TIMEOUT_MS, testFailOf, WEB_AUTH_STATUS, type TestFail } from './fail.ts';

/** 对比结果里的摘要截到几个字（和 shared 的 WEB_COMPARE_SNIPPET_MAX 一致，测试钉住） */
export const COMPARE_SNIPPET_MAX = 120;
/** 对比时“今天”按哪个时区算（负责人常在首尔） */
export const COMPARE_TZ = 'Asia/Seoul';

export type CompareHit = { title: string; url: string; site: string; date: string | null; snippet: string };
/** 一家搜一条的结果：通了带耗时和结果；不通带固定词（试调那几个，另加 no_key 没存密钥） */
export type CompareOne =
  | { ok: true; ms: number; results: CompareHit[] }
  | { ok: false; ms: number; code: TestFail | 'no_key'; status?: number };

/** 某家搜一条（DeepSeek 只认 401 / 403 当密钥不对，它的 422 不是密钥问题） */
export async function compareOne(deps: Pick<Deps, 'makeSearcher' | 'now'>, p: WebCompareName, key: string | undefined, query: string, today: string): Promise<CompareOne> {
  const s = key ? deps.makeSearcher(p, key) : null;
  if (!s) return { ok: false, ms: 0, code: 'no_key' };
  const t0 = deps.now();
  let r: WebSearchResult;
  try {
    r = await s.search({ query, lang: 'zh', today, timeoutMs: TEST_TIMEOUT_MS });
  } catch (e) {
    r = { ok: false, reason: 'error', errName: e instanceof Error ? e.name : 'unknown' };
  }
  const ms = Math.max(0, deps.now() - t0);
  if (!r.ok) return { ...testFailOf(r, p === 'deepseek' ? AI_AUTH_STATUS : WEB_AUTH_STATUS, false), ms };
  return {
    ok: true, ms,
    results: r.sources.map((x) => ({ title: x.title, url: x.url, site: x.site, date: x.date ?? null, snippet: plainOf(x.text, COMPARE_SNIPPET_MAX) })),
  };
}

/** 一家在这批里的码各几次（ok=2 quota:429=1），只给日志 */
function tally(xs: readonly CompareOne[]): string {
  const n = new Map<string, number>();
  for (const x of xs) {
    const c = x.ok ? 'ok' : x.status === undefined ? x.code : `${x.code}:${x.status}`;
    n.set(c, (n.get(c) ?? 0) + 1);
  }
  return [...n].map(([c, k]) => `${c}=${k}`).join(' ');
}

/** 对比一批（见文件头）；密钥读不出当没存。回 {rows: [{query, brave, tavily, deepseek}]}，按请求里的顺序 */
export async function webCompare(deps: Pick<Deps, 'makeSearcher' | 'now' | 'projectKey' | 'log'>, queries: readonly string[]): Promise<Response> {
  const keyOf = (p: WebCompareName) => deps.projectKey(p).catch(() => undefined);
  const [kb, kt, kd] = await Promise.all([keyOf('brave'), keyOf('tavily'), keyOf('deepseek')]);
  const today = wallOf(deps.now(), COMPARE_TZ).today;
  const rows: { query: string; brave: CompareOne; tavily: CompareOne; deepseek: CompareOne }[] = [];
  for (const query of queries) {
    const [brave, tavily, deepseek] = await Promise.all([
      compareOne(deps, 'brave', kb, query, today), compareOne(deps, 'tavily', kt, query, today), compareOne(deps, 'deepseek', kd, query, today),
    ]);
    rows.push({ query, brave, tavily, deepseek });
  }
  deps.log(`admin_web_compare n=${queries.length}`);
  deps.log(`admin_web_compare brave ${tally(rows.map((r) => r.brave))}`);
  deps.log(`admin_web_compare tavily ${tally(rows.map((r) => r.tavily))}`);
  deps.log(`admin_web_compare deepseek ${tally(rows.map((r) => r.deepseek))}`);
  return json(200, { rows });
}
