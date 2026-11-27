// AI 回放桩（B3 任务单 BE-6；TC-B1-15、TC-B3-06、07、25）：按回放文件逐条回放，给真的 GeminiProvider 当 fetch，
// 走真的请求组装、返回解析、429 RESOURCE_EXHAUSTED 判定和超时中止；记下 Gemini 被调了几次（TC-B1-15 要 0 次）。
// • 按顺序一条一条回；方法或地址（去查询串）对不上、回放用完都抛错，测试会挂；
// • timeout 条目：一直挂着，直到调用方的 AbortController 中止，再按 fetch 的样子抛 AbortError；
// • 不碰网络；GeminiProvider 拿到的密钥是固定的占位串，不是真密钥。
import { GeminiProvider, type Fetch } from '../../../supabase/functions/_shared/ai/gemini.ts';
import { loadCassette, stripQuery, type Cassette, type CassetteEntry } from './cassette.ts';

export const REPLAY_KEY = 'replay-placeholder-not-a-key';
export const REPLAY_MODEL = 'gemini-x';

export interface Replay {
  fetch: Fetch;
  /** Gemini 被调了几次（含超时的那次） */
  readonly calls: number;
  /** 每次调用送出去的请求体（核对提示词、内容用） */
  readonly sent: unknown[];
}

const abortError = (): Error => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

export function replay(c: Cassette): Replay {
  let i = 0;
  const sent: unknown[] = [];
  const fetch: Fetch = (url, init) => {
    const e: CassetteEntry | undefined = c.entries[i++];
    if (!e) return Promise.reject(new Error(`replay_exhausted:${i}`));
    if ((init.method ?? 'GET') !== e.req.method || stripQuery(url) !== e.req.url) return Promise.reject(new Error(`replay_mismatch:${i}`));
    sent.push(typeof init.body === 'string' ? JSON.parse(init.body) : null);
    if (e.res.kind === 'timeout') {
      return new Promise<Response>((_, reject) => {
        if (init.signal?.aborted) return reject(abortError());
        init.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    return Promise.resolve(new Response(e.res.body, { status: e.res.status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetch, get calls() { return i; }, sent };
}

/** 读 tests/ai/replay/cassettes/<name>.json，配好真的 GeminiProvider */
export function replayProvider(name: string): { provider: GeminiProvider; rp: Replay; cassette: Cassette } {
  const cassette = loadCassette(new URL(`./cassettes/${name}.json`, import.meta.url));
  const rp = replay(cassette);
  return { provider: new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch), rp, cassette };
}
