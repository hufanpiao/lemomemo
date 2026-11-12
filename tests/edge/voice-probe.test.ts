// voice-probe（预览专用、一次性的录音格式探测函数；supabase/functions/_preview/voice-probe/，B3 任务单 BE-0、Q1 ①～⑨，
// 说明见 docs/09-路线图/B3-voice-probe探测函数.md）。照 db-probe.test.ts 的写法：依赖全注入，Gemini 用真的 GeminiProvider 配假 fetch。
// 证明：只在预览项目生效；到期 410；只收 POST；白名单是占位值时 500；令牌无效、不在白名单一律 404；模型只认两个、没有默认值；
// 类型照 ai-voice 只认 4 种（带参数先去参数、回显原始标注）；边读边计数 600 KB；每天 100 次（太平洋日期、整个有效期在同一个计数窗口）；
// 密钥只在 x-goog-api-key；（源码守门、和 db-probe / ai-voice 的常量一致、计数窗口对齐在 voice-probe-guard.test.ts）Gemini 成功、额度用完、出错、超时、坏输出各自如实回；日志只有允许的字段，不带转写和音频。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_UIDS, DAILY_LIMIT, EXPIRES_AT, handle, MAX_TRANSCRIPT, MODELS, PREVIEW_REF, PROBE_INSTRUCTION,
  QUOTA_WINDOW_S, quotaKey, rawLabel, type HandlerDeps, type ProbeLog,
} from '../../supabase/functions/_preview/voice-probe/handler.ts';
import { AI_AUDIO_MAX_BYTES, audioType } from '../../shared/schema/ai.ts';
import { pacificDate } from '../../supabase/functions/_shared/ai/gate.ts';
import { GEMINI_BASE, GeminiProvider, type Fetch } from '../../supabase/functions/_shared/ai/gemini.ts';
import { VOICE_TIMEOUT_MS } from '../../supabase/functions/_shared/ai/params.ts';

const PREVIEW_URL = `https://${PREVIEW_REF}.supabase.co`;
const NOW = Date.UTC(2026, 10, 10, 3, 0);
const UID = '1a2b3c4d-1111-4222-8333-444455556666';
const OTHER = '9f8e7d6c-1111-4222-8333-444455556666';
const JWT = `eyJhbGciOi.${'a'.repeat(40)}.sig_${'b'.repeat(20)}`;
const KEY = 'test-key-not-real';
const SAID = '明天下午三点和老王开会';

const gem = (o: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] } : o), { status });

function setup(o: Partial<HandlerDeps> & { reply?: Fetch; takeOk?: boolean | 'throw' | undefined; who?: string | null | 'throw' | undefined } = {}) {
  const calls = { verify: [] as string[], take: [] as [string, number, number][], provider: [] as string[], fetch: [] as { url: string; init: RequestInit }[] };
  const logs: ProbeLog[] = [];
  const reply: Fetch = o.reply ?? (async () => gem({ transcript: SAID }));
  const deps: HandlerDeps = {
    supabaseUrl: PREVIEW_URL, maxAudio: AI_AUDIO_MAX_BYTES, audioType,
    now: () => NOW,
    clock: () => 0,
    async verify(jwt) {
      calls.verify.push(jwt);
      if (o.who === 'throw') throw new Error('net');
      return o.who === undefined ? UID : o.who;
    },
    async take(key, limit, w) {
      calls.take.push([key, limit, w]);
      if (o.takeOk === 'throw') throw new Error('db');
      return o.takeOk ?? true;
    },
    provider(model, seen) {
      calls.provider.push(model);
      // 同 index.ts：拿到 HTTP 响应就报状态码
      return new GeminiProvider(model, KEY, async (url, init) => {
        calls.fetch.push({ url, init });
        const res = await reply(url, init);
        seen(res.status);
        return res;
      });
    },
    log: (e) => logs.push(e),
    allowed: [UID],
    ...o,
  };
  return { deps, calls, logs };
}

