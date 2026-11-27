// 联网搜索几家怎么组合（从 websearch.ts 拆出来：那边只管各家适配器和名单；负责人 11-24：DeepSeek + Brave + Naver 同时搜、AI 汇总，三家都挂退 Tavily；
// 11-25 负责人：“每个服务商后面可以单独打勾来框选，选几个就用几个”，弹窗定：勾的几家全挂退没勾的里试通的一家（先 Tavily）、至少勾一家）。
// • webChain：按顺序试（排在前面的先试）。后面还有几家，前一家的超时就先扣掉几个 WEB_RETRY_MIN_MS（第一家挂起、超时时第二家照样有时间试，独立评审第 1 条）；
//   前一家失败（出错、超时、额度）且总超时还剩 WEB_RETRY_MIN_MS 以上才试下一家；每家失败都调 req.onFail（调用方每家记一行）；
//   通了回的 by 是实际搜成的那家。没配密钥的那家调用方根本不放进来。
// • webFanout（勾了几家）：几家同时搜同一个搜索词，每家只给 WEB_FANOUT_MS（约 3 秒），到点还没回的不等（当超时，调 onFail）；
//   回来的结果按家轮流取（每家第 1 条、再每家第 2 条……）、按网址去重（urlKey：主机名不分大小写、去 www.、去 #、去末尾斜杠），最多 WEB_MERGED_MAX 条；
//   有一家通了就算通（结果空也算，搜索引擎说没有）；一家都没通才算失败（回最后一家的失败），交给外面的 webChain 退备用那家。by 是通了的几家用 + 连起来。
// • webFor（勾了哪几家，app_config.ai.web 经 websearch.ts 的 webPicksOf 读成数组，管理员页改，对所有人生效；没写当 DeepSeek + Brave + Naver）：
//   webChain([勾的几家同时搜, 备用一家])。勾的里面没密钥的（比如后来密钥被删了）不放进来，自动跳过；只剩一家有密钥时直接用它（不受 3 秒限制）。
//   备用：没勾的几家按 backupOrder（Tavily 在先，其余照 WEB_PROVIDERS 的顺序）取第一家有密钥的；没勾的都没密钥就不退。
//   计次在 ai-chat（一次 web_search 算一次），和这里搜了几家无关。
// 时钟、等待都注入：单测传假的，函数传 Date.now 和 sleepFor。
import type { Fail } from './compat.ts';
import type { WebSearcher, WebSearchRequest, WebSearchResult, WebSource } from './provider.ts';
import { WEB_BACKUP, WEB_PROVIDERS, type WebProviderName } from './websearch.ts';

/** 几家同时搜时合并去重后最多交给模型几条（每家 5 条按家轮流取，三家时每家至少能进前 2 条） */
export const WEB_MERGED_MAX = 8;
/** 几家同时搜时每家最多等多久（负责人 11-24：约 3 秒还没回来的不等） */
export const WEB_FANOUT_MS = 3_000;
/** 前一家失败后，剩下的时间够这么多毫秒才试下一家；前一家的超时也先给后面每一家留出这么多 */
export const WEB_RETRY_MIN_MS = 1_500;

/** 勾的几家全挂时按这个顺序找备用（负责人 11-25 弹窗：退没勾的里试通的一家，先 Tavily）：没勾的几家，Tavily 在先、其余照 WEB_PROVIDERS 的顺序 */
const BACKUP_ORDER: readonly WebProviderName[] = [WEB_BACKUP, ...WEB_PROVIDERS.filter((p) => p !== WEB_BACKUP)];
export const backupOrder = (picks: readonly WebProviderName[]): WebProviderName[] => BACKUP_ORDER.filter((p) => !picks.includes(p));

/** 等 ms 毫秒，signal 一停就提前结束（清掉计时器）；单测传假的 */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
export const sleepFor: Sleep = (ms, signal) => new Promise<void>((done) => {
  const id = setTimeout(done, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(id);
    done();
  }, { once: true });
});

/** 合并去重用的网址口径（见文件头 webFanout）；解析不了的原样 */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return url;
  }
}

