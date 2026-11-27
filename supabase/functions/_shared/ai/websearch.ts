// 联网搜索的四家适配器和组合方式（R-492 第 2 段；负责人 11-23 弹窗：不用谷歌搜索接地，改接 Brave Search API 和 Tavily；
// 11-24 负责人：DeepSeek + Brave + Naver 同时搜、AI 汇总，三家都挂退 Tavily；11-25 改成四家各自打勾、勾几家同时搜几家，见 webPicksOf）。
// 只做“搜”：拿到网页的标题、网址、摘要就交回（provider.ts 的 WebSearchResult），读和概括交给“对话和整理”那家模型（ai-chat 的 web_search 工具结果）。
// • Brave：GET https://api.search.brave.com/res/v1/web/search?q=…&count=…&safesearch=moderate&search_lang=…&country=…[&freshness=pw]，密钥放请求头 X-Subscription-Token；
//   回 web.results[]：title、url、description（摘要，带 <strong> 这类标记，这里去掉）、extra_snippets（没要，不读）。
// • Tavily：POST https://api.tavily.com/search，密钥放 Authorization: Bearer；请求体 {query, max_results, search_depth: 'basic', topic: 'general', include_answer: false, country?, time_range?}；
//   回 results[]：title、url、content（摘要）、score。include_answer 关着：概括由我们自己的模型做，不要 Tavily 的 AI 答案。
// • DeepSeek 搜索（11-24 先给对比用，同日负责人定进联网）：POST https://api.deepseek.com/v1/tools/search，
//   密钥（对话那家的 ai_key_deepseek）放 Authorization: Bearer；请求体 {query（1～128 字，语言、时效写成 lang:zh / lang:ko、after:YYYY-MM-DD 操作符）, count}；
//   回 results[]：title、url、snippet（摘要）、summary、site_name、date（RFC3339 或 null）、rerank_score、authority，这里只取 title、url、snippet、date。
//   402 余额不足、429 限速当 quota；401 / 403 密钥不对；按成功请求计费（空结果、失败不收）。
// • Naver（NAVER API HUB 网页搜索，11-24）：GET https://naverapihub.apigw.ntruss.com/search/v1/webkr?query=…&display=…&start=1&format=json，
//   密钥放请求头 X-NCP-APIGW-API-KEY-ID（Client ID）、X-NCP-APIGW-API-KEY（Client Secret）；两段存成一个值 “id:secret”（Vault 的 ai_key_naver，naverKeyOf 拆，
//   格式不对当没密钥）。回 items[]：title、description（带 <b> 标记，这里去掉）、link；没有日期、语言、时效参数（搜索词照样按“搜索词加工”①换日期）。
//   官方文档：401 认证失败、403 调用不被允许、429 超出每天额度（当 quota day），其余 error 带状态码。
// • 日期：各家给的网页日期（Brave page_age、Tavily published_date、DeepSeek date）是字符串就挂在来源上（WebSource.date），对话那边不读它。
// • 语言：搜索词的文字（见下面“搜索词加工”②）→ Brave 的 search_lang、country，Tavily 的 country，DeepSeek 的 lang:（LANG_PARAMS 一张表，独立评审第 5 条）。
// • 各家的地址都写死整串（不拼路径），查询词只进查询串（Brave，URLSearchParams 编码）或请求体（Tavily、DeepSeek）；密钥只放请求头，不进 URL、不进日志。
// • 失败归类（只带状态码和固定词，不带正文）：429 当 quota（Brave 每秒限速、每月额度都回 429，认不出是哪种，记 unknown；Tavily 429 是限速，记 minute），
//   Tavily 432 / 433（套餐额度、按量付费上限）当 quota day；其余一律 error 带状态码（401 / 403 / 422 是密钥不对，ai-provider 的试调据此分“密钥不对”）。
// • 结果：只收 https 的网址、不超过 URL_MAX、同一网址只留一条、最多 WEB_RESULTS_MAX 条；标题空的用网站名；摘要直接挂在这一条上（不另编下标），
//   这里只去标记不截字，截字只在 ai-chat/tools.ts 的 takeWeb 截一次（独立评审第 7、8 条）。
// • 几家怎么组合（按顺序退、勾的几家同时搜、全挂退一家没勾的）在 websearch-mix.ts。
// • 搜索词加工（11-23 负责人问“明天首尔会下雨吗”，Brave 只回了“Seoul weather in November”这类月平均页，日志只有 by=brave sources=5、cited=1）：
//   ① 相对日子（今天、明天、后天、昨天、前天，내일、오늘…，today、tomorrow…）按用户时区的今天（req.today）换成具体日期写进搜索词（dated）：
//      搜索引擎不知道用户的“明天”是哪天，只能回不分日子的页面；
//   ② 语言、国家跟搜索词的文字走（有韩文字母 → 韩国；有汉字 → 中文；都没有 → 英文、不限国家），不再跟界面语言：
//      中文界面问首尔，模型写了韩文或英文的搜索词，原来照样按 country=CN、search_lang=zh-hans 搜，偏到中文页；
//   ③ 时效强的（换过日期的，或词里有天气、新闻、比分、股价、汇率这类）只要最近一周的网页（fresh）：Brave freshness=pw，Tavily time_range=week，
//      DeepSeek after:<今天往前 7 天>（没给 today 就不带）。
//   日志只记加工结果的码（lang、dated、fresh、字数，见 core.ts），不记搜索词本身（A23）。
// fetch 注入：单测传假的，函数传 wire.ts 的 fetchOut。
import { isObj } from '../obj.ts';
import { getJson, post, type FailOf, type Fetch } from './compat.ts';
import { TITLE_MAX, URL_MAX, type WebSearcher, type WebSearchRequest, type WebSearchResult, type WebSent, type WebSource } from './provider.ts';