const req = (h: Record<string, string> = {}, body: BodyInit | null = new Uint8Array(1000), method = 'POST') =>
  new Request('http://kong/functions/v1/voice-probe', {
    method,
    headers: { authorization: `Bearer ${JWT}`, 'x-model': MODELS[0], 'content-type': 'audio/mp4', ...h },
    body: method === 'GET' || method === 'HEAD' ? null : body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
const call = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('cache-control') });

afterEach(() => {
  vi.useRealTimers();
});

describe('voice-probe：环境、到期、方法、白名单（Q1 ①②③）', () => {
  it.each([
    ['没设', undefined],
    ['正式项目', 'https://abcdefghijklmnopqrst.supabase.co'],
    ['预览 ref 当子串', `https://x${PREVIEW_REF}.supabase.co`],
    ['换了域名', `https://${PREVIEW_REF}.supabase.co.evil.example`],
    ['http', `http://${PREVIEW_REF}.supabase.co`],
    ['带路径', `${PREVIEW_URL}/functions/v1`],
    ['带端口', `${PREVIEW_URL}:443`],
    ['大写', PREVIEW_URL.toUpperCase()],
  ])('SUPABASE_URL %s → 404，不验令牌、不计数、不调 Gemini', async (_, url) => {
    const s = setup({ supabaseUrl: url });
    const r = await call(await handle(req(), s.deps));
    expect([r.status, r.body]).toEqual([404, { error: 'not_found' }]);
    expect([s.calls.verify, s.calls.take, s.calls.provider]).toEqual([[], [], []]);
  });

  it('失效时间是 2026-11-17 24:00（首尔）：前 1 毫秒照常，到点起一律 410，不验令牌', async () => {
    expect(new Date(EXPIRES_AT).toISOString()).toBe('2026-11-17T15:00:00.000Z');
    const before = setup({ now: () => EXPIRES_AT - 1 });
    expect((await handle(req(), before.deps)).status).toBe(200);
    for (const t of [EXPIRES_AT, EXPIRES_AT + 86_400_000]) {
      const s = setup({ now: () => t });
      expect(await call(await handle(req(), s.deps))).toMatchObject({ status: 410, body: { error: 'expired' } });
      expect(s.calls.verify).toEqual([]);
    }
  });

  it('只收 POST：别的方法在鉴权前回 404（不回 405，安全审建议 1），不验令牌', async () => {
    for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const s = setup();
      const r = await call(await handle(req({}, null, m), s.deps));
      expect([r.status, r.body], m).toEqual([404, { error: 'not_found' }]);
      expect(s.calls.verify).toEqual([]);
    }
  });

  it('白名单为空或有格式不对的项 → 404（不回 500，安全审建议 1；日志记 misconfigured），不验令牌、不计数', async () => {
    for (const allowed of [[], ['not-a-uuid'], [UID.toUpperCase()], [UID, ` ${OTHER}`]]) {
      const s = setup({ allowed });
      const r = await call(await handle(req(), s.deps));
      expect([r.status, r.body], JSON.stringify(allowed)).toEqual([404, { error: 'not_found' }]);
      expect([s.calls.verify, s.calls.take]).toEqual([[], []]);
      expect(s.logs).toEqual([{ code: 'misconfigured' }]);
    }
  });

  it('仓库里的白名单正好是主持人 11-09 核对的两个账号（负责人的预览验收账号、QA 的 .test 账号），没有占位值；用真名单时这两个能过、别人 404', async () => {
    expect([...ALLOWED_UIDS]).toEqual(['7aa8c4cb-11ba-4e9e-aa6f-72196dfe3f8b', '8380dfe1-44e2-4eca-b8d2-7fef8f719305']);
    expect(ALLOWED_UIDS).toContain('7aa8c4cb-11ba-4e9e-aa6f-72196dfe3f8b');   // 负责人的预览验收账号（原 db-probe 的 TEST_UID）
    for (const who of ALLOWED_UIDS) {
      const { allowed: _drop, ...deps } = setup({ who }).deps;   // 不注入名单，走仓库里的 ALLOWED_UIDS
      expect((await handle(req(), deps)).status, who).toBe(200);
    }
    const { allowed: _d2, ...stranger } = setup({ who: UID }).deps;
    expect((await handle(req(), stranger)).status).toBe(404);
  });
});

