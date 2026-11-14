// parseWithAI / voiceWithAI（supabase/functions/_shared/ai/parse-core.ts）、Gemini 适配（gemini.ts）、选服务商（router.ts）、生成参数（params.ts）。
// B3 任务单 BE-1；TC-B3-24（密钥在请求头不在 URL）、TC-B3-42、45、48、50（校验注入真的 shared/schema/ai.ts）。服务商一律用桩，不联网。
import { describe, expect, it } from 'vitest';
import { AI_PROJECT_LEN, AI_PROJECTS_MAX, AI_TEXT_MAX, checkDefaultDay, checkParseOutput, checkVoiceOutput, INVALID_REASONS, type AiItem, type InvalidReason } from '../../shared/schema/ai.ts';
import { AI_KINDS, type AiKind } from '../../shared/schema/kinds.ts';
import { GEMINI_BASE, GeminiProvider, geminiBody, quotaInfo, retryDelayMs, toBase64 } from '../../supabase/functions/_shared/ai/gemini.ts';
import { GEN_PARAMS, PARSE_TIMEOUT_MS, PROMPT_VERSION, TASK_PARAMS, VOICE_PROBE_PARAMS, VOICE_TIMEOUT_MS } from '../../supabase/functions/_shared/ai/params.ts';
import { cleanProjects, fillPrompt, makeParseWithAI, PROJECT_LEN, PROJECTS_MAX, responseSchema, sanitize, TEXT_MAX, wallOf, type AiKindLike, type InvalidReasonLike, type ParseInput } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { PARSE_V3 } from '../../supabase/functions/_shared/ai/prompts/parse.v3.ts';
import { PARSE_V4 } from '../../supabase/functions/_shared/ai/prompts/parse.v4.ts';
import { VOICE_V4 } from '../../supabase/functions/_shared/ai/prompts/voice.v4.ts';
import { pickProvider, readAiConfig } from '../../supabase/functions/_shared/ai/router.ts';
import { okJson, StubProvider } from './ai-fakes.ts';

// B4b-3 起校验结果是几种意图的联合：记下那一种才有 items，这里取出来（别的意图给空）
const itemsOf = (v: object): AiItem[] => ('items' in v ? (v as { items: AiItem[] }).items : []);