export const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
export const TAVILY_URL = 'https://api.tavily.com/search';
export const DEEPSEEK_SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';
export const NAVER_URL = 'https://naverapihub.apigw.ntruss.com/search/v1/webkr';

/** 联网搜索的四家（和 shared/schema/ai-provider.ts 的 WEB_PROVIDERS 一致，测试钉住） */
export const WEB_PROVIDERS = ['deepseek', 'brave', 'naver', 'tavily'] as const;
export type WebProviderName = (typeof WEB_PROVIDERS)[number];

/**
 * 有自己搜索密钥的三家（Vault 的 ai_key_<名>，管理员页“密钥”卡各一行；和 shared 的 WEB_KEY_OWNERS、迁移 20261124130000 的 private.ai_key_name_ok 一致，测试钉住）。
 * DeepSeek 搜索不在这里：复用对话那家的 ai_key_deepseek（负责人 11-24：不新建密钥）
 */
export const WEB_KEY_OWNERS = ['brave', 'tavily', 'naver'] as const;
export type WebKeyOwner = (typeof WEB_KEY_OWNERS)[number];

/** 没设置过时勾的几家（和 shared 的 DEFAULT_WEB_PICKS 一致）；勾的几家全挂时先退这家（怎么组合见 websearch-mix.ts） */
export const DEFAULT_WEB_PICKS = ['deepseek', 'brave', 'naver'] as const satisfies readonly WebProviderName[];
export const WEB_BACKUP = 'tavily' satisfies WebProviderName;

/**
 * 联网搜索勾了哪几家（app_config.ai.web；负责人 11-25：“每个服务商后面可以单独打勾来框选，选几个就用几个”）。现在写成数组（如 ["deepseek","brave"]），
 * 旧值照认：'multi'（原来的三家联合）读成 DEFAULT_WEB_PICKS，单家字符串读成那一家；数组只留认得的、去重、按 WEB_PROVIDERS 的顺序排；
 * 没写、认不出、数组里一家都认不出的当 DEFAULT_WEB_PICKS。不加迁移、不改表
 */
export function webPicksOf(v: unknown): WebProviderName[] {
  const raw: unknown[] = Array.isArray(v) ? v : v === 'multi' ? [...DEFAULT_WEB_PICKS] : [v];
  const got = WEB_PROVIDERS.filter((p) => raw.includes(p));
  return got.length > 0 ? got : [...DEFAULT_WEB_PICKS];
}

