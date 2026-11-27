// OpenAI、DeepSeek、Claude 三家适配器（R-494 AI 助手第 4 段）：请求体、解析、续轮、失败归类。fetch 是假的，不连外网，密钥是假值。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, MODEL_NAME_RE } from '../../shared/schema/ai-provider.ts';
import { ClaudeProvider, CLAUDE_URL, CLAUDE_VERSION } from '../../supabase/functions/_shared/ai/claude.ts';
import { jsonSchemaOf, MODEL_RE, parseJsonText, quotaKindOf } from '../../supabase/functions/_shared/ai/compat.ts';
import { DEEPSEEK_URL, OPENAI_URL, OpenAiCompatProvider } from '../../supabase/functions/_shared/ai/openai.ts';
import { PROVIDER_NAMES, type AiRequest, type ChatRequest } from '../../supabase/functions/_shared/ai/provider.ts';
import { canDo, makeProvider } from '../../supabase/functions/_shared/ai/router.ts';

const KEY = 'sk-test-FAKE0000';
type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown>; redirect: unknown };
function fake(reply: unknown, status = 200) {
  const sent: Sent[] = [];
  const fn = async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown>, redirect: init.redirect });
    return new Response(JSON.stringify(reply), { status });
  };
  return { fn, sent };
}
const SCHEMA = { type: 'OBJECT', properties: { a: { type: 'STRING', nullable: true }, b: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['b'], propertyOrdering: ['a', 'b'] };
const gen = (over: Partial<AiRequest> = {}): AiRequest => ({ system: 'SYS', parts: [{ text: '原话' }], schema: SCHEMA, params: { temperature: 0, candidateCount: 1 }, timeoutMs: 5000, ...over });
const chatReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  system: 'SYS', messages: [{ role: 'assistant', text: '你好' }, { role: 'user', text: '明天有什么' }],
  tools: [{ name: 'find', description: 'd', parameters: { type: 'object' } }], toolChoice: 'auto',
  params: { temperature: 0.3, candidateCount: 1 }, timeoutMs: 5000, ...over,
});

describe('模型名正则、四家名单：几处写法一字不差（独立评审 4、6）', () => {
  const sql = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'migrations', '20261123090000_ai_provider_keys.sql'), 'utf8');
  it('后端 compat.MODEL_RE 和前端契约 MODEL_NAME_RE 同一个；迁移里 ai_user_keys.model 的 check 也是它', () => {
    expect(MODEL_RE.source).toBe(MODEL_NAME_RE.source);
    expect(sql).toContain(`model ~ '${MODEL_RE.source}'`);
  });
  it('迁移 ai_provider_ok 的名单 = provider.ts 的 PROVIDER_NAMES = 契约的 AI_PROVIDERS', () => {
    const m = /select p in \(([^)]*)\)/.exec(sql);
    const names = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
    expect([...names].sort()).toEqual([...PROVIDER_NAMES].sort());
    expect([...AI_PROVIDERS].sort()).toEqual([...PROVIDER_NAMES].sort());
  });
});

