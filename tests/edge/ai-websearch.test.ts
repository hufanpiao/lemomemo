// 联网搜索的四家适配器和组合方式（R-492 第 2 段；负责人 11-23 弹窗：Brave Search API、Tavily；11-24：DeepSeek + Brave + Naver 同时搜，都挂退 Tavily，
// 11-25 改成四家各自打勾；supabase/functions/_shared/ai/websearch.ts）。
// fetch 是假的，不连外网，密钥是假值。钉住：地址整串、密钥只在请求头、查询词和语言参数进查询串或请求体、失败归类、结果解析、
// 几处名单一致、Naver 密钥格式。几家怎么组合（按顺序退、勾的几家同时搜、旧设置换算）在 ai-websearch-mix.test.ts。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_PICKS as SHARED_PICKS, NAVER_KEY_RE as SHARED_NAVER_RE, WEB_COMPARE_PROVIDERS, WEB_COMPARE_QUERY_MAX, WEB_KEY_OWNERS as SHARED_KEY_OWNERS,
  WEB_PROVIDERS as SHARED_WEB,
} from '../../shared/schema/ai-provider.ts';
import type { WebSearchRequest } from '../../supabase/functions/_shared/ai/provider.ts';
import {
  BRAVE_URL, braveFail, BraveSearcher, COMPARE_WEB, DEEPSEEK_QUERY_MAX, DEEPSEEK_SEARCH_URL, deepseekBody, deepseekFail, DeepSeekSearcher,
  DEFAULT_WEB_PICKS, FRESH_BRAVE, FRESH_DAYS, FRESH_TAVILY, LANG_PARAMS, makeSearcher, NAVER_KEY_RE, NAVER_URL, naverFail, naverKeyOf,
  NaverSearcher, plainOf, readResults, TAVILY_URL, tavilyFail, TavilySearcher, WEB_BACKUP, WEB_KEY_OWNERS,
  WEB_PROVIDERS, WEB_RESULTS_MAX, webQueryOf,
} from '../../supabase/functions/_shared/ai/websearch.ts';

const KEY = 'fake-websearch-0000';
const NAVER_KEY = 'fakeNaverId01:fakeNaverSecret01';
type Sent = { url: string; method: string; headers: Record<string, string>; body: string | null; redirect: unknown };
function fake(reply: unknown, status = 200) {
  const sent: Sent[] = [];
  const fn = async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? init.body : null, redirect: init.redirect });
    return new Response(JSON.stringify(reply), { status });
  };
  return { fn, sent };
}
const Q: WebSearchRequest = { query: '首尔 明天 天气', lang: 'zh', timeoutMs: 5_000 };

describe('联网搜索：几处名单一致', () => {
  it('websearch.ts 和 shared 的四家、有自己密钥的三家、没设置过时勾的几家一字不差；搜索密钥三家都在最新迁移 20261124130000 的 ai_key_name_ok 里', () => {
    expect([...WEB_PROVIDERS]).toEqual(['deepseek', 'brave', 'naver', 'tavily']);
    expect([...SHARED_WEB]).toEqual([...WEB_PROVIDERS]);
    expect([...WEB_KEY_OWNERS]).toEqual(['brave', 'tavily', 'naver']);
    expect([...SHARED_KEY_OWNERS]).toEqual([...WEB_KEY_OWNERS]);
    // DeepSeek 搜索复用对话那家的 ai_key_deepseek（负责人 11-24：不新建密钥）
    expect(WEB_KEY_OWNERS as readonly string[]).not.toContain('deepseek');
    // 没设置过时勾的几家（11-25 起各自打勾）
    expect([...DEFAULT_WEB_PICKS]).toEqual(['deepseek', 'brave', 'naver']);
    expect([...SHARED_PICKS]).toEqual([...DEFAULT_WEB_PICKS]);
    expect(WEB_BACKUP).toBe('tavily');
    expect(SHARED_NAVER_RE.source).toBe(NAVER_KEY_RE.source);
    // 负责人 11-25 选“加这条迁移”：三家的 Vault 名都在最新的 ai_key_name_ok（20261124130000）里
    const sql = readFileSync(join(__dirname, '../../supabase/migrations/20261124130000_ai_web_naver_key.sql'), 'utf8');
    for (const p of WEB_KEY_OWNERS) expect(sql).toContain(`'ai_key_${p}'`);
  });
  it('地址按官方文档写死整串', () => {
    expect(BRAVE_URL).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(TAVILY_URL).toBe('https://api.tavily.com/search');
    expect(DEEPSEEK_SEARCH_URL).toBe('https://api.deepseek.com/v1/tools/search');
    expect(NAVER_URL).toBe('https://naverapihub.apigw.ntruss.com/search/v1/webkr');
  });
  it('对比用的三家（负责人 11-24）：websearch.ts 和 shared 一致；query 上限两边一样', () => {
    expect([...COMPARE_WEB]).toEqual(['brave', 'tavily', 'deepseek']);
    expect([...WEB_COMPARE_PROVIDERS]).toEqual([...COMPARE_WEB]);
    expect(WEB_COMPARE_QUERY_MAX).toBe(DEEPSEEK_QUERY_MAX);
  });
});

