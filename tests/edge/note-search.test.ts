// note-search（B4b-2；架构 5.13 第 6 点“查询流程”、第 6 节 note-search 行）：顺序、四种退回、计数键、按 scope 写死
import { describe, expect, it } from 'vitest';
import { noteSearchReq } from '../../shared/schema/search.ts';
import { pacificDate } from '../../supabase/functions/_shared/ai/gate.ts';
import type { EmbedResult } from '../../supabase/functions/_shared/ai/embed.ts';
import {
  type Deps, DAY_WINDOW_S, EMBED_TIMEOUT_MS, handle, HITS_MAX, MIN_SCORE, RATE_PER_MIN, readSearchConfig, UNLIMITED,
} from '../../supabase/functions/note-search/core.ts';
import { A, jwtFor, T0, uuid } from '../functions/vault-fakes.ts';

const V = Array.from({ length: 768 }, () => 0.01);

function world(over: Partial<Deps> = {}, embedRes: EmbedResult = { ok: true, vectors: [V] }) {
  const logs: string[] = [];
  const rate = new Map<string, number>();
  const calls: { texts: readonly string[]; ms: number }[] = [];
  const near: { uid: string; model: string; limit: number; min: number }[] = [];
  const limits: { key: string; limit: number; windowS: number }[] = [];
  const deps: Deps = {
    async authenticate(req) {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const p = JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string };
      return { ok: true, user: { userId: p.sub } };
    },
    parse(v) { const p = noteSearchReq.safeParse(v); return p.success ? p.data : null; },
    consent: async () => true,
    async takeRate(key, limit, windowS) {
      limits.push({ key, limit, windowS });
      const n = (rate.get(key) ?? 0) + 1;
      rate.set(key, n);
      return n <= limit;
    },
    config: async () => ({ embedModel: 'gemini-embedding-2', searchDailyDefault: 200 }),
    searchDaily: async () => undefined,
    embedder: () => async (texts, ms) => { calls.push({ texts, ms }); return embedRes; },
    async nearest(uid, _vec, model, limit, min) {
      near.push({ uid, model, limit, min });
      return [{ kind: 'note', id: uuid(9), score: 0.8 }];
    },
    now: () => T0,
    log: (c) => logs.push(c),
    ...over,
  };
  return { deps, logs, rate, calls, near, limits };
}