/** 对比用的三家（负责人 11-24：按照3你调查一下，对比一下）：只给 ai-provider 的 admin_web_compare 用，回包形状固定这三家 */
export const COMPARE_WEB = ['brave', 'tavily', 'deepseek'] as const satisfies readonly WebProviderName[];
export type WebCompareName = (typeof COMPARE_WEB)[number];

/** 每家一次最多要几条网页 */
export const WEB_RESULTS_MAX = 5;

/**
 * 搜索词的语言 → 各家的语言、国家参数（Brave：search_lang、country 两位码，ALL 是不限国家；
 * Tavily：country 写英文全名小写，只在 topic general 时有效；英文不限国家就不带；
 * DeepSeek：搜索词里的 lang: 操作符，文档只写了 zh、ko，英文不带）
 */
export const LANG_PARAMS = {
  zh: { braveLang: 'zh-hans', braveCountry: 'CN', tavilyCountry: 'china', deepseekLang: 'zh' },
  ko: { braveLang: 'ko', braveCountry: 'KR', tavilyCountry: 'south korea', deepseekLang: 'ko' },
  en: { braveLang: 'en', braveCountry: 'ALL', tavilyCountry: null, deepseekLang: null },
} as const satisfies Record<string, { braveLang: string; braveCountry: string; tavilyCountry: string | null; deepseekLang: string | null }>;
export type QueryLang = keyof typeof LANG_PARAMS;

/** 时效强的只要最近这么久的网页：Brave freshness、Tavily time_range（官方文档的取值） */
export const FRESH_BRAVE = 'pw';
export const FRESH_TAVILY = 'week';
/** DeepSeek 没有“最近一周”参数，只有 after:YYYY-MM-DD：用户时区的今天往前这么多天 */
export const FRESH_DAYS = 7;
/** DeepSeek 的 query 最多这么多字（官方文档 1～128，含 lang:、after: 操作符） */
export const DEEPSEEK_QUERY_MAX = 128;

/** 相对日子的词 → 差几天、日期写成哪种文字（长的写在前面：“大后天”先于“后天”） */
const DAY_WORDS: readonly { re: RegExp; days: number; style: QueryLang }[] = [
  { re: /大后天/g, days: 3, style: 'zh' }, { re: /后天/g, days: 2, style: 'zh' }, { re: /明天/g, days: 1, style: 'zh' },
  { re: /今天/g, days: 0, style: 'zh' }, { re: /前天/g, days: -2, style: 'zh' }, { re: /昨天/g, days: -1, style: 'zh' },
  { re: /글피/g, days: 3, style: 'ko' }, { re: /모레/g, days: 2, style: 'ko' }, { re: /내일/g, days: 1, style: 'ko' },
  { re: /오늘/g, days: 0, style: 'ko' }, { re: /그저께|그제/g, days: -2, style: 'ko' }, { re: /어제/g, days: -1, style: 'ko' },
  { re: /\bday after tomorrow\b/gi, days: 2, style: 'en' }, { re: /\btomorrow\b/gi, days: 1, style: 'en' },
  { re: /\btoday\b/gi, days: 0, style: 'en' }, { re: /\byesterday\b/gi, days: -1, style: 'en' },
];

/** 时效强的词（天气、新闻、比分、股价、汇率；中、韩、英） */
const FRESH_WORDS = /天气|气温|下雨|下雪|降雨|预报|新闻|比分|赛果|股价|汇率|날씨|기온|강수|예보|뉴스|스코어|경기 결과|주가|환율|weather|forecast|rain|news|score|stock price|exchange rate/i;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** today（YYYY-MM-DD）加 days 天（UTC 零点）；today 不像日子回 null */
function shiftDay(today: string, days: number): Date | null {
  const m = ISO_DAY.exec(today);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)) : null;
}

/** today 加 days 天，写成 YYYY-MM-DD（DeepSeek 的 after:） */
const isoDay = (today: string, days: number): string | null => shiftDay(today, days)?.toISOString().slice(0, 10) ?? null;