const { parseWithAI, voiceWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
const NOW = Date.UTC(2026, 9, 28, 3, 0);
const input = (o: Partial<ParseInput> = {}): ParseInput => ({
  text: '明天下午三点开会', now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: ['NEOX'], features: ['event', 'todo'], ...o,
});
const EV = { kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', date_basis: 'rel' };

describe('防提示注入：sanitize、cleanProjects', () => {
  it('去控制字符和双向覆盖字符、转义 </data> 和 </projects>（不分大小写）、截 2000 个码点', () => {
    expect(sanitize('a\u0000b\u202Ec\u2066d\ne\tf')).toBe('abcd\ne\tf');
    expect(sanitize('x</data>y</ DATA >z<data>')).toBe('x<\\/data>y<\\/DATA>z<_data>');
    expect(sanitize('p</projects>')).toBe('p<\\/projects>');
    expect([...sanitize('字'.repeat(2100))].length).toBe(2000);
  });
  it('项目名最多 30 个、每个 40 字、去掉空的', () => {
    const ps = cleanProjects(['', ...Array.from({ length: 40 }, (_, i) => `${'p'.repeat(50)}${i}`)]);
    expect(ps.length).toBe(29);
    expect(ps.every((p) => [...p].length === 40)).toBe(true);
  });
});

describe('提示词和 responseSchema', () => {
  it('两份提示词填完没有漏下的 {{…}}；今天、星期、时刻、时区按 now、tz 算', () => {
    for (const tpl of [PARSE_V3, PARSE_V4, VOICE_V4]) {
      const p = fillPrompt(tpl, { now: NOW, tz: 'Asia/Seoul', locale: 'ko', features: ['event', 'todo'] }, checkDefaultDay).system;
      expect(/\{\{[^}]*\}\}/.test(p)).toBe(false);
      expect(p).toContain('2026-10-28');
      expect(p).toContain('Asia/Seoul');
    }
    expect(wallOf(NOW, 'Asia/Seoul')).toEqual({ today: '2026-10-28', weekday: '周三', time: '12:00' });
    expect(wallOf(NOW, 'America/Los_Angeles')).toEqual({ today: '2026-10-27', weekday: '周二', time: '20:00' });
  });
  it('Q2：responseSchema 里没有 intent；kind 只放能用的类型；没有 anniv 时整个 anniv 键不出现；录音多 transcript', () => {
    const s = responseSchema(['event', 'todo'], false);
    const text = JSON.stringify(s);
    expect(text).not.toContain('intent');
    expect(text).not.toContain('anniv');
    expect(text).not.toContain('confirm');
    const props = (s as { properties: { items: { items: { properties: { kind: { enum: string[] } } } } } }).properties.items.items.properties;
    expect(props.kind.enum).toEqual(['event', 'todo']);
    expect(JSON.stringify(responseSchema(['event', 'anniv'], false))).toContain('"anniv"');
    expect((responseSchema(['event'], true) as { required: string[] }).required).toEqual(['transcript', 'items']);
  });
});

describe('TC-B3-48：生成参数只有一份', () => {
  it('六种用途一律 temperature 0、candidateCount 1（正式 voice 也不带思考档位，只有探测页带 minimal，11-11 架构复审定）；超时 parse 5 秒、voice 15 秒', () => {
    for (const k of ['parse', 'voice', 'classify', 'media', 'intent', 'summarize'] as const) expect(TASK_PARAMS[k]).toEqual({ temperature: 0, candidateCount: 1 });
    expect(VOICE_PROBE_PARAMS).toEqual({ temperature: 0, candidateCount: 1, thinkingLevel: 'minimal' });
    expect(geminiBody({ system: 's', parts: [], schema: {}, params: VOICE_PROBE_PARAMS, timeoutMs: 1 }).generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'minimal' } });
    expect(geminiBody({ system: 's', parts: [], schema: {}, params: TASK_PARAMS.voice, timeoutMs: 1 }).generationConfig).not.toHaveProperty('thinkingConfig');
    expect(geminiBody({ system: 's', parts: [], schema: {}, params: TASK_PARAMS.parse, timeoutMs: 1 }).generationConfig).not.toHaveProperty('thinkingConfig');
    expect(GEN_PARAMS).toEqual({ temperature: 0, candidateCount: 1 });
    expect([PARSE_TIMEOUT_MS, VOICE_TIMEOUT_MS]).toEqual([5000, 15000]);
  });
  it('parseWithAI 送给服务商的就是 params.ts 那一份、5 秒超时；voiceWithAI 15 秒、音频按去参数的类型内联', async () => {
    const p = new StubProvider(() => okJson({ items: [EV] }));
    await parseWithAI(input(), p);
    expect(p.calls[0]?.params).toBe(TASK_PARAMS.parse);
    expect(p.calls[0]?.timeoutMs).toBe(PARSE_TIMEOUT_MS);
    expect(p.calls[0]?.parts).toEqual([{ text: '<projects>["NEOX"]</projects>\n<data>明天下午三点开会</data>' }]);
    const v = new StubProvider(() => okJson({ transcript: 't', items: [] }));
    const audio = new Uint8Array([1, 2, 3]);
    await voiceWithAI({ ...input(), audio, mime: 'audio/webm' }, v);
    expect(v.calls[0]?.timeoutMs).toBe(VOICE_TIMEOUT_MS);
    expect(v.calls[0]?.parts[1]).toEqual({ inlineData: { mimeType: 'audio/webm', data: audio } });
  });
});

