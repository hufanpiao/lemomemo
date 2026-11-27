// ai-provider（R-494 AI 助手第 4 段：自行更换 AI 服务商）的处理逻辑：core.ts 依赖全部注入，库、Vault、服务商都是假的。
// 钉住：不是管理员 admin_* 一律 403、任何响应都不带密钥、试调不通什么都不存、通了才存、自己的密钥删记录也删 Vault、按用途改由哪家做要这家能做而且存好了。
import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_ERROR_CODES, AI_PROVIDERS, AI_ROUTE_TASKS, aiProviderReq, adminGetRes, mineRes, ownCovers, supportOf, TASK_SUPPORT, testRes, WEB_COMPARE_MAX,
  WEB_COMPARE_QUERY_MAX, WEB_COMPARE_SNIPPET_MAX, webCompareRes, WEB_PROVIDERS as SHARED_WEB,
} from '../../shared/schema/ai-provider.ts';
import type { AiRequest, AiResult, AIProvider, WebSearchRequest, WebSearchResult } from '../../supabase/functions/_shared/ai/provider.ts';
import { AI_TASKS, PROVIDER_NAMES } from '../../supabase/functions/_shared/ai/provider.ts';
import { makeSearcher, WEB_PROVIDERS, type WebCompareName } from '../../supabase/functions/_shared/ai/websearch.ts';
import { COMPARE_SNIPPET_MAX, COMPARE_TZ } from '../../supabase/functions/ai-provider/compare.ts';
import { handle, TEST_PER_MIN, tryKey, tryWebKey, WEB_TEST_QUERY, type Deps, type OwnRow, type Req } from '../../supabase/functions/ai-provider/core.ts';

