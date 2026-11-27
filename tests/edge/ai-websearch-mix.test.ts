// 联网搜索几家怎么组合（supabase/functions/_shared/ai/websearch-mix.ts；负责人 11-23 一家不行退另一家；11-24：DeepSeek + Brave + Naver 同时搜，
// 约 3 秒不等慢的，按网址去重合并交给模型汇总；11-25 改成四家各自打勾，勾几家同时搜几家，全挂退没勾的里有密钥的一家（先 Tavily））。
// 各家都是假的，不连外网。钉住：webChain 退到另一家和剩余时间、webFanout 同时发 / 不等慢的 / 去重合并 / 全挂回失败、webFor 旧设置换算 / 勾几家 / 退备用。
import { describe, expect, it } from 'vitest';
import type { WebSearcher, WebSearchRequest, WebSearchResult, WebSource } from '../../supabase/functions/_shared/ai/provider.ts';
import { readAiConfig } from '../../supabase/functions/_shared/ai/router.ts';
import { DEFAULT_WEB_PICKS, WEB_PROVIDERS, WEB_RESULTS_MAX, webPicksOf, type WebProviderName } from '../../supabase/functions/_shared/ai/websearch.ts';
import {
  backupOrder, mergeSources, urlKey, WEB_FANOUT_MS, WEB_MERGED_MAX, WEB_RETRY_MIN_MS, webChain, webFanout, webFor, webNeeds, type Sleep,
} from '../../supabase/functions/_shared/ai/websearch-mix.ts';

const Q: WebSearchRequest = { query: '首尔 明天 天气', lang: 'zh', timeoutMs: 5_000 };

describe('webChain：一家不行退到另一家', () => {
  const stub = (name: string, out: WebSearchResult, cost = 0, clock?: { t: number }) => {
    const calls: number[] = [];
    const s: WebSearcher = {
      name,
      async search(r) {
        calls.push(r.timeoutMs);
        if (clock) clock.t += cost;
        return out;
      },
    };
    return { s, calls };
  };
  const OK_B: WebSearchResult = { ok: true, by: 'tavily', sources: [] };
  const OK_A: WebSearchResult = { ok: true, by: 'brave', sources: [] };
  const BAD: WebSearchResult = { ok: false, reason: 'error', status: 500 };
  it('第一家的超时先给第二家留出 WEB_RETRY_MIN_MS；第一家失败试第二家，第二家拿到剩下的全部；by 是第二家；每家失败调一次 onFail', async () => {
    const clock = { t: 0 };
    const a = stub('brave', BAD, 1_000, clock);
    const b = stub('tavily', OK_B, 0, clock);
    const c = webChain([a.s, b.s], () => clock.t);
    const fails: [string, unknown][] = [];
    expect(c?.name).toBe('brave');
    const r = await c?.search({ ...Q, timeoutMs: 5_000, onFail: (by, f) => fails.push([by, f]) });
    expect(r).toEqual(OK_B);
    expect([a.calls, b.calls]).toEqual([[5_000 - WEB_RETRY_MIN_MS], [4_000]]);
    expect(fails).toEqual([['brave', BAD]]);
    const a2 = stub('brave', OK_A);
    const b2 = stub('tavily', OK_B);
    expect(await webChain([a2.s, b2.s], () => 0)?.search(Q)).toEqual(OK_A);
    expect(b2.calls).toEqual([]);
  });
  it('第一家挂起直到自己的超时（总时长减 WEB_RETRY_MIN_MS）：超时后照样退到第二家，第二家拿到留出的那段', async () => {
    const clock = { t: 0 };
    // 照真实适配器：挂到给它的 timeoutMs 才回 timeout（假时钟一次走完）
    const hang: WebSearcher = {
      name: 'brave',
      async search(r) {
        clock.t += r.timeoutMs;
        return { ok: false, reason: 'timeout', errName: 'TimeoutError' };
      },
    };
    const b = stub('tavily', OK_B, 0, clock);
    const fails: string[] = [];
    const r = await webChain([hang, b.s], () => clock.t)?.search({ ...Q, timeoutMs: 5_000, onFail: (by) => fails.push(by) });
    expect(r).toEqual(OK_B);
    expect(b.calls).toEqual([WEB_RETRY_MIN_MS]);
    expect(fails).toEqual(['brave']);
  });
  it('适配器抛异常也算这家失败：调 onFail、试下一家', async () => {
    const boom: WebSearcher = { name: 'brave', search: async () => { throw new TypeError('x'); } };
    const b = stub('tavily', OK_B);
    const fails: [string, unknown][] = [];
    expect(await webChain([boom, b.s], () => 0)?.search({ ...Q, onFail: (by, f) => fails.push([by, f]) })).toEqual(OK_B);
    expect(fails).toEqual([['brave', { ok: false, reason: 'error', errName: 'TypeError' }]]);
  });
  it(`剩下不到 ${WEB_RETRY_MIN_MS}ms 不试下一家，回第一家的失败；两家都失败各调一次 onFail、回最后一家的；一家都没有回 null`, async () => {
    const clock = { t: 0 };
    const a = stub('brave', BAD, 4_000, clock);
    const b = stub('tavily', OK_B);
    expect(await webChain([a.s, b.s], () => clock.t)?.search({ ...Q, timeoutMs: 5_000 })).toEqual(BAD);
    expect(b.calls).toEqual([]);
    const QUOTA: WebSearchResult = { ok: false, reason: 'quota', status: 432, quotaKind: 'day', retryMs: null };
    const fails: string[] = [];
    const two = webChain([stub('brave', BAD).s, stub('tavily', QUOTA).s], () => 0);
    expect(await two?.search({ ...Q, onFail: (by) => fails.push(by) })).toEqual(QUOTA);
    expect(fails).toEqual(['brave', 'tavily']);
    expect(webChain([], () => 0)).toBe(null);
  });
});