describe('parseWithAI：成功、校验没过、服务商失败', () => {
  it('成功：返回校验后的条目、原始输出和提示词版本', async () => {
    const r = await parseWithAI(input(), new StubProvider(() => okJson({ items: [EV] })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(itemsOf(r.value).map((i) => [i.kind, i.date, i.time, i.confirm])).toEqual([['event', '2026-10-29', '15:00', null]]);
    expect(r.raw).toEqual({ items: [EV] });
    expect(r.prompt).toBe(PROMPT_VERSION.parse);
  });
  it('TC-B3-50：缺 date_basis 整份 invalid，带上原始输出和原因', async () => {
    const r = await parseWithAI(input(), new StubProvider(() => okJson({ items: [{ ...EV, date_basis: undefined }] })));
    expect(r).toMatchObject({ ok: false, reason: 'invalid', invalid_reasons: ['missing_date_basis'] });
  });
  it('类型不在 features 里（开关关着的 anniv）算 invalid / not_whitelisted', async () => {
    const r = await parseWithAI(input(), new StubProvider(() => okJson({ items: [{ kind: 'note', title: 'x' }] })));
    expect(r).toMatchObject({ ok: false, reason: 'invalid', invalid_reasons: ['not_whitelisted'] });
  });
  it('quota、timeout、error 原样带出（只带原因、HTTP 状态和异常类型名，给 ai-voice 写 logs 用；不带服务商正文）', async () => {
    for (const reason of ['quota', 'timeout', 'error'] as const) {
      expect(await parseWithAI(input(), new StubProvider(() => ({ ok: false, reason, status: 429 })))).toEqual({ ok: false, reason, status: 429 });
    }
    expect(await parseWithAI(input(), new StubProvider(() => ({ ok: false, reason: 'timeout', errName: 'AbortError' })))).toEqual({ ok: false, reason: 'timeout', errName: 'AbortError' });
  });
});

describe('Gemini 适配（TC-B3-24）', () => {
  const req = { system: 'S', parts: [{ text: 'T' }], schema: { type: 'OBJECT' }, params: TASK_PARAMS.parse, timeoutMs: 1000 };
  const geminiOk = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

  it('密钥只在 x-goog-api-key 请求头，URL 里没有；地址带模型名；请求体是 systemInstruction + contents + generationConfig', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const g = new GeminiProvider('gemini-2.5-flash', 'SECRET-KEY', async (url, init) => {
      seen.push({ url, init });
      return geminiOk('{"items":[]}');
    });
    expect(await g.generate(req)).toEqual({ ok: true, json: { items: [] }, raw: '{"items":[]}' });
    const s = seen[0];
    expect(s?.url).toBe(`${GEMINI_BASE}gemini-2.5-flash:generateContent`);
    expect(s?.url).not.toContain('SECRET-KEY');
    expect(s?.url).not.toContain('key=');
    expect((s?.init.headers as Record<string, string>)['x-goog-api-key']).toBe('SECRET-KEY');
    expect(JSON.parse(String(s?.init.body))).toEqual({
      systemInstruction: { parts: [{ text: 'S' }] },
      contents: [{ role: 'user', parts: [{ text: 'T' }] }],
      generationConfig: { temperature: 0, candidateCount: 1, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } },
    });
  });
  it('音频内联成 base64；模型名不合规、没密钥直接拒', () => {
    expect(geminiBody({ ...req, parts: [{ inlineData: { mimeType: 'audio/aac', data: new Uint8Array([104, 105]) } }] }).contents)
      .toEqual([{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/aac', data: 'aGk=' } }] }]);
    expect(toBase64(new Uint8Array(70_000)).length).toBe(Math.ceil(70_000 / 3) * 4);
    expect(() => new GeminiProvider('../x', 'k', fetch)).toThrow();
    expect(() => new GeminiProvider('gemini', '', fetch)).toThrow();
  });
  it('429 RESOURCE_EXHAUSTED 当 quota；别的 429、500、不是 JSON、没有候选都当 error；只带状态码', async () => {
    const at = (res: Response) => new GeminiProvider('m', 'k', async () => res).generate(req);
    expect(await at(new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 }))).toEqual({ ok: false, reason: 'quota', status: 429, quotaKind: 'unknown', retryMs: null });
    expect(await at(new Response('{}', { status: 429 }))).toEqual({ ok: false, reason: 'error', status: 429 });
    expect(await at(new Response('boom', { status: 500 }))).toEqual({ ok: false, reason: 'error', status: 500 });
    // 11-13 ai-eval #3：503 带上谷歌 error.status 的固定名字；不认识的名字、message 都不带
    expect(await at(new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }), { status: 503 })))
      .toEqual({ ok: false, reason: 'error', status: 503, errName: 'UNAVAILABLE' });
    expect(await at(new Response(JSON.stringify({ error: { status: 'secret text' } }), { status: 500 }))).toEqual({ ok: false, reason: 'error', status: 500 });
    expect(await at(geminiOk('not json'))).toEqual({ ok: false, reason: 'error', status: 200 });
    expect(await at(new Response(JSON.stringify({ candidates: [] }), { status: 200 }))).toEqual({ ok: false, reason: 'error', status: 200 });
  });
  // 11-13 ai-eval #2：429 分不出每分钟、每天，一次短时撞限就停一整天。结构照 google.rpc 标准错误详情（googleapis error_details.proto）
  describe('429 回复体分出额度类型（QuotaFailure.violations[].quotaId、RetryInfo.retryDelay）', () => {
    const QF = 'type.googleapis.com/google.rpc.QuotaFailure';
    const RI = 'type.googleapis.com/google.rpc.RetryInfo';
    const body = (ids: unknown[], delay?: unknown, extra: unknown[] = []) => ({
      error: {
        code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota 秘密原文',
        details: [{ '@type': QF, violations: ids.map((quotaId) => ({ quotaMetric: 'generativelanguage.googleapis.com/x', quotaId })) },
          ...(delay === undefined ? [] : [{ '@type': RI, retryDelay: delay }]), ...extra],
      },
    });
    it('quotaId 带 PerDay 是 day（每天用完时 retryDelay 照样读出来，但调用方不看）；全部带 PerMinute 是 minute', () => {
      expect(quotaInfo(body(['GenerateRequestsPerDayPerProjectPerModel-FreeTier'], '1s'))).toEqual({ quotaKind: 'day', retryMs: 1000 });
      expect(quotaInfo(body(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier'], '12s'))).toEqual({ quotaKind: 'minute', retryMs: 12_000 });
      expect(quotaInfo(body(['GenerateContentInputTokensPerModelPerMinute-FreeTier', 'GenerateRequestsPerMinutePerProjectPerModel']))).toEqual({ quotaKind: 'minute', retryMs: null });
      // 每分钟和每天一起撞了：按 day
      expect(quotaInfo(body(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'], '30s'))?.quotaKind).toBe('day');
    });
    it('认不出一律 unknown：没有 details、没有 QuotaFailure、quotaId 不是字符串、混着别的限额名、PerDays 这类不是整词', () => {
      for (const b of [
        { error: { status: 'RESOURCE_EXHAUSTED' } },
        { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': RI, retryDelay: '5s' }] } },
        { error: { status: 'RESOURCE_EXHAUSTED', details: 'x' } },
        body([]), body([123]), body([null]),
        body(['GenerateRequestsPerMinutePerProjectPerModel', 'SomethingPerHour']),
        body(['GenerateRequestsPerMinutePerProjectPerModel', 42]),
        body(['perminute', 'PERDAY', 'RequestsPerDays']),
      ]) expect(quotaInfo(b)?.quotaKind, JSON.stringify(b)).toBe('unknown');
      expect(quotaInfo({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': RI, retryDelay: '5s' }] } })).toEqual({ quotaKind: 'unknown', retryMs: 5000 });
    });
    it('不是 RESOURCE_EXHAUSTED、不是对象：null（当 error）', () => {
      for (const b of [null, 'x', [], {}, { error: null }, { error: { status: 'UNAVAILABLE' } }, { error: [] }]) expect(quotaInfo(b)).toBeNull();
    });
    it('retryDelay：google.protobuf.Duration 的 JSON 写法（秒 + 最多 9 位小数 + s），小数向上取整到毫秒；别的写法 null', () => {
      expect([retryDelayMs('12s'), retryDelayMs('0s'), retryDelayMs('0.5s'), retryDelayMs('1.000340012s'), retryDelayMs('34.9s'), retryDelayMs('0.0001s')])
        .toEqual([12_000, 0, 500, 1001, 34_900, 1]);
      for (const v of ['12', '-1s', '1.5ms', ' 12s', '12s ', '1.s', '.5s', '1e3s', '1.0000000001s', '1234567890s', 12, null, undefined, { seconds: 12 }, '']) expect(retryDelayMs(v), String(v)).toBeNull();
    });
    it('经 GeminiProvider：429 只带出 quotaKind、retryMs 和状态码，不带回复原文；回复体不是 JSON 当 error', async () => {
      const at = (res: Response) => new GeminiProvider('m', 'k', async () => res).generate(req);
      const r = await at(new Response(JSON.stringify(body(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier'], '12s')), { status: 429 }));
      expect(r).toEqual({ ok: false, reason: 'quota', status: 429, quotaKind: 'minute', retryMs: 12_000 });
      expect(JSON.stringify(r)).not.toContain('秘密原文');
      expect(JSON.stringify(r)).not.toContain('FreeTier');
      expect(await at(new Response(JSON.stringify(body(['GenerateRequestsPerDayPerProjectPerModel-FreeTier'], '1s')), { status: 429 })))
        .toEqual({ ok: false, reason: 'quota', status: 429, quotaKind: 'day', retryMs: 1000 });
      expect(await at(new Response('<html>Too Many Requests</html>', { status: 429 }))).toEqual({ ok: false, reason: 'error', status: 429 });
      // 别的状态码带着 RESOURCE_EXHAUSTED 也不当 quota（只认 429），只把固定名字带进 errName
      expect(await at(new Response(JSON.stringify(body(['GenerateRequestsPerMinutePerProjectPerModel'], '1s')), { status: 503 }))).toEqual({ ok: false, reason: 'error', status: 503, errName: 'RESOURCE_EXHAUSTED' });
    });
    it('parseWithAI、voiceWithAI 把 quotaKind、retryMs 原样传给调用方', async () => {
      const q = { ok: false as const, reason: 'quota' as const, status: 429, quotaKind: 'minute' as const, retryMs: 7000 };
      expect(await parseWithAI(input(), new StubProvider(() => q))).toEqual(q);
      expect(await voiceWithAI({ ...input(), audio: new Uint8Array([1]), mime: 'audio/webm' }, new StubProvider(() => q))).toEqual(q);
    });
  });
  it('到点中止当 timeout，不重试；网络错当 error', async () => {
    let calls = 0;
    const hang = new GeminiProvider('m', 'k', (_u, init) => {
      calls++;
      return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(init.signal?.reason)));   // 同真的 fetch：以 signal.reason 拒绝
    });
    expect(await hang.generate({ ...req, timeoutMs: 20 })).toEqual({ ok: false, reason: 'timeout', errName: 'TimeoutError' });
    expect(calls).toBe(1);
    expect(await new GeminiProvider('m', 'k', async () => { throw new TypeError('net secret'); }).generate(req)).toEqual({ ok: false, reason: 'error', errName: 'TypeError' });
  });
});

describe('router：app_config.ai → 服务商', () => {
  it('读配置：格式不对按默认，global_daily 读不出当 null', () => {
    expect(readAiConfig(null)).toEqual({ provider: null, model: null, per_user_daily: 50, global_daily: null });
    expect(readAiConfig({ provider: 'gemini', model: 'm', per_user_daily: 20, global_daily: 300 })).toEqual({ provider: 'gemini', model: 'm', per_user_daily: 20, global_daily: 300 });
    expect(readAiConfig({ per_user_daily: -1, global_daily: 1.5, model: '' })).toEqual({ provider: null, model: null, per_user_daily: 50, global_daily: null });
  });
  it('模型没配、密钥没配、别的服务商、模型名不合规都回 null（调用方当没配好）', () => {
    const cfg = readAiConfig({ model: 'gemini-x' });
    expect(pickProvider(cfg, 'k', fetch)?.name).toBe('gemini');
    expect(pickProvider(cfg, undefined, fetch)).toBe(null);
    expect(pickProvider(readAiConfig({}), 'k', fetch)).toBe(null);
    expect(pickProvider(readAiConfig({ provider: 'openai', model: 'x' }), 'k', fetch)).toBe(null);
    expect(pickProvider(readAiConfig({ model: 'a/b' }), 'k', fetch)).toBe(null);
  });
});

// 代码审建议 8：parse-core.ts 为了不 import gen 另写了一份常量和类型，这里核对两边一致（改了一边忘了另一边会失败）
describe('parse-core.ts 和 shared/schema/ai.ts 的常量一致', () => {
  it('TEXT_MAX、PROJECTS_MAX、PROJECT_LEN 相等；AiKindLike、InvalidReasonLike 和 shared 的取值完全相同', () => {
    expect([TEXT_MAX, PROJECTS_MAX, PROJECT_LEN]).toEqual([AI_TEXT_MAX, AI_PROJECTS_MAX, AI_PROJECT_LEN]);
    // 类型层面双向可赋值（不一致时 typecheck 失败）
    const kinds: readonly AiKindLike[] = AI_KINDS;
    const back: readonly AiKind[] = ['event', 'todo', 'note', 'anniv'] satisfies AiKindLike[];
    expect([...kinds].sort()).toEqual([...back].sort());
    const reasons: readonly InvalidReasonLike[] = INVALID_REASONS;
    const reasonsBack: readonly InvalidReason[] = ['missing_date_basis', 'bad_date', 'not_whitelisted', 'out_of_range', 'schema', 'empty'] satisfies InvalidReasonLike[];
    expect([...reasons].sort()).toEqual([...reasonsBack].sort());
  });
});