describe('DeepSeek 搜索（对比用，负责人 11-24）', () => {
  const T = '2026-11-24';
  it('POST，Bearer 密钥只在请求头；语言、时效写成 lang:、after: 操作符（after 是今天往前 7 天）；不跟跳转；snippet 当摘要、date 原样带上', async () => {
    const f = fake({ results: [
      { title: '<b>首尔</b>天气', url: 'https://weather.example/a', snippet: '明天 <b>有雨</b>', summary: '长摘要不要', site_name: 'X', date: '2026-11-24T08:00:00+09:00', rerank_score: 2.5, authority: 3 },
      { title: '不收', url: 'http://plain.example/b', snippet: 'http', date: null },
      { title: '', url: 'https://kma.example/c', snippet: '', date: null },
    ] });
    const r = await new DeepSeekSearcher(KEY, f.fn).search({ ...Q, today: T });
    const s = f.sent[0];
    expect([s?.url, s?.method]).toEqual([DEEPSEEK_SEARCH_URL, 'POST']);
    expect(s?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(s?.body).not.toContain(KEY);
    expect(s?.redirect).toBe('error');
    expect(JSON.parse(s?.body ?? '{}')).toEqual({ query: '首尔 11月25日 天气 lang:zh after:2026-11-17', count: WEB_RESULTS_MAX });
    expect(FRESH_DAYS).toBe(7);
    expect(r).toEqual({
      ok: true, by: 'deepseek', sent: { lang: 'zh', dated: true, fresh: true, chars: 12 },
      sources: [
        { title: '首尔天气', url: 'https://weather.example/a', site: 'weather.example', text: '明天 有雨', date: '2026-11-24T08:00:00+09:00' },
        { title: 'kma.example', url: 'https://kma.example/c', site: 'kma.example', text: '' },
      ],
    });
  });
  it('韩文 lang:ko；英文不带 lang；时效不强、或没给今天，不带 after', () => {
    expect(deepseekBody(webQueryOf({ query: '서울 내일 날씨', today: T }), T).query).toBe('서울 11월 25일 날씨 lang:ko after:2026-11-17');
    expect(LANG_PARAMS.en.deepseekLang).toBe(null);
    expect(deepseekBody(webQueryOf({ query: 'Gyeongbokgung opening hours' }), T)).toEqual({ query: 'Gyeongbokgung opening hours', count: WEB_RESULTS_MAX });
    expect(deepseekBody(webQueryOf({ query: '首尔 天气' }), undefined).query).toBe('首尔 天气 lang:zh');
    expect(deepseekBody(webQueryOf({ query: '景福宫 门票' }), T).query).toBe('景福宫 门票 lang:zh');
  });
  it(`连操作符不超过 ${DEEPSEEK_QUERY_MAX} 字：超了截搜索词本身，操作符留着`, () => {
    const zh = deepseekBody(webQueryOf({ query: '字'.repeat(200) }), T).query as string;
    expect([...zh].length).toBe(DEEPSEEK_QUERY_MAX);
    expect(zh.endsWith(' lang:zh')).toBe(true);
    const en = deepseekBody(webQueryOf({ query: 'a'.repeat(200) }), T).query as string;
    expect(en).toBe('a'.repeat(DEEPSEEK_QUERY_MAX));
  });
  it('失败归类：402 余额不足当每天额度、429 限速当每分钟；401 / 400 / 504 带状态码当 error；回包没有 results 当空结果', async () => {
    expect(await new DeepSeekSearcher(KEY, fake({ error: { code: 'insufficient_balance', message: 'x' } }, 402).fn).search(Q))
      .toEqual({ ok: false, reason: 'quota', status: 402, quotaKind: 'day', retryMs: null });
    expect(deepseekFail(429, null)).toEqual({ ok: false, reason: 'quota', status: 429, quotaKind: 'minute', retryMs: null });
    expect(deepseekFail(401, null)).toEqual({ ok: false, reason: 'error', status: 401 });
    expect(deepseekFail(400, null)).toEqual({ ok: false, reason: 'error', status: 400 });
    expect(deepseekFail(504, null)).toEqual({ ok: false, reason: 'error', status: 504 });
    expect(await new DeepSeekSearcher(KEY, fake({}).fn).search(Q)).toMatchObject({ ok: true, by: 'deepseek', sources: [] });
  });
});

describe('Brave', () => {
  it('GET，查询词和语言、国家进查询串（编码），密钥只在 x-subscription-token；不跟跳转；结果去标记、只收 https、同网址合并、摘要挂在这一条上', async () => {
    const f = fake({ web: { results: [
      { title: '<strong>서울</strong> 날씨', url: 'https://weather.naver.com/a', description: '내일 <strong>비</strong> &amp; 바람' },
      { title: 'x', url: 'http://plain.example/b', description: 'http 不收' },
      { title: '重复', url: 'https://weather.naver.com/a', description: '同网址' },
      { title: '', url: 'https://www.kma.go.kr/c', description: '' },
    ] } });
    const r = await new BraveSearcher(KEY, f.fn).search(Q);
    const s = f.sent[0];
    expect(s?.method).toBe('GET');
    expect(s?.url.startsWith(`${BRAVE_URL}?`)).toBe(true);
    const qs = new URL(s?.url ?? 'https://x').searchParams;
    expect([qs.get('q'), qs.get('count'), qs.get('safesearch'), qs.get('search_lang'), qs.get('country')])
      .toEqual(['首尔 明天 天气', String(WEB_RESULTS_MAX), 'moderate', 'zh-hans', 'CN']);
    expect(s?.url).not.toContain(KEY);
    expect(s?.headers['x-subscription-token']).toBe(KEY);
    expect(s?.redirect).toBe('error');
    expect(r).toMatchObject({
      ok: true,
      by: 'brave',
      sources: [
        { title: '서울 날씨', url: 'https://weather.naver.com/a', site: 'weather.naver.com', text: '내일 비 & 바람' },
        { title: 'www.kma.go.kr', url: 'https://www.kma.go.kr/c', site: 'www.kma.go.kr', text: '' },
      ],
    });
  });
  it('韩文搜索词：search_lang=ko、country=KR', async () => {
    const f = fake({ web: { results: [] } });
    await new BraveSearcher(KEY, f.fn).search({ ...Q, query: '서울 내일 날씨' });
    const qs = new URL(f.sent[0]?.url ?? 'https://x').searchParams;
    expect([qs.get('search_lang'), qs.get('country')]).toEqual([LANG_PARAMS.ko.braveLang, LANG_PARAMS.ko.braveCountry]);
    expect([LANG_PARAMS.ko.braveLang, LANG_PARAMS.ko.braveCountry]).toEqual(['ko', 'KR']);
  });
  it('失败归类：429 当额度（认不出哪种）；422 / 401 / 500 带状态码当 error；回包没有 web 当空结果', async () => {
    expect(await new BraveSearcher(KEY, fake({}, 429).fn).search(Q)).toMatchObject({ ok: false, reason: 'quota', quotaKind: 'unknown', status: 429 });
    expect(await new BraveSearcher(KEY, fake({ error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } }, 422).fn).search(Q)).toEqual({ ok: false, reason: 'error', status: 422 });
    expect(braveFail(500, null)).toEqual({ ok: false, reason: 'error', status: 500 });
    expect(await new BraveSearcher(KEY, fake({ type: 'search' }).fn).search(Q)).toMatchObject({ ok: true, by: 'brave', sources: [] });
  });
});