// ===== 三家联合、联网搜索方式（负责人 11-24）=====
const src = (url: string, title = url): WebSource => ({ title, url, site: new URL(url).hostname, text: `摘要 ${title}` });
const okOf = (by: string, urls: string[]): WebSearchResult => ({ ok: true, by, sources: urls.map((u) => src(u)), sent: { lang: 'zh', dated: false, fresh: false, chars: 4 } });
/** 假的一家：记下收到的 timeoutMs 和开始、结束的先后；hang 为 true 时一直不回 */
function fakeSearcher(name: string, out: WebSearchResult, log: string[] = [], hang = false) {
  const calls: number[] = [];
  const s: WebSearcher = {
    name,
    search(r) {
      calls.push(r.timeoutMs);
      log.push(`start ${name}`);
      if (hang) return new Promise<WebSearchResult>(() => {});
      return Promise.resolve().then(() => {
        log.push(`end ${name}`);
        return out;
      });
    },
  };
  return { s, calls };
}
/** 假的等待：记下等多久，过 20ms 真放行（快的几家在这之前早回来了） */
const sleepLog = (waits: number[]): Sleep => (ms, signal) => {
  waits.push(ms);
  return new Promise<void>((done) => {
    const id = setTimeout(done, 20);
    signal.addEventListener('abort', () => {
      clearTimeout(id);
      done();
    }, { once: true });
  });
};
const BAD: WebSearchResult = { ok: false, reason: 'error', status: 500 };