/** today（YYYY-MM-DD）加 days 天，写成 style 那种文字（11月24日 / 11월 24일 / November 24）；today 不像日子回 null */
function dayText(today: string, days: number, style: QueryLang): string | null {
  const d = shiftDay(today, days);
  if (!d) return null;
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return style === 'zh' ? `${mo}月${day}日` : style === 'ko' ? `${mo}월 ${day}일` : `${d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${day}`;
}

/** 搜索词加工的结果（两家都按它发；日志只记 lang、dated、fresh 和字数） */
export interface WebQuery {
  q: string;
  lang: QueryLang;
  /** 换掉过相对日子 */
  dated: boolean;
  /** 只要最近一周的网页 */
  fresh: boolean;
}

/** 见文件头“搜索词加工” */
export function webQueryOf(req: Pick<WebSearchRequest, 'query' | 'today'>): WebQuery {
  let q = req.query;
  let dated = false;
  if (req.today !== undefined) {
    for (const w of DAY_WORDS) {
      const text = dayText(req.today, w.days, w.style);
      if (text === null) break;
      q = q.replace(w.re, () => {
        dated = true;
        return text;
      });
    }
  }
  q = q.replace(/\s+/g, ' ').trim();
  const lang: QueryLang = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(q) ? 'ko' : /[\u3400-\u9fff]/.test(q) ? 'zh' : 'en';
  return { q, lang, dated, fresh: dated || FRESH_WORDS.test(q) };
}

/** 这种语言用哪组参数（写成三元：check_backend F7 不许用变量当方括号里的键） */
const langOf = (lang: QueryLang): (typeof LANG_PARAMS)[QueryLang] => (lang === 'ko' ? LANG_PARAMS.ko : lang === 'zh' ? LANG_PARAMS.zh : LANG_PARAMS.en);

/** 日志用的加工结果（不带搜索词） */
const sentOf = (w: WebQuery): WebSent => ({ lang: w.lang, dated: w.dated, fresh: w.fresh, chars: [...w.q].length });

/** 只收 https（写成正则：deno-config 的锁扫描把字符串里的地址前缀当远程依赖） */
const HTTPS_URL = /^https:\/\/\S+$/i;

