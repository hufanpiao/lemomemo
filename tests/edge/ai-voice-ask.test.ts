// 语音提问的次数（R-495）：转写不退；紧接着的 ai-chat 答成才消费一次发放、退回转写那 1 次；只转写不提问刷不出免费次数。
import { describe, expect, it } from 'vitest';
import { isValidTz } from '../../shared/core/tz.ts';
import { AI_AUDIO_MAX_BYTES, audioType, checkDefaultDay, normLocale, normProjects, stripCtlText, type AiItem } from '../../shared/schema/ai.ts';
import { CHAT_TEXT_MAX, chatOk, chatReq, VOICE_WANT_TRANSCRIPT } from '../../shared/schema/chat.ts';
import type { ChatProvider, ChatRequest, ChatResult } from '../../supabase/functions/_shared/ai/provider.ts';
import { TRANSCRIPT_MAX } from '../../supabase/functions/_shared/ai/transcribe.ts';
import { VOICE_ASK_FREE, voiceIssuedKey, voiceUsedKey } from '../../supabase/functions/_shared/ai/voice-ask.ts';
import { handle as chatHandle, type Deps as ChatDeps } from '../../supabase/functions/ai-chat/core.ts';
import { handle as voiceHandle, type Deps as VoiceDeps } from '../../supabase/functions/ai-voice/core.ts';
import { fakeGate, UA, used } from './ai-fakes.ts';

const NOW = Date.UTC(2026, 10, 23, 3, 0);
const authed = async () => ({ ok: true as const, user: { userId: UA } });
const say = (text: string): ChatResult => ({ ok: true, text, toolCalls: [], turn: { provider: 'stub', state: null } });

function world(answer: ChatResult = say('十点开会。'), opts: Parameters<typeof fakeGate>[0] = {}) {
  const g = fakeGate({ now: NOW, ...opts });
  const counts = new Map<string, number>();
  const rate = async (k: string, limit: number, win: number): Promise<boolean> => {
    if (!k.startsWith('voice-')) return g.rate(k, limit, win);
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    return n <= limit;
  };
  const provider: ChatProvider = {
    name: 'stub', model: 'm', caps: { tools: true, imageIn: false, audioIn: false, embed: false },
    chat: async (_r: ChatRequest) => answer,
  };
  const chat: ChatDeps = {
    ...g, rate, provider: () => provider, authenticate: authed,
    parse: (v) => { const p = chatReq.safeParse(v); return p.success ? p.data : null; },
    checkOk: (v) => chatOk.safeParse(v).success,
    isValidTz, normLocale, stripCtl: stripCtlText,
    query: async () => [], web: async () => null, noteImages: async () => [], readThumb: async () => null,
    memories: { recent: async () => ({ rows: [], ver: 'v' }), related: async () => [], save: async () => [] },
    voiceIssued: async (k) => counts.get(k) ?? 0,
  };
  const voice: VoiceDeps<AiItem> = {
    ...g, rate, authenticate: authed,
    logic: {
      maxAudio: AI_AUDIO_MAX_BYTES, audioType, normLocale, normProjects, isValidTz, checkDefaultDay: (v, n, tz) => checkDefaultDay(v, n, tz),
      voiceWithAI: async () => ({ ok: false, reason: 'error' }),
      transcribe: async () => ({ ok: true, text: '明天几点开会', retried: false }),
      wantTranscript: VOICE_WANT_TRANSCRIPT,
    },
    logFail: async () => undefined,
  };
  return { g, chat, voice, counts };
}
const voiceReq = () => new Request('http://kong/functions/v1/ai-voice', {
  method: 'POST',
  headers: { 'content-type': 'audio/webm', 'x-now': String(NOW), 'x-tz': 'Asia/Seoul', 'x-locale': 'zh', 'x-scope': 'main', 'x-app-version': '4.0.0', 'x-want': VOICE_WANT_TRANSCRIPT },
  body: new Uint8Array([1, 2, 3]),
});
const chatReqOf = (voiceAsk: boolean) => new Request('http://kong/functions/v1/ai-chat', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-app-version': '4.0.0' },
  body: JSON.stringify({ messages: [{ role: 'user', text: '明天几点开会' }], tz: 'Asia/Seoul', locale: 'zh-CN', scope: 'main', ...(voiceAsk ? { voice_ask: true } : {}) }),
});
const personal = (w: ReturnType<typeof world>) => used(w.g, `ai:${UA}:`);

describe('语音提问的次数', () => {
  it('转写出来的字不超过一句提问的上限', () => {
    expect(TRANSCRIPT_MAX).toBe(CHAT_TEXT_MAX);
  });
  it('只转写不提问：个人次数不退，一天转多少段扣多少次', async () => {
    const w = world();
    for (let i = 0; i < 3; i += 1) await voiceHandle(voiceReq(), w.voice);
    expect(personal(w)).toBe(3);
    expect(w.counts.get(voiceIssuedKey(UA, NOW))).toBe(3);
  });
  it('转写加提问答成：一共只算 1 次，回包的剩余次数也算上退回的', async () => {
    const w = world();
    const v = (await (await voiceHandle(voiceReq(), w.voice)).json()) as { quota_left: number };
    const r = (await (await chatHandle(chatReqOf(true), w.chat)).json()) as { quota_left: number };
    expect(personal(w)).toBe(1);
    expect(r.quota_left).toBe(v.quota_left);
  });
  it('没有发放：带 voice_ask 也退不到', async () => {
    const w = world();
    await chatHandle(chatReqOf(true), w.chat);
    expect(personal(w)).toBe(1);
    expect(w.counts.get(voiceUsedKey(UA, NOW))).toBeUndefined();
  });
  it('一次发放只能消费一次', async () => {
    const w = world();
    await voiceHandle(voiceReq(), w.voice);
    await chatHandle(chatReqOf(true), w.chat);
    await chatHandle(chatReqOf(true), w.chat);
    expect(personal(w)).toBe(2);
  });
  it('普通打字提问不消费发放', async () => {
    const w = world();
    await voiceHandle(voiceReq(), w.voice);
    await chatHandle(chatReqOf(false), w.chat);
    expect(personal(w)).toBe(2);
    expect(w.counts.get(voiceUsedKey(UA, NOW))).toBeUndefined();
  });
  it('提问没答成：不消费发放，留给重试', async () => {
    const w = world({ ok: false, reason: 'error' });
    await voiceHandle(voiceReq(), w.voice);
    await chatHandle(chatReqOf(true), w.chat);
    expect(w.counts.get(voiceUsedKey(UA, NOW))).toBeUndefined();
  });
  it(`每人每天最多退 ${VOICE_ASK_FREE} 次`, async () => {
    const w = world();
    w.counts.set(voiceIssuedKey(UA, NOW), VOICE_ASK_FREE + 5);
    w.counts.set(voiceUsedKey(UA, NOW), VOICE_ASK_FREE);
    await chatHandle(chatReqOf(true), w.chat);
    expect(personal(w)).toBe(1);
  });
  it('读发放出错：回答照常，不退', async () => {
    const w = world();
    w.chat.voiceIssued = async () => { throw new Error('db'); };
    const r = (await (await chatHandle(chatReqOf(true), w.chat)).json()) as Record<string, unknown>;
    expect(r['answer']).toBe('十点开会。');
    expect(personal(w)).toBe(1);
  });
});