describe('webFanout：三家同时搜、不等慢的、去重合并', () => {
  it('三家同时发（三家都开始了才有一家回来），每家只给 WEB_FANOUT_MS；结果按家轮流取、按网址去重；by 是通了的几家', async () => {
    const log: string[] = [];
    const d = fakeSearcher('deepseek', okOf('deepseek', ['https://a.example/x', 'https://b.example/']), log);
    const b = fakeSearcher('brave', okOf('brave', ['https://www.A.example/x/', 'https://c.example/']), log);
    const n = fakeSearcher('naver', okOf('naver', ['https://d.example/#top', 'https://b.example']), log);
    const r = await webFanout([d.s, b.s, n.s], sleepLog([])).search({ ...Q, timeoutMs: 6_500 });
    expect(log.slice(0, 3)).toEqual(['start deepseek', 'start brave', 'start naver']);
    expect([d.calls, b.calls, n.calls]).toEqual([[WEB_FANOUT_MS], [WEB_FANOUT_MS], [WEB_FANOUT_MS]]);
    expect(WEB_FANOUT_MS).toBe(3_000);
    expect(r.ok && r.by).toBe('deepseek+brave+naver');
    // a.example/x 和 www.A.example/x/ 是同一页、b.example/ 和 b.example 是同一页：留先到的那条
    expect(r.ok && r.sources.map((x) => x.url)).toEqual(['https://a.example/x', 'https://d.example/#top', 'https://b.example/', 'https://c.example/']);
    expect(r.ok && r.sent).toEqual({ lang: 'zh', dated: false, fresh: false, chars: 4 });
  });
  it('约 3 秒还没回来的不等：挂起的那家当超时、调 onFail，回来的照样合并交回', async () => {
    const waits: number[] = [];
    const fails: [string, unknown][] = [];
    const d = fakeSearcher('deepseek', okOf('deepseek', []), [], true);
    const b = fakeSearcher('brave', okOf('brave', ['https://b.example/1']));
    const n = fakeSearcher('naver', BAD);
    const r = await webFanout([d.s, b.s, n.s], sleepLog(waits)).search({ ...Q, timeoutMs: 6_500, onFail: (by, f) => fails.push([by, f]) });
    expect(waits).toEqual([WEB_FANOUT_MS]);
    expect(r).toMatchObject({ ok: true, by: 'brave', sources: [{ url: 'https://b.example/1' }] });
    expect(fails).toEqual([['deepseek', { ok: false, reason: 'timeout', errName: 'TimeoutError' }], ['naver', BAD]]);
  });
  it('总时间不到 3 秒时每家只给剩下的；一家抛异常也只算这家失败', async () => {
    const waits: number[] = [];
    const d = fakeSearcher('deepseek', okOf('deepseek', ['https://a.example/']));
    const boom: WebSearcher = { name: 'brave', search: async () => { throw new TypeError('x'); } };
    const fails: string[] = [];
    const r = await webFanout([d.s, boom], sleepLog(waits)).search({ ...Q, timeoutMs: 2_000, onFail: (by) => fails.push(by) });
    expect([d.calls, waits]).toEqual([[2_000], [2_000]]);
    expect(r).toMatchObject({ ok: true, by: 'deepseek' });
    expect(fails).toEqual(['brave']);
  });
  it('三家都通但都没结果：算通（空结果交回，不退 Tavily）；三家都挂：回失败、每家各调一次 onFail', async () => {
    const empty = await webFanout([fakeSearcher('deepseek', okOf('deepseek', [])).s, fakeSearcher('brave', BAD).s], sleepLog([])).search(Q);
    expect(empty).toMatchObject({ ok: true, by: 'deepseek', sources: [] });
    const fails: string[] = [];
    const all = await webFanout(['deepseek', 'brave', 'naver'].map((p) => fakeSearcher(p, BAD).s), sleepLog([])).search({ ...Q, onFail: (by) => fails.push(by) });
    expect(all).toEqual(BAD);
    expect(fails).toEqual(['deepseek', 'brave', 'naver']);
  });
  it(`合并最多 ${WEB_MERGED_MAX} 条；urlKey 口径`, () => {
    const many = (h: string) => Array.from({ length: WEB_RESULTS_MAX }, (_, i) => src(`https://${h}.example/${i}`));
    const out = mergeSources([many('d'), many('b'), many('n')]);
    expect(out.length).toBe(WEB_MERGED_MAX);
    expect(out.slice(0, 3).map((x) => x.url)).toEqual(['https://d.example/0', 'https://b.example/0', 'https://n.example/0']);
    expect(urlKey('https://WWW.Kma.go.kr/a/b/?q=1#x')).toBe('kma.go.kr/a/b?q=1');
    expect(urlKey('not a url')).toBe('not a url');
  });
});