describe('voice-probe：自己验 JWT、白名单（Q1 ②）', () => {
  it('没带令牌、格式不对、令牌无效、不在白名单 → 一律 404（不说是哪一种），不计数、不调 Gemini', async () => {
    const cases: [Record<string, string>, string | null | undefined][] = [
      [{ authorization: '' }, undefined],
      [{ authorization: `Basic ${JWT}` }, undefined],
      [{ authorization: 'Bearer short' }, undefined],
      [{}, null],
      [{}, OTHER],
    ];
    for (const [h, who] of cases) {
      const s = setup({ who });
      const r = await call(await handle(req(h), s.deps));
      expect([r.status, r.body], JSON.stringify([h, who])).toEqual([404, { error: 'not_found' }]);
      expect([s.calls.take, s.calls.provider]).toEqual([[], []]);
    }
  });
  it('验令牌连不上 → 503 try_later', async () => {
    const s = setup({ who: 'throw' });
    expect(await call(await handle(req(), s.deps))).toMatchObject({ status: 503, body: { error: 'try_later' } });
    expect(s.calls.take).toEqual([]);
  });
  it('验的是 Authorization 里的那个令牌', async () => {
    const s = setup();
    await handle(req(), s.deps);
    expect(s.calls.verify).toEqual([JWT]);
  });
});

describe('voice-probe：模型、类型、大小（Q1 ⑤）', () => {
  it('模型只认 Q6 的两个，由 X-Model 指定，没有默认值；不对回 400，不计数', async () => {
    expect([...MODELS]).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
    for (const m of [undefined, '', 'gemini-2.0-flash', 'GEMINI-3.1-FLASH-LITE', 'gemini-3.1-flash-lite-preview']) {
      const h: Record<string, string> = m === undefined ? {} : { 'x-model': m };
      const r0 = req(h);
      if (m === undefined) r0.headers.delete('x-model');
      const s = setup();
      expect(await call(await handle(m === undefined ? r0 : req(h), s.deps)), String(m)).toMatchObject({ status: 400, body: { error: 'bad_model' } });
      expect(s.calls.take).toEqual([]);
    }
    for (const m of MODELS) {
      const s = setup();
      const r = await call(await handle(req({ 'x-model': m }), s.deps));
      expect([r.status, r.body['model']]).toEqual([200, m]);
      expect(s.calls.fetch[0]?.url).toBe(`${GEMINI_BASE}${m}:generateContent`);
    }
  });

  it('测法里的四种标注：去参数后送给 Gemini，回显收到的原始标注', async () => {
    for (const [ct, mime] of [['audio/mp4', 'audio/mp4'], ['audio/aac', 'audio/aac'], ['audio/webm', 'audio/webm'], ['audio/webm;codecs=opus', 'audio/webm'], ['Audio/MP4; codecs="mp4a.40.2"', 'audio/mp4']]) {
      const s = setup();
      const r = await call(await handle(req({ 'content-type': ct as string }), s.deps));
      expect([r.status, r.body['mime'], r.body['raw_type']], ct).toEqual([200, mime, ct]);
      const sent = JSON.parse(String(s.calls.fetch[0]?.init.body)) as { contents: { parts: { text?: string; inlineData?: { mimeType: string } }[] }[] };
      expect(sent.contents[0]?.parts[0]?.text).toBe(PROBE_INSTRUCTION);
      expect(sent.contents[0]?.parts[1]?.inlineData?.mimeType).toBe(mime);
      // responseSchema 用大写写法，和正式 parse-core 一致（代码审 S1）
      expect((sent as unknown as { generationConfig: { responseSchema: unknown } }).generationConfig.responseSchema)
        .toEqual({ type: 'OBJECT', properties: { transcript: { type: 'STRING' } }, required: ['transcript'] });
    }
  });

  it('不在 4 种里 → 415，回显原始标注；不可打印或超长的标注换成 (invalid)；不计数、不调 Gemini', async () => {
    const s = setup();
    expect(await call(await handle(req({ 'content-type': 'audio/ogg;codecs=opus' }), s.deps))).toMatchObject({ status: 415, body: { error: 'unsupported_type', raw_type: 'audio/ogg;codecs=opus' } });
    expect([s.calls.take, s.calls.provider]).toEqual([[], []]);
    expect(rawLabel(null)).toBeNull();
    expect(rawLabel(`audio/x-${'a'.repeat(100)}`)).toBe('(invalid)');
    expect(rawLabel('audio/é')).toBe('(invalid)');
  });

  it('正好 600 KB 收；多 1 字节回 413，不计数；不带 Content-Length 的分块上传读到超限就中断；空的回 400', async () => {
    const ok = setup();
    const r = await call(await handle(req({}, new Uint8Array(AI_AUDIO_MAX_BYTES)), ok.deps));
    expect([r.status, r.body['bytes']]).toEqual([200, AI_AUDIO_MAX_BYTES]);
    const big = setup();
    expect((await handle(req({}, new Uint8Array(AI_AUDIO_MAX_BYTES + 1)), big.deps)).status).toBe(413);
    expect(big.calls.take).toEqual([]);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 400) c.close();
        else c.enqueue(new Uint8Array(4096));
      },
    });
    expect((await handle(req({}, stream), setup().deps)).status).toBe(413);
    expect(pulled).toBeLessThan(200);
    const empty = setup();
    expect(await call(await handle(req({}, new Uint8Array(0)), empty.deps))).toMatchObject({ status: 400, body: { error: 'empty' } });
    expect([empty.calls.take, empty.logs]).toEqual([[], [{ code: 'empty' }]]);   // 空正文只记事件码（代码审 S5）
  });
});

