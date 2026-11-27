// ai-provider 数据层（R-494）：请求体先按契约校验、响应按 zod 认、错误码归类；写的动作回“没通”的样子当没通
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FnCall } from '../../../platform/fn-call.ts';

const calls: { fn: string; body: unknown; timeout: number }[] = [];
let reply: FnCall = { ok: true, status: 200, body: null };
vi.mock('../../../platform/fn-call.ts', () => ({
  defaultFnDeps: () => ({}),
  callFn: (fn: string, body: unknown, _s: AbortSignal, timeout: number) => {
    calls.push({ fn, body, timeout });
    return Promise.resolve(reply);
  },
}));
const api = await import('../data/provider-api.ts');

afterEach(() => {
  calls.length = 0;
});

const OWN = { provider: 'openai', model: 'gpt-5-mini', last4: 'a1B2', active: true, fell_back: null };
const MINE = { admin: true, project: 'gemini', own: OWN, images: false };

describe('读 mine', () => {
  it('认得的回包原样给出；发的是 {action: mine}、函数名 ai-provider', async () => {
    reply = { ok: true, status: 200, body: MINE };
    await expect(api.readMine()).resolves.toEqual({ ok: true, value: MINE });
    expect(calls[0]).toMatchObject({ fn: 'ai-provider', body: { action: 'mine' } });
  });

  it('认不出的回包（多了键、少了键）当失败 bad_response', async () => {
    reply = { ok: true, status: 200, body: { ...MINE, extra: 1 } };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'bad_response' });
    reply = { ok: true, status: 200, body: { admin: true } };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'bad_response' });
  });

  it('错误归类：契约里的码原样；401 / unauthorized 归 signed_out；别的归 failed；没登录、超时、断网', async () => {
    reply = { ok: true, status: 403, body: { error: 'not_admin' } };
    await expect(api.adminGet()).resolves.toEqual({ ok: false, err: 'not_admin' });
    reply = { ok: true, status: 429, body: { error: 'rate_limited' } };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'rate_limited' });
    reply = { ok: true, status: 401, body: null };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'signed_out' });
    reply = { ok: true, status: 403, body: { error: 'account_disabled' } };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'signed_out' });
    reply = { ok: true, status: 500, body: { error: 'misconfigured' } };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'failed' });
    reply = { ok: false, code: 'no_session' };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'signed_out' });
    reply = { ok: false, code: 'timeout' };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'timeout' });
    reply = { ok: false, code: 'network' };
    await expect(api.readMine()).resolves.toEqual({ ok: false, err: 'offline' });
  });
});