describe('Tavily', () => {
  it('POST，Bearer 密钥，请求体只这几项（不要 Tavily 自己的 AI 答案；country 按界面语言）；content 当摘要', async () => {
    const f = fake({ results: [{ title: '天气', url: 'https://t.example/a', content: '明天有雨', score: 0.9 }] });
    const r = await new TavilySearcher(KEY, f.fn).search(Q);
    const s = f.sent[0];
    expect([s?.url, s?.method]).toEqual([TAVILY_URL, 'POST']);
    expect(s?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(s?.body ?? '{}')).toEqual({
      query: '首尔 明天 天气', max_results: WEB_RESULTS_MAX, search_depth: 'basic', topic: 'general', include_answer: false, country: 'china', time_range: FRESH_TAVILY,
    });
    expect(s?.redirect).toBe('error');
    expect(r).toMatchObject({ ok: true, by: 'tavily', sources: [{ title: '天气', url: 'https://t.example/a', site: 't.example', text: '明天有雨' }] });
    const k = fake({ results: [] });
    await new TavilySearcher(KEY, k.fn).search({ ...Q, query: '서울 날씨' });
    expect(JSON.parse(k.sent[0]?.body ?? '{}').country).toBe('south korea');
  });
  it('失败归类：429 每分钟限速；432 / 433 套餐和按量上限当每天额度；401 带状态码当 error', () => {
    expect(tavilyFail(429, null)).toMatchObject({ reason: 'quota', quotaKind: 'minute' });
    expect(tavilyFail(432, null)).toMatchObject({ reason: 'quota', quotaKind: 'day' });
    expect(tavilyFail(433, null)).toMatchObject({ reason: 'quota', quotaKind: 'day' });
    expect(tavilyFail(401, null)).toEqual({ ok: false, reason: 'error', status: 401 });
  });
});