const UA = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY = 'fake-aaaaaaaa1234';   // 假值（低熵，免得 gitleaks 当真密钥）
const call = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const req = (body: unknown) => new Request('http://kong/functions/v1/ai-provider', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

type World = {
  deps: Deps;
  secrets: Map<string, string>;
  own: { row: OwnRow | null };
  ai: { v: Record<string, unknown> };
  tried: { p: string; model: string; key: string }[];
  logs: string[];
  /** admin_key 存完清掉的项目密钥缓存（独立评审 7） */
  forgot: string[];
  /** 联网搜索试调（Brave / Tavily，11-23） */
  searched: { p: string; key: string }[];
};

function world(o: { admin?: boolean; reply?: AiResult; webReply?: WebSearchResult; ai?: Record<string, unknown>; rateOk?: boolean; consent?: boolean } = {}, over: Partial<Deps> = {}): World {
  const searched: World['searched'] = [];
  const secrets = new Map<string, string>();
  const own: { row: OwnRow | null } = { row: null };
  const ai = { v: o.ai ?? { provider: 'gemini', model: 'gemini-x', per_user_daily: 50, global_daily: 400 } };
  const tried: World['tried'] = [];
  const logs: string[] = [];
  const forgot: string[] = [];
  let t = 1_000;
  const deps: Deps = {
    authenticate: async () => ({ ok: true, user: { userId: UA } }),
    parse(v) {
      const p = aiProviderReq.safeParse(v);
      return p.success ? (p.data as Req) : null;
    },
    support: supportOf,
    forgetKey: (p) => forgot.push(p),
    isAdmin: async () => o.admin ?? false,
    consent: async () => o.consent ?? true,
    rate: async () => o.rateOk ?? true,
    readAi: async () => structuredClone(ai.v),
    async writeAi(v) {
      ai.v = structuredClone(v);
    },
    async secretSet(name, k) {
      if (k === null) secrets.delete(name);
      else secrets.set(name, k);
    },
    secretGet: async (name) => secrets.get(name) ?? null,
    projectKey: async (p) => secrets.get(`ai_key_${p}`),
    ownRead: async () => (own.row ? { ...own.row } : null),
    async ownWrite(_u, row) {
      own.row = { ...row };
    },
    async ownActive(_u, active) {
      if (own.row) own.row = { ...own.row, active };
    },
    async ownDelete() {
      own.row = null;
    },
    makeSearcher(p, key) {
      return {
        name: p,
        async search() {
          searched.push({ p, key });
          t += 300;
          return o.webReply ?? { ok: true, by: p, sources: [] };
        },
      };
    },
    make(p, model, key): AIProvider {
      return {
        name: p, model,
        async generate(_r: AiRequest) {
          tried.push({ p, model, key });
          t += 900;
          return o.reply ?? { ok: true, json: { ok: true }, raw: '{"ok":true}' };
        },
      };
    },
    now: () => t,
    log: (c) => logs.push(c),
    ...over,
  };
  return { deps, secrets, own, ai, tried, logs, forgot, searched };
}

const noKeyIn = (body: unknown) => expect(JSON.stringify(body)).not.toContain(KEY);

describe('ai-provider：契约和服务器两边一致', () => {
  it('服务商、用途和 provider.ts 一字不差；错误码只这几个', () => {
    expect([...AI_PROVIDERS].sort()).toEqual([...PROVIDER_NAMES].sort());
    // 联网（web）由 Brave / Tavily 做，不在 AI 用途表里，单独一个 web 字段（独立评审第 9 条）
    expect([...AI_ROUTE_TASKS]).toEqual([...AI_TASKS]);
    expect([...SHARED_WEB]).toEqual([...WEB_PROVIDERS]);
    expect([...AI_PROVIDER_ERROR_CODES]).toEqual(['not_admin', 'not_tested', 'not_supported', 'no_key', 'consent_required', 'rate_limited', 'try_later']);
  });
  it('四家都能对话和整理；Claude、DeepSeek 没有录音和向量；自己的密钥只接管这家能做的对话和整理、录音转文字', () => {
    for (const p of AI_PROVIDERS) expect(TASK_SUPPORT.chat[p]).toBe('yes');
    expect([TASK_SUPPORT.stt.claude, TASK_SUPPORT.stt.deepseek, TASK_SUPPORT.embed.claude]).toEqual(['no', 'no', 'no']);
    expect(ownCovers('gemini')).toEqual(['chat', 'stt']);
    expect(ownCovers('claude')).toEqual(['chat']);
  });
});

describe('ai-provider：鉴权', () => {
  const disabled = () => world({}, { authenticate: async () => ({ ok: false, response: new Response('{"error":"account_disabled"}', { status: 403 }) }) });
  it('TC-B1-10 ai-provider：管理员停用的账号回 403 account_disabled，不读库、不试调', async () => {
    const w = disabled();
    const r = await call(await handle(req({ action: 'own_test', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps));
    expect(r).toEqual({ status: 403, body: { error: 'account_disabled' } });
    expect(w.tried).toEqual([]);
  });
  it('TC-B1-10 ai-provider：没有 profiles 行的账号回 403 account_disabled，不读库', async () => {
    const w = disabled();
    expect((await call(await handle(req({ action: 'mine' }), w.deps))).body).toMatchObject({ error: 'account_disabled' });
    expect(w.own.row).toBe(null);
  });
  it('只收 POST；请求体不对 400', async () => {
    const w = world();
    expect((await handle(new Request('http://kong/x', { method: 'GET' }), w.deps)).status).toBe(405);
    expect((await call(await handle(req({ action: 'admin_route', task: 'chat' }), w.deps))).status).toBe(400);
    expect((await call(await handle(req({ action: 'own_use', provider: 'openai', model: 'bad model', key: KEY }), w.deps))).status).toBe(400);
  });
  it('不是管理员：admin_* 四个动作一律 403 not_admin，不试调、不写配置', async () => {
    const w = world({ admin: false });
    for (const b of [{ action: 'admin_get' }, { action: 'admin_test', provider: 'claude', model: 'c', key: KEY },
      { action: 'admin_key', provider: 'claude', model: 'c', key: KEY }, { action: 'admin_route', task: 'chat', provider: 'gemini' }]) {
      expect(await call(await handle(req(b), w.deps))).toEqual({ status: 403, body: { error: 'not_admin' } });
    }
    expect([w.tried.length, w.secrets.size, w.ai.v['tasks']]).toEqual([0, 0, undefined]);
  });
  it('读库出错回 503 try_later，日志只记动作和码', async () => {
    const w = world({}, { ownRead: async () => { throw new Error('db'); } });
    expect(await call(await handle(req({ action: 'mine' }), w.deps))).toEqual({ status: 503, body: { error: 'try_later' } });
    expect(w.logs).toEqual(['mine try_later']);
  });
});

describe('ai-provider：没同意 AI 不试调（TC-B1-15）', () => {
  it('own_test、own_use、admin_test、admin_key 都回 409 consent_required，一个请求都不发、什么都不存', async () => {
    const w = world({ admin: true, consent: false });
    for (const action of ['own_test', 'own_use', 'admin_test', 'admin_key']) {
      expect(await call(await handle(req({ action, provider: 'openai', model: 'gpt-x', key: KEY }), w.deps))).toEqual({ status: 409, body: { error: 'consent_required' } });
    }
    expect([w.tried.length, w.secrets.size, w.own.row]).toEqual([0, 0, null]);
  });
  it('看、关、删不用同意（mine、own_off、own_delete、admin_get 照常）', async () => {
    const w = world({ admin: true, consent: false });
    for (const action of ['mine', 'own_off', 'own_delete', 'admin_get']) expect((await handle(req({ action }), w.deps)).status).toBe(200);
  });
});

describe('ai-provider：我的 AI', () => {
  it('mine：普通人 admin false、柠檬记现在用 gemini、没存过自己的密钥', async () => {
    const r = await call(await handle(req({ action: 'mine' }), world().deps));
    expect(mineRes.parse(r.body)).toEqual({ admin: false, project: 'gemini', own: null, images: true });
  });
  it('own_test 通了回耗时，什么都不存；没带密钥、库里也没有回 409 no_key', async () => {
    const w = world();
    const r = await call(await handle(req({ action: 'own_test', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps));
    expect(testRes.parse(r.body)).toEqual({ ok: true, ms: 900 });
    expect([w.secrets.size, w.own.row]).toEqual([0, null]);
    expect((await call(await handle(req({ action: 'own_test', provider: 'openai', model: 'gpt-x' }), w.deps)))).toEqual({ status: 409, body: { error: 'no_key' } });
  });
  it('own_use 没通：回原因，不存密钥、不改用', async () => {
    const w = world({ reply: { ok: false, reason: 'error', status: 401 } });
    const r = await call(await handle(req({ action: 'own_use', provider: 'claude', model: 'claude-x', key: KEY }), w.deps));
    expect(r.body).toEqual({ ok: false, code: 'auth', status: 401 });
    expect([w.secrets.size, w.own.row]).toEqual([0, null]);
  });
  it('own_use 通了：密钥进 Vault（ai_ukey_<user_id>）、记录只有后四位、改用；响应和 mine 都不带密钥', async () => {
    const w = world();
    const r = await call(await handle(req({ action: 'own_use', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps));
    expect(r.body).toEqual({ ok: true, own: { provider: 'openai', model: 'gpt-x', last4: '1234', active: true, fell_back: null } });
    expect(w.secrets.get(`ai_ukey_${UA}`)).toBe(KEY);
    expect(w.own.row).toEqual({ provider: 'openai', model: 'gpt-x', key_last4: '1234', active: true, fell_back_at: null, fell_back_why: null });
    noKeyIn(r.body);
    const m = await call(await handle(req({ action: 'mine' }), w.deps));
    noKeyIn(m.body);
    expect(m.body['own']).toEqual({ provider: 'openai', model: 'gpt-x', last4: '1234', active: true, fell_back: null });
    // 对话那家换成 OpenAI（不接看图）：mine 的 images 跟着变 false，输入条不画“＋”（独立评审第 4 条）
    expect(m.body['images']).toBe(false);
    await handle(req({ action: 'own_off' }), w.deps);
    expect((await call(await handle(req({ action: 'mine' }), w.deps))).body['images']).toBe(true);
  });
  it('换模型名不用重贴：不带密钥时用库里那把试', async () => {
    const w = world();
    await handle(req({ action: 'own_use', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps);
    const r = await call(await handle(req({ action: 'own_use', provider: 'openai', model: 'gpt-y' }), w.deps));
    expect(r.body['ok']).toBe(true);
    expect(w.tried.at(-1)).toEqual({ p: 'openai', model: 'gpt-y', key: KEY });
    expect(w.own.row?.key_last4).toBe('1234');
  });
  it('own_off 改回柠檬记的，密钥留着；own_delete 删记录、也删 Vault 那条', async () => {
    const w = world();
    await handle(req({ action: 'own_use', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps);
    expect((await call(await handle(req({ action: 'own_off' }), w.deps))).body).toEqual({ ok: true });
    expect([w.own.row?.active, w.secrets.has(`ai_ukey_${UA}`)]).toEqual([false, true]);
    expect((await call(await handle(req({ action: 'own_delete' }), w.deps))).body).toEqual({ ok: true });
    expect([w.own.row, w.secrets.size]).toEqual([null, 0]);
  });
  it(`试调每人每分钟 ${TEST_PER_MIN} 次：超了 429，不试调`, async () => {
    const w = world({ rateOk: false });
    expect(await call(await handle(req({ action: 'own_test', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps))).toEqual({ status: 429, body: { error: 'rate_limited' } });
    expect(w.tried).toEqual([]);
  });
});

describe('ai-provider：AI 服务商（管理员）', () => {
  it('admin_get：每项现在由哪家做、每家的模型名和后四位；没配 tasks 全是 gemini；不带密钥', async () => {
    const w = world({ admin: true });
    w.secrets.set('ai_key_claude', KEY);
    w.ai.v['providers'] = { claude: { model: 'claude-x', last4: '1234', saved_at: 5 } };
    const r = await call(await handle(req({ action: 'admin_get' }), w.deps));
    const g = adminGetRes.parse(r.body);
    // 联网搜索没设置过：默认勾 DeepSeek、Brave、Naver（负责人 11-25 改成各自打勾）
    expect([g.routes, g.web]).toEqual([{ chat: 'gemini', stt: 'gemini', embed: 'gemini' }, ['deepseek', 'brave', 'naver']]);
    expect(g.keys.brave).toEqual({ model: null, last4: null, saved_at: null, has_key: false });
    expect(g.keys.naver).toEqual({ model: null, last4: null, saved_at: null, has_key: false });
    expect(g.keys.gemini).toEqual({ model: 'gemini-x', last4: null, saved_at: null, has_key: false });
    expect(g.keys.claude).toEqual({ model: 'claude-x', last4: '1234', saved_at: 5, has_key: true });
    // Gemini 只配了环境变量（Vault 里没有、也没有后四位）也算有密钥（独立评审 8）
    w.secrets.set('ai_key_gemini', KEY);
    const r2 = adminGetRes.parse((await call(await handle(req({ action: 'admin_get' }), w.deps))).body);
    expect(r2.keys.gemini).toEqual({ model: 'gemini-x', last4: null, saved_at: null, has_key: true });
    noKeyIn(r.body);
  });
  it('admin_key 没通不存；通了存 Vault 和 providers，这家正在做的用途跟着换模型名', async () => {
    const bad = world({ admin: true, reply: { ok: false, reason: 'error', status: 404 } });
    expect((await call(await handle(req({ action: 'admin_key', provider: 'claude', model: 'nope', key: KEY }), bad.deps))).body).toEqual({ ok: false, code: 'model', status: 404 });
    expect([bad.secrets.size, bad.ai.v['providers']]).toEqual([0, undefined]);

    const w = world({ admin: true, ai: { provider: 'gemini', model: 'gemini-x', tasks: { chat: { provider: 'claude', model: 'old' } } } });
    expect((await call(await handle(req({ action: 'admin_key', provider: 'claude', model: 'claude-new', key: KEY }), w.deps))).body).toEqual({ ok: true });
    expect(w.secrets.get('ai_key_claude')).toBe(KEY);
    expect(w.ai.v['providers']).toEqual({ claude: { model: 'claude-new', last4: '1234', saved_at: 1900 } });
    expect(w.ai.v['tasks']).toEqual({ chat: { provider: 'claude', model: 'claude-new' } });
    expect(w.ai.v['model']).toBe('gemini-x');
  });
  it('先写记录再写 Vault，Vault 写不进就回滚（独立评审 1）：admin_key 的配置改回原样、own_use 的行删掉或改回旧行，不留孤儿', async () => {
    const boom = { secretSet: async () => { throw new Error('vault'); } };
    const a = world({ admin: true }, boom);
    const before = structuredClone(a.ai.v);
    expect((await call(await handle(req({ action: 'admin_key', provider: 'claude', model: 'claude-new', key: KEY }), a.deps))).status).toBe(503);
    expect([a.ai.v, a.forgot]).toEqual([before, []]);

    const o = world({}, boom);
    expect((await call(await handle(req({ action: 'own_use', provider: 'openai', model: 'gpt-x', key: KEY }), o.deps))).status).toBe(503);
    expect(o.own.row).toBe(null);
    const old = { provider: 'claude' as const, model: 'c', key_last4: 'zzzz', active: false, fell_back_at: null, fell_back_why: null };
    o.own.row = { ...old };
    await handle(req({ action: 'own_use', provider: 'openai', model: 'gpt-x', key: KEY }), o.deps);
    expect(o.own.row).toEqual(old);
  });
  it('admin_key 存完清掉这家的项目密钥缓存（独立评审 7）', async () => {
    const w = world({ admin: true });
    await handle(req({ action: 'admin_key', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps);
    expect(w.forgot).toEqual(['openai']);
  });
  it('mine 带上最近一次自动改用柠檬记的时刻和原因；重新 own_use 清空', async () => {
    const w = world();
    w.own.row = { provider: 'openai', model: 'gpt-x', key_last4: '1234', active: true, fell_back_at: '2026-11-23T01:00:00.000Z', fell_back_why: 'quota' };
    const m = await call(await handle(req({ action: 'mine' }), w.deps));
    expect(mineRes.parse(m.body).own?.fell_back).toEqual({ at: Date.parse('2026-11-23T01:00:00.000Z'), why: 'quota' });
    await handle(req({ action: 'own_use', provider: 'openai', model: 'gpt-x', key: KEY }), w.deps);
    expect([w.own.row?.fell_back_at, w.own.row?.fell_back_why]).toEqual([null, null]);
  });
  it('admin_key 改的是顶层那家（gemini）：顶层模型名一起换', async () => {
    const w = world({ admin: true });
    await handle(req({ action: 'admin_key', provider: 'gemini', model: 'gemini-y', key: KEY }), w.deps);
    expect(w.ai.v['model']).toBe('gemini-y');
  });
  it('admin_route：做不了的 409 not_supported；没存好密钥的 409 not_tested；存好了写 tasks', async () => {
    const w = world({ admin: true });
    expect((await call(await handle(req({ action: 'admin_route', task: 'stt', provider: 'claude' }), w.deps)))).toEqual({ status: 409, body: { error: 'not_supported' } });
    expect((await call(await handle(req({ action: 'admin_route', task: 'embed', provider: 'openai' }), w.deps)))).toEqual({ status: 409, body: { error: 'not_supported' } });
    // 向量这项暂不让写（换了要重算，独立评审 9）：Gemini 也一样
    expect((await call(await handle(req({ action: 'admin_route', task: 'embed', provider: 'gemini' }), w.deps)))).toEqual({ status: 409, body: { error: 'not_supported' } });
    expect((await call(await handle(req({ action: 'admin_route', task: 'chat', provider: 'deepseek' }), w.deps)))).toEqual({ status: 409, body: { error: 'not_tested' } });
    await handle(req({ action: 'admin_key', provider: 'deepseek', model: 'deepseek-chat', key: KEY }), w.deps);
    expect((await call(await handle(req({ action: 'admin_route', task: 'chat', provider: 'deepseek' }), w.deps))).body).toEqual({ ok: true });
    expect(w.ai.v['tasks']).toEqual({ chat: { provider: 'deepseek', model: 'deepseek-chat' } });
    const m = await call(await handle(req({ action: 'mine' }), w.deps));
    expect(m.body['project']).toBe('deepseek');
  });
});

describe('ai-provider：联网搜索 Brave / Tavily（负责人 11-23 弹窗）', () => {
  it('不是管理员 403；admin_web_test 真搜固定词、不存；admin_web_key 通了存 Vault ai_key_<名字> 和后四位、清缓存；没通不存', async () => {
    const no = world({ admin: false });
    for (const b of [{ action: 'admin_web_test', provider: 'brave', key: KEY }, { action: 'admin_web_key', provider: 'tavily', key: KEY }, { action: 'admin_web_route', providers: ['brave'] }]) {
      expect(await call(await handle(req(b), no.deps))).toEqual({ status: 403, body: { error: 'not_admin' } });
    }
    expect(no.searched).toEqual([]);

    const w = world({ admin: true });
    const t = await call(await handle(req({ action: 'admin_web_test', provider: 'brave', key: KEY }), w.deps));
    expect(testRes.parse(t.body)).toEqual({ ok: true, ms: 300 });
    expect([w.searched, w.secrets.size]).toEqual([[{ p: 'brave', key: KEY }], 0]);
    expect((await call(await handle(req({ action: 'admin_web_key', provider: 'tavily', key: KEY }), w.deps))).body).toEqual({ ok: true });
    expect(w.secrets.get('ai_key_tavily')).toBe(KEY);
    expect((w.ai.v['providers'] as Record<string, unknown>)['tavily']).toEqual({ last4: '1234', saved_at: expect.any(Number) });
    expect(w.forgot).toEqual(['tavily']);
    noKeyIn(t.body);

    const bad = world({ admin: true, webReply: { ok: false, reason: 'error', status: 422 } });
    expect((await call(await handle(req({ action: 'admin_web_key', provider: 'brave', key: KEY }), bad.deps))).body).toEqual({ ok: false, code: 'auth', status: 422 });
    expect([bad.secrets.size, bad.ai.v['providers']]).toEqual([0, undefined]);
  });
  it('admin_web_key 的 Vault 写不进：配置写回原样', async () => {
    const w = world({ admin: true }, { secretSet: async () => { throw new Error('vault'); } });
    const before = structuredClone(w.ai.v);
    expect((await call(await handle(req({ action: 'admin_web_key', provider: 'brave', key: KEY }), w.deps))).status).toBe(503);
    expect(w.ai.v).toEqual(before);
  });
  it('admin_web_route：新勾上的那家没存好密钥 409 not_tested；存好了写 ai.web（数组），admin_get 跟着变；Brave、Tavily 不能拿去做对话（admin_route 400）', async () => {
    const w = world({ admin: true });
    expect(await call(await handle(req({ action: 'admin_web_route', providers: ['tavily'] }), w.deps))).toEqual({ status: 409, body: { error: 'not_tested' } });
    await handle(req({ action: 'admin_web_key', provider: 'tavily', key: KEY }), w.deps);
    expect((await call(await handle(req({ action: 'admin_web_route', providers: ['tavily'] }), w.deps))).body).toEqual({ ok: true });
    expect(w.ai.v['web']).toEqual(['tavily']);
    const g = adminGetRes.parse((await call(await handle(req({ action: 'admin_get' }), w.deps))).body);
    expect([g.web, g.keys.tavily.has_key, g.keys.tavily.last4]).toEqual([['tavily'], true, '1234']);
    expect(Object.keys(g.routes)).toEqual(['chat', 'stt', 'embed']);
    expect((await call(await handle(req({ action: 'admin_route', task: 'chat', provider: 'brave' }), w.deps))).status).toBe(400);
    expect((await call(await handle(req({ action: 'admin_route', task: 'web', provider: 'gemini' }), w.deps))).status).toBe(400);
  });
  it('勾几家（负责人 11-25）：同时勾几家、按 WEB_PROVIDERS 排着存；新勾上的要有密钥（DeepSeek 用对话那家的）；一家不勾、重复、乱写、旧的单选写法一律 400；只有管理员能改', async () => {
    // 原来只勾了 Tavily（没设置过时默认勾着的三家算“原来就勾着”，见下一条）
    const w = world({ admin: true, ai: { provider: 'gemini', model: 'gemini-x', web: ['tavily'] } });
    w.secrets.set('ai_key_tavily', KEY);
    // DeepSeek 搜索不新建密钥：对话那家的 ai_key_deepseek 有了才能勾
    expect(await call(await handle(req({ action: 'admin_web_route', providers: ['tavily', 'deepseek'] }), w.deps))).toEqual({ status: 409, body: { error: 'not_tested' } });
    w.secrets.set('ai_key_deepseek', KEY);
    expect((await call(await handle(req({ action: 'admin_web_route', providers: ['tavily', 'deepseek'] }), w.deps))).body).toEqual({ ok: true });
    expect(w.ai.v['web']).toEqual(['deepseek', 'tavily']);
    expect(adminGetRes.parse((await call(await handle(req({ action: 'admin_get' }), w.deps))).body).web).toEqual(['deepseek', 'tavily']);
    // 再加 Naver（没密钥）不行；取消一家随时可以
    expect(await call(await handle(req({ action: 'admin_web_route', providers: ['deepseek', 'naver', 'tavily'] }), w.deps))).toEqual({ status: 409, body: { error: 'not_tested' } });
    expect((await call(await handle(req({ action: 'admin_web_route', providers: ['deepseek'] }), w.deps))).body).toEqual({ ok: true });
    for (const providers of [[], ['brave', 'brave'], ['bing'], ['gemini']]) {
      expect((await call(await handle(req({ action: 'admin_web_route', providers }), w.deps))).status).toBe(400);
    }
    expect((await call(await handle(req({ action: 'admin_web_route', provider: 'multi' }), w.deps))).status).toBe(400);
    expect(w.ai.v['web']).toEqual(['deepseek']);
    expect(w.logs).toEqual(['admin_web_route deepseek+tavily', 'admin_web_route deepseek']);
    const nobody = world({ admin: false });
    expect((await call(await handle(req({ action: 'admin_web_route', providers: ['tavily'] }), nobody.deps))).status).toBe(403);
  });
  it('原来就勾着、后来密钥被删的那家可以留着（只查新勾上的）', async () => {
    const w = world({ admin: true, ai: { provider: 'gemini', model: 'gemini-x', web: ['naver', 'tavily'] } });
    w.secrets.set('ai_key_brave', KEY);
    expect((await call(await handle(req({ action: 'admin_web_route', providers: ['brave', 'naver', 'tavily'] }), w.deps))).body).toEqual({ ok: true });
    expect(w.ai.v['web']).toEqual(['brave', 'naver', 'tavily']);
  });
  it('旧设置换算（不加迁移）：ai.web 是旧的 multi → 默认三家；单家字符串 → 那一家；没写 → 默认三家；admin_get 一律回数组', async () => {
    const got = async (web: unknown) => {
      const w = world({ admin: true, ai: { provider: 'gemini', model: 'gemini-x', ...(web === undefined ? {} : { web }) } });
      return adminGetRes.parse((await call(await handle(req({ action: 'admin_get' }), w.deps))).body).web;
    };
    expect(await got('multi')).toEqual(['deepseek', 'brave', 'naver']);
    expect(await got('tavily')).toEqual(['tavily']);
    expect(await got('naver')).toEqual(['naver']);
    expect(await got(undefined)).toEqual(['deepseek', 'brave', 'naver']);
    expect(await got(['tavily', 'brave'])).toEqual(['brave', 'tavily']);
    // 旧的单选 Tavily：第一次存新勾法时 Tavily 不算新勾上（照旧能留）
    const w = world({ admin: true, ai: { provider: 'gemini', model: 'gemini-x', web: 'tavily' } });
    w.secrets.set('ai_key_brave', KEY);
    expect((await call(await handle(req({ action: 'admin_web_route', providers: ['brave', 'tavily'] }), w.deps))).body).toEqual({ ok: true });
    expect(w.ai.v['web']).toEqual(['brave', 'tavily']);
  });
  it('Naver 的密钥（一个值 id:secret）照 Brave、Tavily 的存法存进 ai_key_naver；DeepSeek 没有单独的搜索密钥动作（admin_web_key deepseek 400）', async () => {
    const w = world({ admin: true });
    const NK = 'fakeNaverId01:fakeNaverSecret01';
    expect((await call(await handle(req({ action: 'admin_web_key', provider: 'naver', key: NK }), w.deps))).body).toEqual({ ok: true });
    expect([w.secrets.get('ai_key_naver'), w.searched]).toEqual([NK, [{ p: 'naver', key: NK }]]);
    expect((w.ai.v['providers'] as Record<string, unknown>)['naver']).toEqual({ last4: 'et01', saved_at: expect.any(Number) });
    const g = adminGetRes.parse((await call(await handle(req({ action: 'admin_get' }), w.deps))).body);
    expect([g.keys.naver.has_key, g.keys.naver.last4]).toEqual([true, 'et01']);
    expect((await call(await handle(req({ action: 'admin_web_route', providers: ['naver'] }), w.deps))).body).toEqual({ ok: true });
    expect((await call(await handle(req({ action: 'admin_web_key', provider: 'deepseek', key: KEY }), w.deps))).status).toBe(400);
    // 格式不对的（没有冒号）：真的建 Naver 时建不出来，试调当密钥不对，不存
    const real = world({ admin: true }, { makeSearcher: (p, k) => makeSearcher(p, k, async () => new Response('{}')) });
    expect((await call(await handle(req({ action: 'admin_web_key', provider: 'naver', key: 'nocolon-naver-key' }), real.deps))).body).toEqual({ ok: false, code: 'auth' });
    expect(real.secrets.has('ai_key_naver')).toBe(false);
  });
  it('tryWebKey 归类：401 / 403 / 422 密钥不对；额度；超时；连不上；其余 error；搜的是固定词', async () => {
    const run = (webReply: WebSearchResult) => tryWebKey(world({ webReply }).deps, 'brave', KEY);
    expect(await run({ ok: false, reason: 'error', status: 401 })).toEqual({ ok: false, code: 'auth', status: 401 });
    expect(await run({ ok: false, reason: 'error', status: 403 })).toEqual({ ok: false, code: 'auth', status: 403 });
    expect(await run({ ok: false, reason: 'quota', status: 429, quotaKind: 'unknown', retryMs: null })).toEqual({ ok: false, code: 'quota', status: 429 });
    expect(await run({ ok: false, reason: 'timeout', errName: 'TimeoutError' })).toEqual({ ok: false, code: 'timeout' });
    expect(await run({ ok: false, reason: 'error', errName: 'TypeError' })).toEqual({ ok: false, code: 'net' });
    expect(await run({ ok: false, reason: 'error', status: 500 })).toEqual({ ok: false, code: 'error', status: 500 });
    let q = '';
    await tryWebKey({ now: () => 0, makeSearcher: () => ({ name: 'x', search: async (r) => ((q = r.query), { ok: true, by: 'x', sources: [] }) }) }, 'tavily', KEY);
    expect(q).toBe(WEB_TEST_QUERY);
  });
});

describe('ai-provider：联网搜索对比 admin_web_compare（对比用，负责人 11-24）', () => {
  // 每家回什么由 replies 定；记下每家拿到的密钥、搜索词、今天
  const cmp = (replies: Partial<Record<WebCompareName, WebSearchResult>>, o: Parameters<typeof world>[0] = {}) => {
    const seen: { p: string; key: string; query: string; today: string | undefined }[] = [];
    const w = world({ admin: true, ...o }, {
      // 首尔 11-25 00:30（UTC 还是 11-24）：“今天”要按首尔算
      now: () => Date.parse('2026-11-24T15:30:00Z'),
      makeSearcher: (p, key) => ({
        name: p,
        async search(r: WebSearchRequest) {
          seen.push({ p, key, query: r.query, today: r.today });
          return (p === 'brave' ? replies.brave : p === 'tavily' ? replies.tavily : replies.deepseek) ?? { ok: true, by: p, sources: [] };
        },
      }),
    });
    w.secrets.set('ai_key_brave', `${KEY}-b`);
    w.secrets.set('ai_key_deepseek', `${KEY}-d`);
    return { w, seen };
  };
  const SECRET_Q = '首尔明天下雨吗';

  it('三家各用自己存的项目密钥搜每一条；没存密钥的那家 no_key、不搜；回包按契约；结果截摘要、带日期；不存任何东西', async () => {
    const long = '字'.repeat(300);
    const { w, seen } = cmp({
      brave: { ok: true, by: 'brave', sources: [{ title: 'B', url: 'https://b.example/', site: 'b.example', text: long, date: '2026-11-24T00:00:00' }] },
      deepseek: { ok: true, by: 'deepseek', sources: [{ title: 'D', url: 'https://d.example/', site: 'd.example', text: '短' }] },
    });
    const before = structuredClone(w.ai.v);
    const r = await call(await handle(req({ action: 'admin_web_compare', queries: [SECRET_Q, '  景福宫 门票  '] }), w.deps));
    expect(r.status).toBe(200);
    const g = webCompareRes.parse(r.body);
    expect(g.rows.map((x) => x.query)).toEqual([SECRET_Q, '景福宫 门票']);
    expect(g.rows[0]?.brave).toEqual({ ok: true, ms: 0, results: [{ title: 'B', url: 'https://b.example/', site: 'b.example', date: '2026-11-24T00:00:00', snippet: '字'.repeat(COMPARE_SNIPPET_MAX) }] });
    expect(g.rows[0]?.deepseek).toEqual({ ok: true, ms: 0, results: [{ title: 'D', url: 'https://d.example/', site: 'd.example', date: null, snippet: '短' }] });
    expect(g.rows[1]?.tavily).toEqual({ ok: false, ms: 0, code: 'no_key' });
    expect(seen.map((x) => [x.p, x.key, x.query, x.today])).toEqual([
      ['brave', `${KEY}-b`, SECRET_Q, '2026-11-25'], ['deepseek', `${KEY}-d`, SECRET_Q, '2026-11-25'],
      ['brave', `${KEY}-b`, '景福宫 门票', '2026-11-25'], ['deepseek', `${KEY}-d`, '景福宫 门票', '2026-11-25'],
    ]);
    noKeyIn(r.body);
    expect([w.ai.v, w.secrets.size, w.own.row]).toEqual([before, 2, null]);
    expect([COMPARE_SNIPPET_MAX, COMPARE_TZ]).toEqual([WEB_COMPARE_SNIPPET_MAX, 'Asia/Seoul']);
  });
  it('日志只记条数和每家的码（不记搜索词、结果）', async () => {
    const { w } = cmp({ deepseek: { ok: false, reason: 'quota', status: 402, quotaKind: 'day', retryMs: null } });
    await handle(req({ action: 'admin_web_compare', queries: [SECRET_Q, 'b', 'c'] }), w.deps);
    expect(w.logs).toEqual(['admin_web_compare n=3', 'admin_web_compare brave ok=3', 'admin_web_compare tavily no_key=3', 'admin_web_compare deepseek quota:402=3']);
    expect(w.logs.join('\n')).not.toContain('首尔');
  });
  it('失败归类：DeepSeek 401 / 403 密钥不对、422 不算（Brave 的 422 算）；超时、连不上；适配器抛异常当 error、不连累别家', async () => {
    const run = async (replies: Partial<Record<WebCompareName, WebSearchResult>>) =>
      webCompareRes.parse((await call(await handle(req({ action: 'admin_web_compare', queries: ['q'] }), cmp(replies).w.deps))).body).rows[0];
    expect((await run({ deepseek: { ok: false, reason: 'error', status: 401 } }))?.deepseek).toEqual({ ok: false, ms: 0, code: 'auth', status: 401 });
    expect((await run({ deepseek: { ok: false, reason: 'error', status: 422 } }))?.deepseek).toEqual({ ok: false, ms: 0, code: 'error', status: 422 });
    expect((await run({ brave: { ok: false, reason: 'error', status: 422 } }))?.brave).toEqual({ ok: false, ms: 0, code: 'auth', status: 422 });
    expect((await run({ brave: { ok: false, reason: 'timeout', errName: 'TimeoutError' } }))?.brave).toEqual({ ok: false, ms: 0, code: 'timeout' });
    expect((await run({ deepseek: { ok: false, reason: 'error', errName: 'TypeError' } }))?.deepseek).toEqual({ ok: false, ms: 0, code: 'net' });
    const { w } = cmp({});
    const boom: Deps['makeSearcher'] = (p, key) => (p === 'brave' ? { name: p, search: async () => { throw new Error('x'); } } : w.deps.makeSearcher(p, key));
    const row = webCompareRes.parse((await call(await handle(req({ action: 'admin_web_compare', queries: ['q'] }), { ...w.deps, makeSearcher: boom }))).body).rows[0];
    expect([row?.brave, row?.deepseek.ok]).toEqual([{ ok: false, ms: 0, code: 'error' }, true]);
  });
  it(`请求体：1～${WEB_COMPARE_MAX} 条、每条 1～${WEB_COMPARE_QUERY_MAX} 字（去掉前后空白再算），否则 400、不搜`, async () => {
    const { w, seen } = cmp({});
    for (const queries of [[], Array.from({ length: WEB_COMPARE_MAX + 1 }, () => 'q'), ['  '], ['a'.repeat(WEB_COMPARE_QUERY_MAX + 1)], 'q']) {
      expect((await call(await handle(req({ action: 'admin_web_compare', queries }), w.deps))).status).toBe(400);
    }
    expect((await call(await handle(req({ action: 'admin_web_compare', queries: ['q'], extra: 1 }), w.deps))).status).toBe(400);
    expect(seen).toEqual([]);
    expect((await call(await handle(req({ action: 'admin_web_compare', queries: Array.from({ length: WEB_COMPARE_MAX }, () => 'a'.repeat(WEB_COMPARE_QUERY_MAX)) }), w.deps))).status).toBe(200);
  });
  it('不是管理员 403；没同意 AI 409；限速和试调同一套（超了 429）：都不搜', async () => {
    const body = { action: 'admin_web_compare', queries: ['q'] };
    const no = cmp({}, { admin: false });
    expect(await call(await handle(req(body), no.w.deps))).toEqual({ status: 403, body: { error: 'not_admin' } });
    const nc = cmp({}, { consent: false });
    expect(await call(await handle(req(body), nc.w.deps))).toEqual({ status: 409, body: { error: 'consent_required' } });
    const nr = cmp({}, { rateOk: false });
    expect(await call(await handle(req(body), nr.w.deps))).toEqual({ status: 429, body: { error: 'rate_limited' } });
    expect([no.seen, nc.seen, nr.seen]).toEqual([[], [], []]);
  });
});

describe('ai-provider：试调结果归类（tryKey）', () => {
  const run = (reply: AiResult, p: 'gemini' | 'openai' = 'openai') => tryKey(world({ reply }).deps, p, 'm', KEY);
  it('401/403 密钥不对；404 模型名；额度；超时；连不上；Gemini 400 只有错误详情是 API_KEY_INVALID 才算密钥不对（独立评审 12）', async () => {
    expect(await run({ ok: false, reason: 'error', status: 401 })).toEqual({ ok: false, code: 'auth', status: 401 });
    expect(await run({ ok: false, reason: 'error', status: 404 })).toEqual({ ok: false, code: 'model', status: 404 });
    expect(await run({ ok: false, reason: 'quota', status: 429, quotaKind: 'day' })).toEqual({ ok: false, code: 'quota', status: 429 });
    expect(await run({ ok: false, reason: 'timeout', errName: 'TimeoutError' })).toEqual({ ok: false, code: 'timeout' });
    expect(await run({ ok: false, reason: 'error', errName: 'TypeError' })).toEqual({ ok: false, code: 'net' });
    expect(await run({ ok: false, reason: 'error', status: 400, errName: 'API_KEY_INVALID' }, 'gemini')).toEqual({ ok: false, code: 'auth', status: 400 });
    expect(await run({ ok: false, reason: 'error', status: 400, errName: 'INVALID_ARGUMENT' }, 'gemini')).toEqual({ ok: false, code: 'error', status: 400 });
    expect(await run({ ok: false, reason: 'error', status: 500 })).toEqual({ ok: false, code: 'error', status: 500 });
  });
  it('模型名不合法（建不出适配器）当模型名不对', async () => {
    const w = world({}, { make: () => null });
    expect(await tryKey(w.deps, 'claude', 'x', KEY)).toEqual({ ok: false, code: 'model' });
  });
});