describe('试调、存', () => {
  it('密钥前后空白去掉再发；只有空白 = 不带 key（用库里那把）；模型名也去空白', async () => {
    reply = { ok: true, status: 200, body: { ok: true, ms: 812 } };
    await expect(api.ownTest({ provider: 'openai', model: ' gpt-5-mini ', key: '  fake-aaaaaaaa1234\n' })).resolves.toEqual({ ok: true, value: { ok: true, ms: 812 } });
    expect(calls[0]?.body).toEqual({ action: 'own_test', provider: 'openai', model: 'gpt-5-mini', key: 'fake-aaaaaaaa1234' });
    await api.adminTest({ provider: 'claude', model: 'claude-haiku-5-5', key: '   ' });
    expect(calls[1]?.body).toEqual({ action: 'admin_test', provider: 'claude', model: 'claude-haiku-5-5' });
    expect(calls[1]?.timeout).toBe(api.PROVIDER_CLIENT_TIMEOUT_MS);
  });

  it('联网搜索两家（11-23）：试、存走 admin_web_test / admin_web_key，不带模型名；联网用哪家走 admin_web_route；我的 AI 和别的用途不收这两家', async () => {
    reply = { ok: true, status: 200, body: { ok: true, ms: 300 } };
    await api.adminTest({ provider: 'brave', model: '', key: ' fake-brave-0000 ' });
    expect(calls[0]?.body).toEqual({ action: 'admin_web_test', provider: 'brave', key: 'fake-brave-0000' });
    reply = { ok: true, status: 200, body: { ok: true } };
    await api.adminKey({ provider: 'tavily', model: '' });
    expect(calls[1]?.body).toEqual({ action: 'admin_web_key', provider: 'tavily' });
    // 11-25：联网搜索勾几家发一个数组
    await api.adminWeb(['deepseek', 'tavily']);
    expect(calls[2]?.body).toEqual({ action: 'admin_web_route', providers: ['deepseek', 'tavily'] });
    await expect(api.adminRoute('chat', 'brave')).resolves.toEqual({ ok: false, err: 'bad_input' });
    await api.adminKey({ provider: 'naver', model: '', key: 'fakeNaverId01:fakeNaverSecret01' });
    expect(calls.at(-1)?.body).toEqual({ action: 'admin_web_key', provider: 'naver', key: 'fakeNaverId01:fakeNaverSecret01' });
    await expect(api.ownTest({ provider: 'brave', model: 'm', key: 'fake-brave-0000' })).resolves.toEqual({ ok: false, err: 'bad_input' });
    expect(calls).toHaveLength(4);
  });

  it('联网搜索勾的几家（11-25）：一家不勾、有重复、不是搜索四家的不发，回 bad_input', async () => {
    await expect(api.adminWeb([])).resolves.toEqual({ ok: false, err: 'bad_input' });
    await expect(api.adminWeb(['brave', 'brave'])).resolves.toEqual({ ok: false, err: 'bad_input' });
    await expect(api.adminWeb(['gemini' as never])).resolves.toEqual({ ok: false, err: 'bad_input' });
    expect(calls).toHaveLength(0);
  });

  it('格式不对的模型名、密钥不发，回 bad_input', async () => {
    await expect(api.ownTest({ provider: 'openai', model: 'gpt 5', key: 'sk-abcdefgh' })).resolves.toEqual({ ok: false, err: 'bad_input' });
    await expect(api.adminKey({ provider: 'openai', model: 'gpt-5', key: 'short' })).resolves.toEqual({ ok: false, err: 'bad_input' });
    expect(calls).toHaveLength(0);
  });

  it('试调不通带原因；结果的形状认不出当失败', async () => {
    reply = { ok: true, status: 200, body: { ok: false, code: 'auth', status: 401 } };
    await expect(api.adminTest({ provider: 'claude', model: 'm', key: 'sk-abcdefgh' })).resolves.toEqual({ ok: true, value: { ok: false, code: 'auth', status: 401 } });
    reply = { ok: true, status: 200, body: { ok: false, code: 'weird' } };
    await expect(api.adminTest({ provider: 'claude', model: 'm', key: 'sk-abcdefgh' })).resolves.toEqual({ ok: false, err: 'bad_response' });
  });

  it('写的动作按契约认回包（独立评审 10）：own_use 回 {ok, own}、别的回 {ok}；回的是“没通”的样子就带原因；多了键、不是对象都当失败', async () => {
    reply = { ok: true, status: 200, body: { ok: true } };
    await expect(api.ownUse({ provider: 'openai', model: 'gpt-5-mini', key: 'sk-abcdefgh' })).resolves.toEqual({ ok: false, err: 'bad_response' });
    reply = { ok: true, status: 200, body: { ok: true, extra: 1 } };
    await expect(api.ownOff()).resolves.toEqual({ ok: false, err: 'bad_response' });
    reply = { ok: true, status: 200, body: { ok: true, own: OWN } };
    await expect(api.ownUse({ provider: 'openai', model: 'gpt-5-mini', key: 'sk-abcdefgh' })).resolves.toEqual({ ok: true, value: { done: true } });
    reply = { ok: true, status: 200, body: { ok: false, code: 'quota' } };
    await expect(api.adminKey({ provider: 'openai', model: 'gpt-5-mini' })).resolves.toEqual({ ok: true, value: { done: false, code: 'quota' } });
    reply = { ok: true, status: 200, body: 'ok' };
    await expect(api.ownOff()).resolves.toEqual({ ok: false, err: 'bad_response' });
    reply = { ok: true, status: 409, body: { error: 'not_tested' } };
    await expect(api.adminRoute('chat', 'claude')).resolves.toEqual({ ok: false, err: 'not_tested' });
    expect(calls.at(-1)?.body).toEqual({ action: 'admin_route', task: 'chat', provider: 'claude' });
  });
});