describe('Naver（NAVER API HUB 网页搜索，11-24）', () => {
  it('GET，查询词进查询串（display=5、start=1、format=json），Client ID、Secret 分别只在两个请求头；不跟跳转；items 的 <b> 去掉、link 当网址', async () => {
    const f = fake({ lastBuildDate: 'x', total: 2, start: 1, display: 2, items: [
      { title: '<b>서울</b> 날씨', link: 'https://weather.naver.com/today', description: '내일 <b>비</b>' },
      { title: '중복', link: 'https://weather.naver.com/today', description: '같은 주소' },
    ] });
    const r = await new NaverSearcher(NAVER_KEY, f.fn).search({ ...Q, query: '서울 날씨' });
    const s = f.sent[0];
    expect(s?.method).toBe('GET');
    expect(s?.url.startsWith(`${NAVER_URL}?`)).toBe(true);
    const qs = new URL(s?.url ?? 'https://x').searchParams;
    expect([qs.get('query'), qs.get('display'), qs.get('start'), qs.get('format')]).toEqual(['서울 날씨', String(WEB_RESULTS_MAX), '1', 'json']);
    expect([s?.headers['x-ncp-apigw-api-key-id'], s?.headers['x-ncp-apigw-api-key']]).toEqual(['fakeNaverId01', 'fakeNaverSecret01']);
    expect(s?.url).not.toContain('fakeNaver');
    expect(s?.redirect).toBe('error');
    expect(r).toMatchObject({ ok: true, by: 'naver', sources: [{ title: '서울 날씨', url: 'https://weather.naver.com/today', site: 'weather.naver.com', text: '내일 비' }] });
    expect(r.ok && r.sources.length).toBe(1);
  });
  it('密钥格式：一个值“id:secret”，两段都不能空、不能再带冒号；格式不对建不出来', () => {
    expect(naverKeyOf('abc:def')).toEqual({ id: 'abc', secret: 'def' });
    for (const bad of ['abcdef', ':def', 'abc:', 'a:b:c', 'ab c:def']) expect(naverKeyOf(bad), bad).toBe(null);
    expect(() => new NaverSearcher('nocolon-key', fake({}).fn)).toThrow('no_key');
  });
  it('失败归类：429 超出每天额度当 quota day；401 / 403 / 500 带状态码当 error；回包没有 items 当空结果', async () => {
    expect(await new NaverSearcher(NAVER_KEY, fake({ errorCode: '429' }, 429).fn).search(Q)).toEqual({ ok: false, reason: 'quota', status: 429, quotaKind: 'day', retryMs: null });
    expect(naverFail(401, null)).toEqual({ ok: false, reason: 'error', status: 401 });
    expect(naverFail(403, null)).toEqual({ ok: false, reason: 'error', status: 403 });
    expect(naverFail(500, null)).toEqual({ ok: false, reason: 'error', status: 500 });
    expect(await new NaverSearcher(NAVER_KEY, fake({}).fn).search(Q)).toMatchObject({ ok: true, by: 'naver', sources: [] });
  });
});