describe('webFor：勾了哪几家（负责人 11-25：各自打勾、勾几家同时搜几家；全挂退没勾的里有密钥的一家，先 Tavily；至少勾一家）', () => {
  /** 按家名给假的一家；out 没给的那家当没密钥（null） */
  const maker = (out: Partial<Record<WebProviderName, WebSearchResult>>, made: string[] = []) => (p: WebProviderName): WebSearcher | null => {
    const r = new Map(Object.entries(out)).get(p);
    if (!r) return null;
    made.push(p);
    return fakeSearcher(p, r).s;
  };
  it('旧设置换算（app_config.ai.web）：没写、认不出 → 默认三家；旧的 multi → 默认三家；旧的单家字符串 → 那一家；新的数组按 WEB_PROVIDERS 排、去重、丢认不出的', () => {
    expect([...DEFAULT_WEB_PICKS]).toEqual(['deepseek', 'brave', 'naver']);
    expect(readAiConfig({}).web).toEqual(['deepseek', 'brave', 'naver']);
    expect(readAiConfig({ web: 'bing' }).web).toEqual(['deepseek', 'brave', 'naver']);
    expect(readAiConfig({ web: 'multi' }).web).toEqual(['deepseek', 'brave', 'naver']);
    for (const p of WEB_PROVIDERS) expect(readAiConfig({ web: p }).web).toEqual([p]);
    expect(webPicksOf(['tavily', 'deepseek', 'tavily', 'bing'])).toEqual(['deepseek', 'tavily']);
    // 一家都不剩（空数组、全认不出）不当“全不勾”，回默认三家
    expect(webPicksOf([])).toEqual(['deepseek', 'brave', 'naver']);
    expect(webPicksOf(['bing', 3])).toEqual(['deepseek', 'brave', 'naver']);
  });
  it('勾了三家：三家同时搜、汇总三家；要的密钥是勾的三家加备用候选 Tavily', async () => {
    const made: string[] = [];
    const all = { deepseek: okOf('deepseek', ['https://a.example/']), brave: okOf('brave', ['https://b.example/']), naver: okOf('naver', ['https://c.example/']), tavily: okOf('tavily', ['https://t.example/']) };
    const r = await webFor(['deepseek', 'brave', 'naver'], maker(all, made), () => 0, sleepLog([]))?.search(Q);
    expect(r).toMatchObject({ ok: true, by: 'deepseek+brave+naver' });
    expect(r?.ok && r.sources.map((x) => x.site)).toEqual(['a.example', 'b.example', 'c.example']);
    expect(made).toEqual(['deepseek', 'brave', 'naver', 'tavily']);
    expect(webNeeds(['deepseek', 'brave', 'naver'])).toEqual(['deepseek', 'brave', 'naver', 'tavily']);
  });
  it('勾了两家（Brave、Tavily）：只搜这两家、合并；Naver、DeepSeek 不搜', async () => {
    const made: string[] = [];
    const all = { deepseek: okOf('deepseek', ['https://a.example/']), brave: okOf('brave', ['https://b.example/']), naver: okOf('naver', ['https://c.example/']), tavily: okOf('tavily', ['https://t.example/']) };
    const r = await webFor(['brave', 'tavily'], maker(all, made), () => 0, sleepLog([]))?.search(Q);
    expect(r).toMatchObject({ ok: true, by: 'brave+tavily' });
    expect(r?.ok && r.sources.map((x) => x.site)).toEqual(['b.example', 't.example']);
    // 备用候选只建了第一家有密钥的（DeepSeek），没搜它
    expect(made).toEqual(['brave', 'tavily', 'deepseek']);
  });
  it('勾的几家全挂：退没勾的里有密钥的一家，Tavily 在先（日志每家一行，加同时搜那一行）', async () => {
    const fails: string[] = [];
    const r = await webFor(['deepseek', 'brave', 'naver'], maker({ deepseek: BAD, brave: BAD, naver: BAD, tavily: okOf('tavily', ['https://t.example/']) }), () => 0, sleepLog([]))
      ?.search({ ...Q, onFail: (by) => fails.push(by) });
    expect(r).toMatchObject({ ok: true, by: 'tavily' });
    expect(fails).toEqual(['deepseek', 'brave', 'naver', 'multi']);
  });
  it('备用顺序：没勾的里 Tavily 在先，其余照 DeepSeek、Brave、Naver；Tavily 勾了或没密钥就往下找；没勾的都没密钥不退；四家全勾没有备用', async () => {
    expect(backupOrder(['naver'])).toEqual(['tavily', 'deepseek', 'brave']);
    expect(backupOrder(['tavily'])).toEqual(['deepseek', 'brave', 'naver']);
    expect(backupOrder(['deepseek', 'brave', 'naver', 'tavily'])).toEqual([]);
    expect(webNeeds(['tavily'])).toEqual(['tavily', 'deepseek', 'brave', 'naver']);
    const all = { deepseek: BAD, brave: okOf('brave', ['https://b.example/']), naver: okOf('naver', ['https://n.example/']), tavily: BAD };
    // 只勾 Tavily、它挂了：DeepSeek 有密钥 → 退 DeepSeek（只退一家），DeepSeek 也挂就是失败
    expect(await webFor(['tavily'], maker(all), () => 0)?.search(Q)).toMatchObject({ ok: false });
    // DeepSeek 没密钥：往下找到 Brave
    expect(await webFor(['tavily'], maker({ brave: all.brave, naver: all.naver, tavily: BAD }), () => 0)?.search(Q)).toMatchObject({ ok: true, by: 'brave' });
    // 只勾 Naver、它挂了，Tavily 没密钥：退 DeepSeek 以后的第一家有密钥的（Brave）
    expect(await webFor(['naver'], maker({ brave: okOf('brave', []), naver: BAD }), () => 0)?.search(Q)).toMatchObject({ ok: true, by: 'brave' });
    // 没勾的都没密钥：只有勾的那一家
    expect(webFor(['naver'], maker({ naver: BAD }), () => 0)?.name).toBe('naver');
  });
  it('勾的里只有一家有密钥：直接用它（不套同时搜）；勾的和备用都没密钥：null', async () => {
    const one = webFor(['deepseek', 'brave', 'naver'], maker({ brave: okOf('brave', []) }), () => 0, sleepLog([]));
    expect(one?.name).toBe('brave');
    expect(webFor(['deepseek', 'brave', 'naver'], maker({}), () => 0)).toBe(null);
  });
  it('几家同时搜时备用拿到用剩的时间：同时搜的只给 3 秒，备用拿总时长减去用掉的', async () => {
    const clock = { t: 0 };
    const t = fakeSearcher('tavily', okOf('tavily', []));
    const make = (p: WebProviderName): WebSearcher | null => (p === 'tavily' ? t.s : { name: p, search: async (r) => ((clock.t = r.timeoutMs), BAD) });
    await webFor(['deepseek', 'brave', 'naver'], make, () => clock.t, sleepLog([]))?.search({ ...Q, timeoutMs: 8_000 });
    expect(t.calls).toEqual([8_000 - WEB_FANOUT_MS]);
    expect(8_000 - WEB_FANOUT_MS).toBeGreaterThanOrEqual(WEB_RETRY_MIN_MS);
  });
});