describe('voice-probe：每天额度（Q1 ④）', () => {
  it('键是 voice_probe:global:<太平洋日期>，上限 100，窗口 30 天；到上限 429、不调 Gemini；计数出错 503', async () => {
    const s = setup();
    await handle(req(), s.deps);
    expect(s.calls.take).toEqual([[`voice_probe:global:${pacificDate(NOW)}`, DAILY_LIMIT, QUOTA_WINDOW_S]]);
    expect([DAILY_LIMIT, QUOTA_WINDOW_S]).toEqual([100, 2_592_000]);
    expect(quotaKey(NOW)).toMatch(/^[a-z][a-z0-9_-]*:global:\d{4}-\d{2}-\d{2}$/);   // counters 的键约束（同 ai-fakes.ts 的 COUNTER_KEY）
    const full = setup({ takeOk: false });
    expect(await call(await handle(req(), full.deps))).toMatchObject({ status: 429, body: { error: 'daily_limit', limit: 100 } });
    expect(full.calls.fetch).toEqual([]);   // 先查密钥再计数（S4），所以 provider 已建好，但不调 Gemini
    const down = setup({ takeOk: 'throw' });
    expect(await call(await handle(req(), down.deps))).toMatchObject({ status: 503, body: { error: 'try_later' } });
    expect(down.calls.fetch).toEqual([]);
  });
});

