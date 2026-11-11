// voice-probe 11-11 改动（B3 iPhone 实测后）：系统提示加主语言和逐字转写要求、音频前加文字指令、Gemini 503 重试一次。
// 其余行为见 voice-probe.test.ts（那边超 300 行，新用例放这里）。服务商用真的 GeminiProvider 套假 fetch，不联网。
import { describe, expect, it } from 'vitest';
import { handle, PREVIEW_REF, PROBE_INSTRUCTION, PROBE_SYSTEM, type HandlerDeps, type ProbeLog } from '../../supabase/functions/_preview/voice-probe/handler.ts';
import { GeminiProvider, type Fetch } from '../../supabase/functions/_shared/ai/gemini.ts';

const UID = '1a2b3c4d-1111-4222-8333-444455556666';
const JWT = `eyJhbGciOi.${'a'.repeat(40)}.sig_${'b'.repeat(20)}`;
const SAID = '买牛奶';
const gem = (o: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] } : o), { status });

function setup(reply: Fetch) {
  const fetches: RequestInit[] = [];
  const logs: ProbeLog[] = [];
  const deps: HandlerDeps = {
    supabaseUrl: `https://${PREVIEW_REF}.supabase.co`,
    now: () => Date.UTC(2026, 10, 11, 3, 0),
    clock: () => 0,
    verify: async () => UID,
    take: async () => true,
    provider: (model, seen) => new GeminiProvider(model, 'test-key-not-real', async (url, init) => {
      fetches.push(init);
      const res = await reply(url, init);
      seen(res.status);
      return res;
    }),
    log: (e) => logs.push(e),
    allowed: [UID],
    sleep: async () => {},
  };
  return { deps, fetches, logs };
}
const req = () => new Request('http://kong/functions/v1/voice-probe', {
  method: 'POST', body: new Uint8Array(1000),
  headers: { authorization: `Bearer ${JWT}`, 'x-model': 'gemini-3.5-flash-lite', 'content-type': 'audio/mp4' },
});
const call = async (s: ReturnType<typeof setup>) => (await (await handle(req(), s.deps)).json()) as Record<string, unknown>;
const E503 = async () => gem({ error: { status: 'UNAVAILABLE' } }, 503);

describe('voice-probe 11-11：提示词', () => {
  it('系统提示：主语言简体中文、可能夹韩文；逐字转写、不翻译不改写不补字、汉字之间不加空格', () => {
    for (const w of ['主要语言是简体中文', '可能夹着韩文', '听到什么语言就用什么语言写', '不翻译、不改写', '不补字', '汉字之间不加空格']) expect(PROBE_SYSTEM).toContain(w);
  });
  it('请求里音频前面先有一段文字指令“请转写这段录音。”，系统提示原样送出', async () => {
    const s = setup(async () => gem({ transcript: SAID }));
    await call(s);
    const sent = JSON.parse(String(s.fetches[0]?.body)) as { contents: { parts: { text?: string }[] }[]; systemInstruction: { parts: { text: string }[] } };
    expect(sent.contents[0]?.parts[0]?.text).toBe(PROBE_INSTRUCTION);
    expect(PROBE_INSTRUCTION).toBe('请转写这段录音。');
    expect(sent.systemInstruction.parts[0]?.text).toBe(PROBE_SYSTEM);
    // 思考档位钉成 minimal（11-11，VOICE_PROBE_PARAMS；正式 ai-voice 等探测页实测 200 后再加，11-11 架构复审定）
    expect((sent as unknown as { generationConfig: { thinkingConfig?: unknown } }).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });
});

describe('voice-probe 11-11：Gemini 503 重试一次', () => {
  it('第一次 503、第二次成功：result ok、retried 为真，日志 gemini_ok_retried', async () => {
    let n = 0;
    const s = setup(async () => (++n === 1 ? E503() : gem({ transcript: SAID })));
    expect(await call(s)).toMatchObject({ result: 'ok', gemini_http: 200, transcript: SAID, retried: true });
    expect(s.fetches).toHaveLength(2);
    expect(s.logs.at(-1)?.code).toBe('gemini_ok_retried');
  });
  it('两次都 503：只重试一次，result error、gemini_http 503', async () => {
    const s = setup(E503);
    expect(await call(s)).toMatchObject({ result: 'error', gemini_http: 503, transcript: null, retried: true });
    expect(s.fetches).toHaveLength(2);
    expect(s.logs.at(-1)?.code).toBe('gemini_error_retried');
  });
  it('500、400、429 不重试', async () => {
    for (const st of [500, 400, 429]) {
      const s = setup(async () => gem({ error: {} }, st));
      const b = await call(s);
      expect([s.fetches.length, b['retried']], String(st)).toEqual([1, false]);
    }
  });
});