describe('compat：schema 转换、JSON 解析、额度判定', () => {
  it('jsonSchemaOf：type 小写、nullable 变 [t, null]、去掉 propertyOrdering、递归 items', () => {
    expect(jsonSchemaOf(SCHEMA)).toEqual({ type: 'object', properties: { a: { type: ['string', 'null'] }, b: { type: 'array', items: { type: 'integer' } } }, required: ['b'] });
  });
  it('parseJsonText 去掉 ``` 围栏；解析不了 null', () => {
    expect(parseJsonText('```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(parseJsonText('不是 JSON')).toBe(null);
  });
  it('quotaKindOf：余额用完当每天、限速当每分钟、认不出 unknown', () => {
    expect(quotaKindOf({ error: { code: 'insufficient_quota' } })).toBe('day');
    expect(quotaKindOf({ error: { type: 'rate_limit_error' } })).toBe('minute');
    expect(quotaKindOf({ error: 'x' })).toBe('unknown');
  });
});

describe('OpenAI / DeepSeek', () => {
  it('OpenAI generate：地址、Bearer 密钥只在请求头、json_schema（strict 关）、不跟重定向；解析结果', async () => {
    const f = fake({ choices: [{ message: { content: '{"b":[1]}' } }] });
    const p = new OpenAiCompatProvider('openai', 'gpt-4.1-mini', KEY, f.fn);
    expect(await p.generate(gen())).toEqual({ ok: true, json: { b: [1] }, raw: '{"b":[1]}' });
    const s = f.sent[0]!;
    expect([s.url, s.headers['authorization'], s.redirect]).toEqual([OPENAI_URL, `Bearer ${KEY}`, 'error']);
    expect(s.body['response_format']).toEqual({ type: 'json_schema', json_schema: { name: 'out', schema: jsonSchemaOf(SCHEMA), strict: false } });
    expect(s.body['temperature']).toBe(0);
    expect(JSON.stringify(s.body)).not.toContain(KEY);
  });
  it('gpt-5、o 系列不带 temperature', () => {
    expect(new OpenAiCompatProvider('openai', 'gpt-5-mini', KEY, fake({}).fn).body(gen())).not.toHaveProperty('temperature');
    expect(new OpenAiCompatProvider('openai', 'o4-mini', KEY, fake({}).fn).body(gen())).not.toHaveProperty('temperature');
  });
  it('DeepSeek：另一个地址、json_object，schema 接在系统提示后面', () => {
    const f = fake({});
    const b = new OpenAiCompatProvider('deepseek', 'deepseek-chat', KEY, f.fn).body(gen())!;
    expect(b['response_format']).toEqual({ type: 'json_object' });
    const sys = (b['messages'] as { content: string }[])[0]!.content;
    expect(sys.startsWith('SYS')).toBe(true);
    expect(sys).toContain(JSON.stringify(jsonSchemaOf(SCHEMA)));
    expect(DEEPSEEK_URL).toBe('https://api.deepseek.com/chat/completions');
  });
  it('带音频不发，回 error no_audio', async () => {
    const f = fake({});
    const r = await new OpenAiCompatProvider('openai', 'gpt-x', KEY, f.fn).generate(gen({ parts: [{ inlineData: { mimeType: 'audio/webm', data: new Uint8Array(1) } }] }));
    expect(r).toEqual({ ok: false, reason: 'error', errName: 'no_audio' });
    expect(f.sent).toEqual([]);
  });
  it('429 余额用完当每天额度；401 只带状态码；回的不是 JSON 当 error', async () => {
    expect(await new OpenAiCompatProvider('openai', 'gpt-x', KEY, fake({ error: { code: 'insufficient_quota' } }, 429).fn).generate(gen()))
      .toEqual({ ok: false, reason: 'quota', status: 429, quotaKind: 'day', retryMs: null });
    expect(await new OpenAiCompatProvider('openai', 'gpt-x', KEY, fake({ error: { message: '密钥不对' } }, 401).fn).generate(gen()))
      .toEqual({ ok: false, reason: 'error', status: 401 });
    expect(await new OpenAiCompatProvider('openai', 'gpt-x', KEY, fake({ choices: [{ message: { content: '嗯' } }] }).fn).generate(gen()))
      .toEqual({ ok: false, reason: 'error', status: 200 });
  });
  it('402 当每天额度', async () => {
    expect(await new OpenAiCompatProvider('deepseek', 'deepseek-chat', KEY, fake({}, 402).fn).generate(gen())).toMatchObject({ reason: 'quota', quotaKind: 'day' });
  });
  it('chat：function 工具、tool_choice；工具调用解析；续轮把 assistant 原样放回、再接 role tool', async () => {
    const call = { id: 'c1', type: 'function', function: { name: 'find', arguments: '{"q":"明天"}' } };
    const f = fake({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] });
    const p = new OpenAiCompatProvider('openai', 'gpt-x', KEY, f.fn);
    const r1 = await p.chat(chatReq());
    if (!r1.ok) throw new Error('应成功');
    expect(r1.toolCalls).toEqual([{ id: 'c1', name: 'find', args: { q: '明天' } }]);
    expect(f.sent[0]!.body['tools']).toEqual([{ type: 'function', function: { name: 'find', description: 'd', parameters: { type: 'object' } } }]);
    expect(f.sent[0]!.body['tool_choice']).toBe('auto');
    await p.chat(chatReq({ toolChoice: 'none', resume: { turn: r1.turn, results: [{ id: 'c1', name: 'find', result: { n: 2 } }] } }));
    const msgs = f.sent[1]!.body['messages'] as Record<string, unknown>[];
    expect(msgs.slice(-2)).toEqual([{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: '{"n":2}' }]);
  });
  it('DeepSeek 看图（负责人 11-27 选“接上”）：这一句的图接在最后一条 user 的 content 数组里（官方 image_url data URL），历史不带图；工具结果的图跟一条 user', async () => {
    const pic = { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) };
    const url = 'data:image/png;base64,AQID';
    const call = { id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } };
    const f = fake({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] });
    const p = new OpenAiCompatProvider('deepseek', 'deepseek-flash', KEY, f.fn);
    expect(p.caps.imageIn).toBe(true);
    const r1 = await p.chat(chatReq({ images: [pic] }));
    if (!r1.ok) throw new Error('应成功');
    const m0 = f.sent[0]!.body['messages'] as { role: string; content: unknown }[];
    expect(m0[1]).toEqual({ role: 'assistant', content: '你好' });
    expect(m0[2]).toEqual({ role: 'user', content: [{ type: 'text', text: '明天有什么' }, { type: 'image_url', image_url: { url } }] });
    await p.chat(chatReq({ resume: { turn: r1.turn, results: [{ id: 'c1', name: 'look', result: { n: 1 }, images: [pic, pic] }] } }));
    const m1 = f.sent[1]!.body['messages'] as { role: string; content: unknown }[];
    expect(m1.at(-2)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"n":1}' });
    expect(m1.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url', image_url: { url } }, { type: 'image_url', image_url: { url } }] });
  });
  it('OpenAI 不收图：带了图也只发文字', async () => {
    const f = fake({ choices: [{ message: { content: '好' } }] });
    const p = new OpenAiCompatProvider('openai', 'gpt-x', KEY, f.fn);
    expect(p.caps.imageIn).toBe(false);
    await p.chat(chatReq({ images: [{ mimeType: 'image/png', data: new Uint8Array([1]) }] }));
    expect((f.sent[0]!.body['messages'] as { content: unknown }[]).at(-1)).toEqual({ role: 'user', content: '明天有什么' });
  });
  it('别家的 turn 不认', async () => {
    const r = await new OpenAiCompatProvider('openai', 'gpt-x', KEY, fake({}).fn).chat(chatReq({ resume: { turn: { provider: 'claude', state: { extra: [] } }, results: [] } }));
    expect(r).toEqual({ ok: false, reason: 'error', errName: 'bad_turn' });
  });
});