const req = (body: unknown, uid = A) => new Request('http://x/note-search', {
  method: 'POST', headers: { authorization: `Bearer ${jwtFor(uid)}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('note-search', () => {
  it('正常：回 hits，只查本人、当前模型、门槛和条数照常量；查询文字加检索前缀、3 秒超时', async () => {
    const w = world();
    const res = await handle(req({ q: '牙医', scope: 'main' }), w.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: [{ kind: 'note', id: uuid(9), score: 0.8 }] });
    expect(w.near).toEqual([{ uid: A, model: 'gemini-embedding-2', limit: HITS_MAX, min: MIN_SCORE }]);
    expect(w.calls).toEqual([{ texts: ['task: search result | query: 牙医'], ms: EMBED_TIMEOUT_MS }]);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('scope=vault 这一批不做：400，不调任何依赖（D-16）', async () => {
    const w = world();
    const res = await handle(req({ q: '牙医', scope: 'vault' }), w.deps);
    expect(res.status).toBe(400);
    expect(w.calls).toHaveLength(0);
    expect(w.limits).toHaveLength(0);
  });

  it('不合法：空查询、超过 100 字、多余字段、GET 一律拒', async () => {
    const w = world();
    expect((await handle(req({ q: '  ', scope: 'main' }), w.deps)).status).toBe(400);
    expect((await handle(req({ q: '字'.repeat(101), scope: 'main' }), w.deps)).status).toBe(400);
    expect((await handle(req({ q: 'a', scope: 'main', kinds: ['note'] }), w.deps)).status).toBe(400);
    expect((await handle(new Request('http://x', { method: 'GET' }), w.deps)).status).toBe(405);
  });

  it('没登录：原样回鉴权的结果，不计数', async () => {
    const w = world({ authenticate: async () => ({ ok: false, response: new Response('{}', { status: 401 }) }) });
    expect((await handle(req({ q: '牙医', scope: 'main' }), w.deps)).status).toBe(401);
    expect(w.limits).toHaveLength(0);
  });

  it('没同意：fallback consent，不计数、不调嵌入；同意读不出：503', async () => {
    const w = world({ consent: async () => false });
    expect(await (await handle(req({ q: '牙医', scope: 'main' }), w.deps)).json()).toEqual({ fallback: 'consent' });
    expect(w.limits).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
    const w2 = world({ consent: async () => { throw new Error('db'); } });
    expect((await handle(req({ q: '牙医', scope: 'main' }), w2.deps)).status).toBe(503);
  });

  it('每分钟 20 次：第 21 次 fallback quota；键是 search-min:<uid>:<UTC 分钟>', async () => {
    const w = world();
    for (let i = 0; i < RATE_PER_MIN; i++) expect((await (await handle(req({ q: '牙医', scope: 'main' }), w.deps)).json()).hits).toBeDefined();
    expect(await (await handle(req({ q: '牙医', scope: 'main' }), w.deps)).json()).toEqual({ fallback: 'quota' });
    expect(w.limits[0]).toMatchObject({ key: expect.stringMatching(new RegExp(`^search-min:${A}:\\d{12}$`)), limit: RATE_PER_MIN, windowS: 60 });
  });

  it('每天：没有 user_limits 行用默认 200；写着 null 的不设上限但照样计数；键 search:<uid>:<太平洋日期>', async () => {
    const w = world();
    await handle(req({ q: '牙医', scope: 'main' }), w.deps);
    expect(w.limits[1]).toEqual({ key: `search:${A}:${pacificDate(T0)}`, limit: 200, windowS: DAY_WINDOW_S });
    const w2 = world({ searchDaily: async () => null });
    await handle(req({ q: '牙医', scope: 'main' }), w2.deps);
    expect(w2.limits[1]?.limit).toBe(UNLIMITED);
    const w3 = world({ searchDaily: async () => 0 });
    expect(await (await handle(req({ q: '牙医', scope: 'main' }), w3.deps)).json()).toEqual({ fallback: 'quota' });
    expect(w3.calls).toHaveLength(0);
  });

  it('嵌入失败：429 → quota；超时、出错 → timeout；没配模型 → timeout', async () => {
    const q = { q: '牙医', scope: 'main' };
    expect(await (await handle(req(q), world({}, { ok: false, reason: 'quota', status: 429 }).deps)).json()).toEqual({ fallback: 'quota' });
    expect(await (await handle(req(q), world({}, { ok: false, reason: 'timeout' }).deps)).json()).toEqual({ fallback: 'timeout' });
    expect(await (await handle(req(q), world({}, { ok: false, reason: 'error', status: 500 }).deps)).json()).toEqual({ fallback: 'timeout' });
    const w = world({ config: async () => ({ embedModel: null, searchDailyDefault: 200 }), embedder: () => null });
    expect(await (await handle(req(q), w.deps)).json()).toEqual({ fallback: 'timeout' });
  });

  it('查库出错：503 try_later；日志只有码，不带查询文字', async () => {
    const w = world({ nearest: async () => { throw new Error('db'); } });
    expect((await handle(req({ q: '我的牙医预约', scope: 'main' }), w.deps)).status).toBe(503);
    expect(w.logs.join(' ')).not.toContain('牙医');
  });

  it('readSearchConfig：读 embed_model、search_daily_default，格式不对按没配、按 200', () => {
    expect(readSearchConfig({ embed_model: 'gemini-embedding-2', search_daily_default: 150 })).toEqual({ embedModel: 'gemini-embedding-2', searchDailyDefault: 150 });
    expect(readSearchConfig({ embed_model: '', search_daily_default: -1 })).toEqual({ embedModel: null, searchDailyDefault: 200 });
    expect(readSearchConfig(null)).toEqual({ embedModel: null, searchDailyDefault: 200 });
  });
});