describe('voice-probe：调 Gemini 和返回（Q1 ⑤⑥）', () => {
  it('成功：回 {model, mime, raw_type, bytes, gemini_http, gemini_ms, total_ms, result, transcript, retried}，no-store；密钥只在 x-goog-api-key、不在地址里', async () => {
    const s = setup();
    const r = await call(await handle(req(), s.deps));
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    expect(Object.keys(r.body).sort()).toEqual(['bytes', 'gemini_http', 'gemini_ms', 'mime', 'model', 'raw_type', 'result', 'retried', 'total_ms', 'transcript']);
    expect(r.body).toMatchObject({ mime: 'audio/mp4', raw_type: 'audio/mp4', bytes: 1000, gemini_http: 200, result: 'ok', transcript: SAID, retried: false });
    const f = s.calls.fetch[0];
    expect(new Headers(f?.init.headers).get('x-goog-api-key')).toBe(KEY);
    expect(f?.url).not.toContain(KEY);
    expect(f?.url).not.toContain('?');
  });

  it('额度用完、出错、坏输出：照样回 200，result 和 gemini_http 如实写，没有转写', async () => {
    const cases: [Fetch, string, number | null][] = [
      [async () => gem({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429), 'quota', 429],
      [async () => gem({ error: { status: 'INVALID_ARGUMENT', message: `unsupported ${SAID}` } }, 400), 'error', 400],
      [async () => gem({ error: {} }, 500), 'error', 500],
      [async () => gem({ text: 'x' }), 'bad_output', 200],
      [async () => new Response('not json', { status: 200 }), 'error', 200],
      [async () => { throw new TypeError('network'); }, 'error', null],
    ];
    for (const [reply, result, http] of cases) {
      const s = setup({ reply });
      const r = await call(await handle(req(), s.deps));
      expect([r.status, r.body['result'], r.body['gemini_http'], r.body['transcript']], result).toEqual([200, result, http, null]);
      expect(JSON.stringify(r.body)).not.toContain(SAID);   // Gemini 出错时的返回正文不回显
    }
  });

  it('超时：15 秒中止，result = timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hang: Fetch = (_u, init) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    const s = setup({ reply: hang });
    let settled = false;
    const p = handle(req(), s.deps).then((r) => {
      settled = true;
      return r;
    });
    for (let i = 0; i < 1000 && s.calls.fetch.length === 0; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(VOICE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);   // 差 1 ms 到 15 秒还没中止（代码审 S6）
    await vi.advanceTimersByTimeAsync(1);
    expect((await call(await p)).body).toMatchObject({ result: 'timeout', gemini_http: null, transcript: null });
  });

  it('响应头到了、读正文时超时：result = timeout，gemini_http 置空（不显示成“200 + timeout”，代码审 S2）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slowBody: Fetch = async (_u, init) => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        init.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('x'), { name: 'AbortError' })));
      },
    }), { status: 200 });
    const s = setup({ reply: slowBody });
    const p = handle(req(), s.deps);
    for (let i = 0; i < 1000 && s.calls.fetch.length === 0; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(VOICE_TIMEOUT_MS);
    expect((await call(await p)).body).toMatchObject({ result: 'timeout', gemini_http: null, transcript: null });
  });

  it('没配 Gemini 密钥 → 500 misconfigured，不扣次数（代码审 S4）', async () => {
    const s = setup({ provider: () => null });
    expect(await call(await handle(req(), s.deps))).toMatchObject({ status: 500, body: { error: 'misconfigured' } });
    expect(s.calls.take).toEqual([]);
    expect(s.logs.map((e) => e.code)).toEqual(['misconfigured']);
  });

  it('转写最多回显 2000 字', async () => {
    const s = setup({ reply: async () => gem({ transcript: '字'.repeat(MAX_TRANSCRIPT + 50) }) });
    expect(((await call(await handle(req(), s.deps))).body['transcript'] as string).length).toBe(MAX_TRANSCRIPT);
  });

  it('日志只有事件码、mime、字节数、HTTP 状态、耗时；不带转写、音频、令牌、原始标注', async () => {
    const audio = new TextEncoder().encode(`AUDIO-${SAID}`);
    const all: ProbeLog[] = [];
    for (const o of [{}, { who: OTHER }, { takeOk: false }, { reply: async () => gem({ error: { message: SAID } }, 400) }] as Parameters<typeof setup>[0][]) {
      const s = setup(o);
      await handle(req({ 'content-type': 'audio/webm;codecs=opus' }, audio), s.deps);
      all.push(...s.logs);
    }
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) expect(Object.keys(e).every((k) => ['code', 'mime', 'bytes', 'http', 'ms'].includes(k)), JSON.stringify(e)).toBe(true);
    const text = JSON.stringify(all);
    for (const bad of [SAID, 'AUDIO-', JWT, 'codecs', UID, OTHER]) expect(text, bad).not.toContain(bad);
    expect(all.map((e) => e.code)).toEqual(['gemini_ok', 'not_allowed', 'daily_limit', 'gemini_error']);
  });
});