describe('Claude', () => {
  it('generate：x-api-key 和版本头、强制调 emit 工具；取 tool_use.input', async () => {
    const f = fake({ content: [{ type: 'tool_use', name: 'emit', id: 't', input: { b: [2] } }] });
    const r = await new ClaudeProvider('claude-sonnet-x', KEY, f.fn).generate(gen());
    expect(r).toEqual({ ok: true, json: { b: [2] }, raw: '{"b":[2]}' });
    const s = f.sent[0]!;
    expect([s.url, s.headers['x-api-key'], s.headers['anthropic-version']]).toEqual([CLAUDE_URL, KEY, CLAUDE_VERSION]);
    expect(s.body['tool_choice']).toEqual({ type: 'tool', name: 'emit' });
    expect((s.body['tools'] as { input_schema: unknown }[])[0]!.input_schema).toEqual(jsonSchemaOf(SCHEMA));
  });
  it('没回 emit 当 error', async () => {
    expect(await new ClaudeProvider('c', KEY, fake({ content: [{ type: 'text', text: '好' }] }).fn).generate(gen())).toEqual({ ok: false, reason: 'error', status: 200 });
  });
  it('chat：历史开头的 assistant 去掉；续轮发 tool_result', async () => {
    const f = fake({ content: [{ type: 'text', text: '查一下' }, { type: 'tool_use', id: 'u1', name: 'find', input: { q: 1 } }] });
    const p = new ClaudeProvider('c', KEY, f.fn);
    const r1 = await p.chat(chatReq());
    if (!r1.ok) throw new Error('应成功');
    expect([r1.text, r1.toolCalls]).toEqual(['查一下', [{ id: 'u1', name: 'find', args: { q: 1 } }]]);
    const m0 = f.sent[0]!.body['messages'] as { role: string }[];
    expect(m0[0]!.role).toBe('user');
    expect(f.sent[0]!.body['tool_choice']).toEqual({ type: 'auto' });
    await p.chat(chatReq({ resume: { turn: r1.turn, results: [{ id: 'u1', name: 'find', result: [] }] } }));
    const m1 = f.sent[1]!.body['messages'] as { role: string; content: unknown }[];
    expect(m1.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: '[]' }] });
    expect(m1.at(-2)!.role).toBe('assistant');
  });
});

describe('router：建适配器、能不能做', () => {
  it('模型名不合法、没密钥建不出；四家都能建', () => {
    const f = fake({}).fn;
    expect(makeProvider('openai', 'bad model', KEY, f)).toBe(null);
    expect(makeProvider('claude', 'c', '', f)).toBe(null);
    for (const p of ['gemini', 'claude', 'openai', 'deepseek'] as const) expect(makeProvider(p, 'm-1', KEY, f)?.name).toBe(p);
  });
  it('canDo：Claude、OpenAI 不收音频、没有向量；Gemini 都能', () => {
    const f = fake({}).fn;
    const c = makeProvider('claude', 'c', KEY, f)!;
    const g = makeProvider('gemini', 'g', KEY, f)!;
    expect([canDo(c, 'chat'), canDo(c, 'stt'), canDo(c, 'embed')]).toEqual([true, false, false]);
    expect([canDo(g, 'chat'), canDo(g, 'stt'), canDo(g, 'embed')]).toEqual([true, true, true]);
  });
});
