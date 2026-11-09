// 打字条调 ai-parse 的各个返回码（data/ai-parse-api.ts 经 type-flow.ts 的 planTyped；B3 任务单 Q2、R7；supabase/functions/ai-parse/core.ts）。
// 不发真请求：fetch 用桩，按 ai-parse 的真实返回（状态码 + 包体）逐个核对打字条最后怎么记
import { describe, expect, it, vi } from 'vitest';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { createCallAi } from '../data/ai-parse-api.ts';
import { planTyped, type TypeCtx } from '../data/type-flow.ts';

const NOW = Date.UTC(2026, 10, 2, 1, 0);
const CTX: TypeCtx = { now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: [], day: null };
const ON = { online: true, aiOn: true, quotaOut: false };
const URL_ = 'https://sb.test/functions/v1/ai-parse';

const item = (over: Partial<AiItem> = {}): AiItem => ({
  kind: 'todo', title: 'AI title', date: null, time: null, duration_min: null, due: '2026-11-05', important: false,
  project: null, body: null, short: 'AI', date_basis: 'rel', anniv: null, confirm: null, ...over,
});

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(res: () => Promise<Response>, token: () => Promise<string | null> = async () => 'jwt-1') {
  const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => res());
  return { fetch, call: createCallAi({ fetch, url: URL_, anonKey: 'anon-1', token }) };
}

describe('ai-parse 请求', () => {
  it('POST 到 ai-parse：带 JWT、apikey、JSON 请求体（日历页带 default_day）、取消信号', async () => {
    const { fetch, call } = api(async () => reply(200, { intent: 'record', confidence: 1, items: [item()], quota_left: 9 }));
    await planTyped('买牛奶', { ...CTX, day: '2026-11-20' }, ON, call);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(URL_);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer jwt-1', apikey: 'anon-1', 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toMatchObject({ text: '买牛奶', scope: 'main', default_day: '2026-11-20' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('没登录（拿不到会话）：不发请求，用本机规则记', async () => {
    const { fetch, call } = api(async () => reply(200, {}), async () => null);
    const p = await planTyped('买牛奶', CTX, ON, call);
    expect(fetch).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: 'saved_rule', origin: 'rule', aiReason: 'http' });
  });
});

describe('200 的各种包体', () => {
  it('record：AI 的结果，记剩余次数', async () => {
    const { call } = api(async () => reply(200, { intent: 'record', confidence: 1, items: [item()], quota_left: 9 }));
    expect(await planTyped('买牛奶', CTX, ON, call)).toMatchObject({ status: 'saved', origin: 'ai', quotaLeft: 9 });
  });
  it('record 但 items 为空（empty_items，R7）：退回本机规则', async () => {
    const { call } = api(async () => reply(200, { intent: 'record', confidence: 1, items: [], quota_left: 9 }));
    expect(await planTyped('买牛奶', CTX, ON, call)).toMatchObject({ status: 'saved_rule', origin: 'rule', aiReason: 'empty_items' });
  });
  it('fallback：invalid、timeout、error 出“AI 没回应”（saved_rule）；quota 当用完；feature_off、vault_ai_off 不出提示', async () => {
    const run = async (reason: string) => planTyped('买牛奶', CTX, ON, api(async () => reply(200, { fallback: true, reason })).call);
    for (const r of ['invalid', 'timeout', 'error']) expect(await run(r)).toMatchObject({ status: 'saved_rule', origin: 'rule', aiReason: r });
    expect(await run('quota')).toMatchObject({ status: 'quota_out', quotaLeft: 0 });
    for (const r of ['feature_off', 'vault_ai_off']) expect(await run(r)).toMatchObject({ status: 'saved', origin: 'rule', aiReason: r });
  });
  it('consent_required：还没同意 AI 告知，用本机规则记、不出“AI 没回应”', async () => {
    const { call } = api(async () => reply(200, { consent_required: true }));
    expect(await planTyped('买牛奶', CTX, ON, call)).toMatchObject({ status: 'saved', origin: 'rule', aiReason: 'consent_required' });
  });
  it('quota_out：今天次数用完，本机规则记 + 额度提示，剩余记 0', async () => {
    const { call } = api(async () => reply(200, { quota_out: true, quota_left: 0 }));
    expect(await planTyped('买牛奶', CTX, ON, call)).toMatchObject({ status: 'quota_out', origin: 'rule', quotaLeft: 0 });
  });
  it('读不懂的包体（不是 JSON、结构对不上）：退回本机规则', async () => {
    const bad = api(async () => new Response('<html>oops</html>', { status: 200 }));
    expect(await planTyped('买牛奶', CTX, ON, bad.call)).toMatchObject({ status: 'saved_rule', aiReason: 'bad_response' });
    const odd = api(async () => reply(200, { hello: 1 }));
    expect(await planTyped('买牛奶', CTX, ON, odd.call)).toMatchObject({ status: 'saved_rule', aiReason: 'bad_response' });
  });
});

describe('非 2xx：不自动重试，用本机规则记、原话不丢', () => {
  const cases: [number, unknown][] = [
    [400, { error: 'bad_request' }],
    [401, { error: 'session_revoked' }],
    [403, { error: 'account_disabled' }],
    [413, { error: 'too_large' }],
    [426, { code: 'upgrade_required', min: '4.9.0' }],
    [429, { error: 'rate_limited' }],
    [500, { error: 'misconfigured' }],
    [503, { error: 'try_later' }],
  ];
  for (const [status, body] of cases) {
    it(`${status}`, async () => {
      const { fetch, call } = api(async () => reply(status, body));
      const p = await planTyped('买牛奶', CTX, ON, call);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(p).toMatchObject({ status: 'saved_rule', origin: 'rule', aiReason: 'http' });
      expect(p.items[0]?.title).toBe('买牛奶');
    });
  }
});

describe('网络', () => {
  it('断网（fetch 抛 TypeError）：自动重试 1 次，还不行用本机规则记', async () => {
    const { fetch, call } = api(async () => {
      throw new TypeError('Failed to fetch');
    });
    const p = await planTyped('买牛奶', CTX, ON, call);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(p).toMatchObject({ status: 'saved_rule', aiReason: 'network' });
  });
  it('重试那一次成功：用 AI 的结果', async () => {
    let n = 0;
    const { call } = api(async () => {
      n += 1;
      if (n === 1) throw new TypeError('Failed to fetch');
      return reply(200, { intent: 'record', confidence: 1, items: [item()], quota_left: 3 });
    });
    expect(await planTyped('买牛奶', CTX, ON, call)).toMatchObject({ status: 'saved', origin: 'ai', quotaLeft: 3 });
  });
});