describe('搜索词加工：相对日子换成日期、语言跟搜索词走、时效强的只要最近的', () => {
  it('“明天”按用户时区的今天换成具体日期（中、韩、英各按自己的写法；跨月；没给今天不换）', () => {
    const T = '2026-11-23';
    expect(webQueryOf({ query: '首尔 明天 会下雨吗', today: T })).toEqual({ q: '首尔 11月24日 会下雨吗', lang: 'zh', dated: true, fresh: true });
    expect(webQueryOf({ query: '서울 내일 날씨', today: T })).toEqual({ q: '서울 11월 24일 날씨', lang: 'ko', dated: true, fresh: true });
    expect(webQueryOf({ query: 'Seoul weather tomorrow', today: T })).toEqual({ q: 'Seoul weather November 24', lang: 'en', dated: true, fresh: true });
    expect(webQueryOf({ query: '首尔 大后天 后天 今天', today: T }).q).toBe('首尔 11月26日 11月25日 11月23日');
    expect(webQueryOf({ query: '明天 天气', today: '2026-11-30' }).q).toBe('12月1日 天气');
    expect(webQueryOf({ query: '首尔 明天 天气' })).toEqual({ q: '首尔 明天 天气', lang: 'zh', dated: false, fresh: true });
    expect(webQueryOf({ query: '首尔 景福宫 门票', today: T })).toEqual({ q: '首尔 景福宫 门票', lang: 'zh', dated: false, fresh: false });
  });
  it('时效参数：时效强的 Brave 带 freshness、Tavily 带 time_range；不强的两家都不带；英文不限国家（Brave ALL，Tavily 不带 country）', async () => {
    const b = fake({ web: { results: [] } });
    const r = await new BraveSearcher(KEY, b.fn).search({ ...Q, query: '서울 내일 비', today: '2026-11-23' });
    const qs = new URL(b.sent[0]?.url ?? 'https://x').searchParams;
    expect([qs.get('q'), qs.get('freshness'), qs.get('search_lang'), qs.get('country')]).toEqual(['서울 11월 24일 비', FRESH_BRAVE, 'ko', 'KR']);
    expect(FRESH_BRAVE).toBe('pw');
    expect(r).toEqual({ ok: true, by: 'brave', sources: [], sent: { lang: 'ko', dated: true, fresh: true, chars: 12 } });
    const b2 = fake({ web: { results: [] } });
    await new BraveSearcher(KEY, b2.fn).search({ ...Q, query: 'Gyeongbokgung opening hours' });
    const qs2 = new URL(b2.sent[0]?.url ?? 'https://x').searchParams;
    expect([qs2.get('freshness'), qs2.get('search_lang'), qs2.get('country')]).toEqual([null, 'en', 'ALL']);
    const t = fake({ results: [] });
    await new TavilySearcher(KEY, t.fn).search({ ...Q, query: 'Seoul weather tomorrow', today: '2026-11-23' });
    expect(JSON.parse(t.sent[0]?.body ?? '{}')).toEqual({
      query: 'Seoul weather November 24', max_results: WEB_RESULTS_MAX, search_depth: 'basic', topic: 'general', include_answer: false, time_range: FRESH_TAVILY,
    });
    expect(FRESH_TAVILY).toBe('week');
    const t2 = fake({ results: [] });
    await new TavilySearcher(KEY, t2.fn).search({ ...Q, query: '景福宫 门票' });
    expect(JSON.parse(t2.sent[0]?.body ?? '{}')).not.toHaveProperty('time_range');
  });
});

