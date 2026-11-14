// 调 note-search（B4b-2；data/note-search-api.ts）：成功、四种退回原因的归类、超时、请求形状
import { describe, expect, it } from 'vitest';
import { noteSearch, SEM_TIMEOUT_MS, type SemDeps } from '../data/note-search-api.ts';

const ID = '00000000-0000-4000-8000-000000000001';

function deps(res: () => Promise<Response>, token: string | null = 'jwt'): SemDeps & { seen: RequestInit[] } {
  const seen: RequestInit[] = [];
  return {
    seen,
    accessToken: async () => token,
    fetch: (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return res();
    }) as never,
    base: 'https://x/functions/v1',
    anonKey: 'anon',
  };
}
const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe('noteSearch', () => {
  it('成功：回 hits；请求只带 q 和 scope=main', async () => {
    const d = deps(ok({ hits: [{ kind: 'note', id: ID, score: 0.8 }] }));
    expect(await noteSearch('牙医', new AbortController().signal, d)).toEqual({ ok: true, hits: [{ kind: 'note', id: ID, score: 0.8 }] });
    expect(JSON.parse(String(d.seen[0]?.body))).toEqual({ q: '牙医', scope: 'main' });
  });

  it('服务器的 fallback 原样；非 2xx（含 429）、读不懂、没登录 → timeout（“今天用完”只认服务器回的 quota）', async () => {
    const s = new AbortController().signal;
    expect(await noteSearch('a', s, deps(ok({ fallback: 'quota' })))).toMatchObject({ ok: false, reason: 'quota' });
    expect(await noteSearch('a', s, deps(ok({ error: 'rate_limited' }, 429)))).toMatchObject({ ok: false, reason: 'timeout', code: 'rate_limited' });
    expect(await noteSearch('a', s, deps(ok({ error: 'x' }, 500)))).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await noteSearch('a', s, deps(ok({ hits: [{ kind: 'x', id: 1 }] })))).toMatchObject({ ok: false, reason: 'timeout', code: 'bad_response' });
    expect(await noteSearch('a', s, deps(ok({}), null))).toMatchObject({ ok: false, reason: 'timeout', code: 'no_session' });
  });

  it('等满 SEM_TIMEOUT_MS 算超时；调用方取消也停', async () => {
    const hang = (init: RequestInit) => new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError'))));
    const d: SemDeps = { accessToken: async () => 'jwt', fetch: ((_u: string, init: RequestInit) => hang(init)) as never, base: 'b', anonKey: 'a' };
    const ac = new AbortController();
    const p = noteSearch('a', ac.signal, d);
    ac.abort();
    expect(await p).toMatchObject({ ok: false, reason: 'timeout', code: 'timeout' });
    expect(SEM_TIMEOUT_MS).toBe(3500);
  });

  it('取令牌卡住（supabase-js 等锁）：取消时立刻回，不发请求', async () => {
    const seen: unknown[] = [];
    const d: SemDeps = { accessToken: () => new Promise(() => {}), fetch: (async (...a: unknown[]) => { seen.push(a); return new Response('{}'); }) as never, base: 'b', anonKey: 'a' };
    const ac = new AbortController();
    const p = noteSearch('a', ac.signal, d);
    ac.abort();
    expect(await p).toMatchObject({ ok: false, reason: 'timeout', code: 'timeout' });
    expect(seen).toHaveLength(0);
  });
});