/** 去掉 HTML 标记和几个常见实体（Brave 的摘要带 <strong>），空白并成一个空格；给了 max 才截字 */
export function plainOf(s: unknown, max?: number): string {
  if (typeof s !== 'string') return '';
  const t = s
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => (e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === '#39' ? "'" : ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return max === undefined ? t : [...t].slice(0, max).join('');
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** 网页日期最多留几个字（各家给的是 ISO 8601 / RFC3339 一类，正常 30 字以内） */
export const DATE_MAX = 40;

/** 各家的结果行（title、url、摘要、日期）→ 来源（见文件头“结果”）；日期是字符串才带上 */
export function readResults(rows: readonly { title: unknown; url: unknown; snippet: unknown; date?: unknown }[]): WebSource[] {
  const sources: WebSource[] = [];
  for (const r of rows) {
    if (sources.length >= WEB_RESULTS_MAX) break;
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (!HTTPS_URL.test(url) || url.length > URL_MAX || sources.some((s) => s.url === url)) continue;
    const site = hostOf(url);
    const title = plainOf(r.title, TITLE_MAX);
    const date = plainOf(r.date, DATE_MAX);
    sources.push({ title: title === '' ? site : title, url, site, text: plainOf(r.snippet), ...(date !== '' ? { date } : {}) });
  }
  return sources;
}

const rowsAt = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** Brave 的失败归类（见文件头） */
export const braveFail: FailOf = (status) =>
  status === 429 ? { ok: false, reason: 'quota', status, quotaKind: 'unknown', retryMs: null } : { ok: false, reason: 'error', status };

/** Tavily 的失败归类（见文件头） */
export const tavilyFail: FailOf = (status) => {
  if (status === 429) return { ok: false, reason: 'quota', status, quotaKind: 'minute', retryMs: null };
  if (status === 432 || status === 433) return { ok: false, reason: 'quota', status, quotaKind: 'day', retryMs: null };
  return { ok: false, reason: 'error', status };
};

/** Brave 的查询串（单测核对键名） */
export const braveQuery = (w: WebQuery): URLSearchParams => new URLSearchParams({
  q: w.q, count: String(WEB_RESULTS_MAX), safesearch: 'moderate', search_lang: langOf(w.lang).braveLang, country: langOf(w.lang).braveCountry,
  ...(w.fresh ? { freshness: FRESH_BRAVE } : {}),
});

export class BraveSearcher implements WebSearcher {
  readonly name = 'brave';
  private readonly key: string;
  private readonly fetchFn: Fetch;
  constructor(key: string, fetchFn: Fetch) {
    if (!key) throw new Error('no_key');
    this.key = key;
    this.fetchFn = fetchFn;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult> {
    const w = webQueryOf(req);
    const r = await getJson(this.fetchFn, `${BRAVE_URL}?${braveQuery(w).toString()}`, { 'x-subscription-token': this.key }, req.timeoutMs, braveFail);
    if (!r.ok) return r;
    const web = isObj(r.body) ? r.body['web'] : null;
    const rows = rowsAt(isObj(web) ? web['results'] : null).map((x) => ({ title: x['title'], url: x['url'], snippet: x['description'], date: x['page_age'] }));
    return { ok: true, by: this.name, sources: readResults(rows), sent: sentOf(w) };
  }
}

/** Tavily 的请求体（单测核对键名） */
export const tavilyBody = (w: WebQuery): Record<string, unknown> => {
  const country = langOf(w.lang).tavilyCountry;
  return {
    query: w.q, max_results: WEB_RESULTS_MAX, search_depth: 'basic', topic: 'general', include_answer: false,
    ...(country !== null ? { country } : {}), ...(w.fresh ? { time_range: FRESH_TAVILY } : {}),
  };
};

export class TavilySearcher implements WebSearcher {
  readonly name = 'tavily';
  private readonly key: string;
  private readonly fetchFn: Fetch;
  constructor(key: string, fetchFn: Fetch) {
    if (!key) throw new Error('no_key');
    this.key = key;
    this.fetchFn = fetchFn;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult> {
    const w = webQueryOf(req);
    const r = await post(this.fetchFn, TAVILY_URL, { authorization: `Bearer ${this.key}` }, tavilyBody(w), req.timeoutMs, tavilyFail);
    if (!r.ok) return r;
    const rows = rowsAt(isObj(r.body) ? r.body['results'] : null).map((x) => ({ title: x['title'], url: x['url'], snippet: x['content'], date: x['published_date'] }));
    return { ok: true, by: this.name, sources: readResults(rows), sent: sentOf(w) };
  }
}

/** DeepSeek 搜索的失败归类（见文件头）：402 余额不足当每天额度、429 限速当每分钟；其余 error 带状态码（401 / 403 是密钥不对） */
export const deepseekFail: FailOf = (status) => {
  if (status === 402) return { ok: false, reason: 'quota', status, quotaKind: 'day', retryMs: null };
  if (status === 429) return { ok: false, reason: 'quota', status, quotaKind: 'minute', retryMs: null };
  return { ok: false, reason: 'error', status };
};

/**
 * DeepSeek 的请求体（单测核对键名）：语言、时效写成搜索词里的 lang:、after: 操作符（after 是 today 往前 FRESH_DAYS 天；没给 today 不带）；
 * 连操作符一共不超过 DEEPSEEK_QUERY_MAX 字，超了截搜索词本身。不要正文（need_content 默认关）、不带 ori_question（那是用户原话）
 */
export const deepseekBody = (w: WebQuery, today: string | undefined): Record<string, unknown> => {
  const lang = langOf(w.lang).deepseekLang;
  const after = w.fresh && today !== undefined ? isoDay(today, -FRESH_DAYS) : null;
  const ops = [lang !== null ? `lang:${lang}` : '', after !== null ? `after:${after}` : ''].filter((s) => s !== '').join(' ');
  const room = DEEPSEEK_QUERY_MAX - (ops === '' ? 0 : [...ops].length + 1);
  const q = [...w.q].slice(0, room).join('').trim();
  return { query: ops === '' ? q : `${q} ${ops}`, count: WEB_RESULTS_MAX };
};

export class DeepSeekSearcher implements WebSearcher {
  readonly name = 'deepseek';
  private readonly key: string;
  private readonly fetchFn: Fetch;
  constructor(key: string, fetchFn: Fetch) {
    if (!key) throw new Error('no_key');
    this.key = key;
    this.fetchFn = fetchFn;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult> {
    const w = webQueryOf(req);
    const r = await post(this.fetchFn, DEEPSEEK_SEARCH_URL, { authorization: `Bearer ${this.key}` }, deepseekBody(w, req.today), req.timeoutMs, deepseekFail);
    if (!r.ok) return r;
    const rows = rowsAt(isObj(r.body) ? r.body['results'] : null).map((x) => ({ title: x['title'], url: x['url'], snippet: x['snippet'], date: x['date'] }));
    return { ok: true, by: this.name, sources: readResults(rows), sent: sentOf(w) };
  }
}

/** Naver 的密钥：Client ID 和 Client Secret 用一个冒号连成一个值（两段都不含冒号、都是可见 ASCII；和 shared 的 NAVER_KEY_RE 一致，测试钉住） */
export const NAVER_KEY_RE = /^([\x21-\x39\x3b-\x7e]+):([\x21-\x39\x3b-\x7e]+)$/;
/** “id:secret” 拆成两段；格式不对回 null */
export function naverKeyOf(key: string): { id: string; secret: string } | null {
  const m = NAVER_KEY_RE.exec(key);
  return m && m[1] && m[2] ? { id: m[1], secret: m[2] } : null;
}

/** Naver 的失败归类（见文件头）：429 是超出每天额度；其余 error 带状态码（401 / 403 是密钥不对） */
export const naverFail: FailOf = (status) =>
  status === 429 ? { ok: false, reason: 'quota', status, quotaKind: 'day', retryMs: null } : { ok: false, reason: 'error', status };

/** Naver 的查询串（单测核对键名） */
export const naverQuery = (w: WebQuery): URLSearchParams => new URLSearchParams({ query: w.q, display: String(WEB_RESULTS_MAX), start: '1', format: 'json' });

export class NaverSearcher implements WebSearcher {
  readonly name = 'naver';
  private readonly id: string;
  private readonly secret: string;
  private readonly fetchFn: Fetch;
  constructor(key: string, fetchFn: Fetch) {
    const k = naverKeyOf(key);
    if (!k) throw new Error('no_key');
    this.id = k.id;
    this.secret = k.secret;
    this.fetchFn = fetchFn;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult> {
    const w = webQueryOf(req);
    const headers = { 'x-ncp-apigw-api-key-id': this.id, 'x-ncp-apigw-api-key': this.secret };
    const r = await getJson(this.fetchFn, `${NAVER_URL}?${naverQuery(w).toString()}`, headers, req.timeoutMs, naverFail);
    if (!r.ok) return r;
    const rows = rowsAt(isObj(r.body) ? r.body['items'] : null).map((x) => ({ title: x['title'], url: x['link'], snippet: x['description'] }));
    return { ok: true, by: this.name, sources: readResults(rows), sent: sentOf(w) };
  }
}

/** 建一家（没密钥、密钥格式不对回 null；ai-provider 的试调、对比也用它） */
export function makeSearcher(p: WebProviderName, key: string | null | undefined, fetchFn: Fetch): WebSearcher | null {
  if (!key) return null;
  try {
    return p === 'brave' ? new BraveSearcher(key, fetchFn)
      : p === 'tavily' ? new TavilySearcher(key, fetchFn)
      : p === 'naver' ? new NaverSearcher(key, fetchFn)
      : new DeepSeekSearcher(key, fetchFn);
  } catch {
    return null;
  }
}