describe('结果解析和建适配器', () => {
  it(`最多 ${WEB_RESULTS_MAX} 条；摘要这里不截字（只在 takeWeb 截一次）；plainOf 给了上限才截、去标记`, () => {
    const long = '字'.repeat(900);
    const rows = Array.from({ length: WEB_RESULTS_MAX + 3 }, (_, i) => ({ title: `t${i}`, url: `https://s${i}.example/`, snippet: long }));
    const out = readResults(rows);
    expect(out.length).toBe(WEB_RESULTS_MAX);
    expect(out[0]?.text).toBe(long);
    expect(plainOf('<b>一二三四五</b>', 3)).toBe('一二三');
    expect(plainOf('<b>一二三四五</b>')).toBe('一二三四五');
    expect(plainOf(5, 3)).toBe('');
  });
  it('makeSearcher：没密钥、Naver 密钥格式不对回 null；四家各建各的', () => {
    const f = fake({}).fn;
    expect(makeSearcher('brave', '', f)).toBe(null);
    expect(makeSearcher('tavily', null, f)).toBe(null);
    expect(makeSearcher('brave', KEY, f)?.name).toBe('brave');
    expect(makeSearcher('tavily', KEY, f)?.name).toBe('tavily');
    expect(makeSearcher('deepseek', KEY, f)?.name).toBe('deepseek');
    expect(makeSearcher('naver', NAVER_KEY, f)?.name).toBe('naver');
    expect(makeSearcher('naver', KEY, f)).toBe(null);
  });
  it('网页日期：Brave 的 page_age、Tavily 的 published_date 是字符串就挂在来源上，不是字符串不带', async () => {
    const b = await new BraveSearcher(KEY, fake({ web: { results: [
      { title: 'a', url: 'https://a.example/', description: '', page_age: '2026-11-20T00:00:00' },
      { title: 'b', url: 'https://b.example/', description: '', page_age: 5 },
    ] } }).fn).search(Q);
    expect(b.ok && b.sources.map((s) => s.date)).toEqual(['2026-11-20T00:00:00', undefined]);
    const t = await new TavilySearcher(KEY, fake({ results: [{ title: 't', url: 'https://t.example/', content: '', published_date: 'Mon, 23 Nov 2026 01:00:00 GMT' }] }).fn).search(Q);
    expect(t.ok && t.sources[0]?.date).toBe('Mon, 23 Nov 2026 01:00:00 GMT');
  });
});
