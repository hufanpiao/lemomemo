// 契约：客户端真发出的 ai-voice 请求（src/features/plus/data/ai-voice-api.ts）交给服务器真的 handle（supabase/functions/ai-voice/core.ts），
// 证明整套请求头服务器收得下。门用内存替身、服务商用桩（ai-fakes.ts），不碰网络
import { describe, expect, it } from 'vitest';
import { isValidTz } from '../../shared/core/tz.ts';
import { AI_AUDIO_MAX_BYTES, audioType, checkDefaultDay, checkParseOutput, checkVoiceOutput, normLocale, normProjects, type AiItem } from '../../shared/schema/ai.ts';
import { outcomeOf } from '../../src/features/plus/data/ai-outcome.ts';
import { createCallVoice, type AiVoiceReq } from '../../src/features/plus/data/ai-voice-api.ts';
import { makeParseWithAI } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { handle, type Deps } from '../../supabase/functions/ai-voice/core.ts';
import { fakeGate, okJson, UA, type GateOpts } from './ai-fakes.ts';

const { voiceWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
const NOW = Date.UTC(2026, 9, 28, 3, 0);
const EV = { kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', date_basis: 'rel' };

/** 客户端的 fetch 换成“直接交给服务器的 handle”：地址、请求头、包体都是客户端真拼出来的 */
function wired(o: GateOpts = {}) {
  const g = fakeGate({ reply: () => okJson({ transcript: '明天下午三点开会', items: [EV] }), now: NOW, ...o });
  const deps: Deps<AiItem> = {
    ...g,
    authenticate: async (r) =>
      r.headers.get('authorization') === 'Bearer jwt-1'
        ? { ok: true, user: { userId: UA } }
        : { ok: false, response: new Response('{"error":"unauthorized"}', { status: 401 }) },
    logic: { maxAudio: AI_AUDIO_MAX_BYTES, audioType, normLocale, normProjects, isValidTz, checkDefaultDay, voiceWithAI },
    async logFail() {},
  };
  // 只留请求头：clone() 分出的那一支没人读，服务器 400/415 时 body.cancel() 会一直等它
  const seen: Headers[] = [];
  const call = createCallVoice({
    url: 'http://kong/functions/v1/ai-voice',
    anonKey: 'anon-1',
    token: async () => 'jwt-1',
    fetch: async (url, init) => {
      const r = new Request(String(url), init);
      seen.push(new Headers(r.headers));
      return handle(r, deps);
    },
  });
  return { g, call, seen };
}

const req = (over: Partial<AiVoiceReq> = {}): AiVoiceReq => ({
  audio: new Blob([new Uint8Array(1234)]), mime: 'audio/mp4', now: NOW, tz: 'Asia/Seoul', locale: 'ko', projects: ['NEOX 宣传片', '사이드'], scope: 'main', ...over,
});
const live = (): AbortSignal => new AbortController().signal;

describe('客户端的 ai-voice 请求，服务器收得下', () => {
  it('整套请求头和音频：200、记下；服务商收到的字节数、类型、项目名、界面语言都对得上', async () => {
    const { g, call, seen } = wired();
    const out = outcomeOf(await call(req(), live()));
    expect(out).toMatchObject({ kind: 'record', transcript: '明天下午三点开会', quotaLeft: 49 });
    const sent = g.provider.stub.calls[0];
    const [names, audio] = sent?.parts ?? [];
    expect(audio && 'inlineData' in audio && [audio.inlineData.mimeType, audio.inlineData.data.length]).toEqual(['audio/mp4', 1234]);
    expect(names && 'text' in names && names.text).toContain('NEOX 宣传片');
    expect(names && 'text' in names && names.text).toContain('사이드');
    expect(seen[0]?.get('x-locale')).toBe('ko');
  });

  it('带日历页选中的日子：不回 400', async () => {
    const { call } = wired();
    expect(outcomeOf(await call(req({ default_day: '2026-11-20' }), live())).kind).toBe('record');
  });

  it('时刻带小数也发成整数毫秒（服务器只认整数，不然 400）', async () => {
    const { call, seen } = wired();
    expect(outcomeOf(await call(req({ now: NOW + 0.6 }), live())).kind).toBe('record');
    expect(seen[0]?.get('x-now')).toMatch(/^\d+$/);
  });

  it('选中的日子超出服务器认的范围：400，客户端按 http 失败', async () => {
    const { g, call } = wired();
    await expect(call(req({ default_day: '1999-01-01' }), live())).rejects.toMatchObject({ name: 'SendError', fail: 'http' });
    expect(g.provider.stub.calls).toHaveLength(0);
  });

  it('服务器不收的类型（audio/ogg）：415，客户端按 http 失败、服务商没被调', async () => {
    const { g, call } = wired();
    await expect(call(req({ mime: 'audio/ogg' }), live())).rejects.toMatchObject({ name: 'SendError', fail: 'http' });
    expect(g.provider.stub.calls).toHaveLength(0);
  });

  it('没听清（转写为空）：服务器回空列表，客户端这层原样交回', async () => {
    const { call } = wired({ reply: () => okJson({ transcript: '', items: [] }) });
    expect(await call(req(), live())).toMatchObject({ intent: 'record', transcript: '', items: [] });
  });
});