/** 几家的结果按家轮流取、按 urlKey 去重，最多 WEB_MERGED_MAX 条 */
export function mergeSources(lists: readonly (readonly WebSource[])[]): WebSource[] {
  const out: WebSource[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < WEB_MERGED_MAX; i += 1) {
    for (const l of lists) {
      const s = l.at(i);
      if (!s || out.length >= WEB_MERGED_MAX) continue;
      const k = urlKey(s.url);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

const timeoutFail = (): Fail => ({ ok: false, reason: 'timeout', errName: 'TimeoutError' });

/** 几家同时搜（见文件头 webFanout）；name 是 multi（只当这一组的名字用） */
export function webFanout(list: readonly WebSearcher[], sleep: Sleep = sleepFor): WebSearcher {
  return {
    name: 'multi',
    async search(req: WebSearchRequest): Promise<WebSearchResult> {
      const { onFail, ...base } = req;
      const ms = Math.min(WEB_FANOUT_MS, req.timeoutMs);
      const got = new Map<WebSearcher, WebSearchResult>();
      const stop = new AbortController();
      const runs = list.map(async (s) => {
        let r: WebSearchResult;
        try {
          r = await s.search({ ...base, timeoutMs: ms });
        } catch (e) {
          r = { ok: false, reason: 'error', errName: e instanceof Error ? e.name : 'unknown' };
        }
        if (!stop.signal.aborted) got.set(s, r);
      });
      await Promise.race([Promise.all(runs), sleep(ms, stop.signal)]);
      stop.abort();
      const oks: Extract<WebSearchResult, { ok: true }>[] = [];
      let last: Fail = timeoutFail();
      for (const s of list) {
        const r = got.get(s) ?? timeoutFail();   // 到点还没回：不等，当超时
        if (r.ok) oks.push(r);
        else {
          onFail?.(s.name, r);
          last = r;
        }
      }
      const first = oks[0];
      if (!first) return last;
      const sources = mergeSources(oks.map((r) => r.sources));
      return { ok: true, by: oks.map((r) => r.by).join('+'), sources, ...(first.sent ? { sent: first.sent } : {}) };
    },
  };
}

/** 勾了这几家时要取哪几家的密钥（wire.ts 先取再建）：勾的几家，加上备用候选（backupOrder） */
export const webNeeds = (picks: readonly WebProviderName[]): WebProviderName[] => [...picks, ...backupOrder(picks)];

/** 按勾的几家建（见文件头 webFor）；make 按家名建一家（没密钥回 null）；一家都建不出回 null */
export function webFor(picks: readonly WebProviderName[], make: (p: WebProviderName) => WebSearcher | null, now: () => number, sleep: Sleep = sleepFor): WebSearcher | null {
  const group = picks.map(make).filter((s): s is WebSearcher => s !== null);
  const lead = group.length > 1 ? webFanout(group, sleep) : (group[0] ?? null);
  const backup = backupOrder(picks).reduce<WebSearcher | null>((got, p) => got ?? make(p), null);
  return webChain([lead, backup].filter((s): s is WebSearcher => s !== null), now);
}

/** 按顺序试几家（见文件头）；一家都没有回 null。name 是排第一的那家；最后一家的失败原样回 */
export function webChain(list: readonly WebSearcher[], now: () => number): WebSearcher | null {
  const first = list[0];
  if (!first) return null;
  return {
    name: first.name,
    async search(req: WebSearchRequest): Promise<WebSearchResult> {
      const end = now() + req.timeoutMs;
      let last: Fail = { ok: false, reason: 'error', errName: 'no_searcher' };
      for (const [i, s] of list.entries()) {
        const rest = end - now();
        if (i > 0 && rest < WEB_RETRY_MIN_MS) break;
        // 后面还有几家，就给每家先留出 WEB_RETRY_MIN_MS（最后一家拿剩下的全部）
        const ms = rest - (list.length - 1 - i) * WEB_RETRY_MIN_MS;
        if (ms <= 0) continue;
        let r: WebSearchResult;
        try {
          r = await s.search({ ...req, timeoutMs: ms });
        } catch (e) {
          r = { ok: false, reason: 'error', errName: e instanceof Error ? e.name : 'unknown' };
        }
        if (r.ok) return r;
        req.onFail?.(s.name, r);
        last = r;
      }
      return last;
    },
  };
}
