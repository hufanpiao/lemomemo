// AI 助手对话状态（hooks/useChat.ts）和请求整理（data/chat-api.ts 的 trimHistory、askChat 归类）：R-492 第 1 段
// • 一问一答：先画我的话、busy；成功画回答、读用量；历史只带我的话和成功的回答
// • 用完：quotaUntil 记到恢复时刻，之后再问不调服务器、直接出用完卡（不调 onAnswered）；过了恢复时刻自动恢复；没同意；没问到可以重试
// • 上一句还在问时新问的一句排队（气泡带 wait），回来再发；abort 真的取消请求，正在问的和排着队的都换成没问到卡
// • onAnswered：服务器答复了才调（断网、超时、取消不调，草稿留着）
// • trimHistory 按字截，不切坏代理对；请求体不带时间
import { describe, expect, it, vi } from 'vitest';
import { quotaResetAt } from '../../../../shared/logic/ai-quota.ts';
import { CHAT_MAX_MESSAGES, CHAT_TEXT_MAX } from '../../../../shared/schema/chat.ts';
import type { FnDeps } from '../../../platform/fn-call.ts';
import { askChat, trimHistory, type ChatResult } from '../data/chat-api.ts';
import { createChat, historyOf, isQuotaOut, type ChatDeps, type Turn } from '../hooks/useChat.ts';

const REF = { kind: 'todo' as const, id: '70000000-0000-4000-8000-0000000000a8', title: '回复房东', date: '2026-11-20', time: null, done: false };
const OK: ChatResult = { ok: true, answer: '还剩 1 件[1]。', refs: [REF], searched: ['todo'], found: 1, webs: 0, memories: [], drafts: [], draftProjects: [], quotaLeft: 40 };
const T0 = 1_763_800_000_000;

function mk(results: ChatResult[]) {
  const ask = vi.fn<ChatDeps['ask']>();
  for (const r of results) ask.mockResolvedValueOnce(r);
  const usage = vi.fn<ChatDeps['usage']>().mockResolvedValue({ ok: true, value: { used: 10, limit: 50, unlimited: false } });
  const clock = { now: T0 };
  const c = createChat({ ask, usage, now: () => clock.now, tz: () => 'Asia/Seoul', recorder: () => null, waitRecorder: () => null });
  return { c, ask, usage, clock };
}

/** 手动放行的请求：放行之前一直挂着；signal 断了就按 fetch 的样子回 timeout */
function held() {
  const gates: ((r: ChatResult) => void)[] = [];
  const signals: AbortSignal[] = [];
  const ask = vi.fn<ChatDeps['ask']>((_req, signal) => new Promise<ChatResult>((res) => {
    signals.push(signal);
    gates.push(res);
    signal.addEventListener('abort', () => res({ ok: false, reason: 'failed', code: 'timeout' }));
  }));
  const usage = vi.fn<ChatDeps['usage']>().mockResolvedValue({ ok: true, value: { used: 10, limit: 50, unlimited: false } });
  const c = createChat({ ask, usage, now: () => T0, tz: () => 'Asia/Seoul', recorder: () => null, waitRecorder: () => null });
  return { c, ask, gates, signals };
}

const shape = (turns: readonly Turn[]): string[] =>
  turns.map((t) => (t.k === 'me' ? `me:${t.text}${t.wait === true ? ':wait' : ''}` : t.k === 'fail' ? `fail:${t.ask}` : 'ai'));

describe('createChat', () => {
  it('一问一答：先画我的话、busy；回来画回答、读用量；第二问带上历史；请求不带时间', async () => {
    const { c, ask } = mk([OK, OK]);
    const p = c.send('  这周还有什么没做完？ ', 'zh-CN');
    expect(c.get().busy).toBe(true);
    expect(c.get().turns).toEqual([{ k: 'me', id: 1, text: '这周还有什么没做完？' }]);
    await p;
    await vi.waitFor(() => expect(c.get().turns[1]).toMatchObject({ usage: { used: 10, limit: 50 } }));
    const s = c.get();
    expect(s.busy).toBe(false);
    expect(s.turns[1]).toMatchObject({ k: 'ai', a: { answer: '还剩 1 件[1]。', found: 1 } });
    expect(ask.mock.calls[0]?.[0]).toEqual({ messages: [{ role: 'user', text: '这周还有什么没做完？' }], tz: 'Asia/Seoul', locale: 'zh-CN' });
    await c.send('最急的是哪个？', 'zh-CN');
    expect(ask.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', text: '这周还有什么没做完？' },
      { role: 'assistant', text: '还剩 1 件[1]。' },
      { role: 'user', text: '最急的是哪个？' },
    ]);
  });

  it('空话不收；上一句还在问时新问的一句排队（气泡带 wait），回来再发，回答插在各自那一句后面', async () => {
    const { c, ask, gates } = held();
    const pa = c.send('a', 'zh-CN');
    expect(await c.send('   ', 'zh-CN')).toBe(false);
    // send 回的 Promise 等这一句问完才落（排队的那句也是）：true 答上来了（useChatPics 据此才清图，独立评审第 4 条）
    const pb = c.send('b', 'zh-CN');
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(shape(c.get().turns)).toEqual(['me:a', 'me:b:wait']);
    gates[0]?.(OK);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(shape(c.get().turns)).toEqual(['me:a', 'ai', 'me:b']);
    // 排队时 b 不进第一句的历史；第二句的历史：a、a 的回答、b
    expect(ask.mock.calls[0]?.[0].messages).toEqual([{ role: 'user', text: 'a' }]);
    expect(ask.mock.calls[1]?.[0].messages.map((m) => m.text)).toEqual(['a', '还剩 1 件[1]。', 'b']);
    gates[1]?.(OK);
    await vi.waitFor(() => expect(shape(c.get().turns)).toEqual(['me:a', 'ai', 'me:b', 'ai']));
    expect(c.get().busy).toBe(false);
    expect([await pa, await pb]).toEqual([true, true]);
  });

  it('abort：真的断开正在问的请求；它和排着队的都换成没问到卡，不调 onAnswered', async () => {
    const { c, ask, signals } = held();
    const answered = vi.fn();
    const pa = c.send('a', 'zh-CN', answered);
    const pb = c.send('b', 'zh-CN', answered);
    c.abort();
    expect(signals[0]?.aborted).toBe(true);
    await Promise.resolve();
    expect(c.get().busy).toBe(false);
    expect(shape(c.get().turns)).toEqual(['me:a', 'fail:a', 'me:b', 'fail:b']);
    // 没成：两句都回 false（带的图留着）
    expect([await pa, await pb]).toEqual([false, false]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(answered).not.toHaveBeenCalled();
  });

  it('用完：quotaUntil 记到恢复时刻；之后再问不调服务器、不调 onAnswered，直接出这一句和用完卡；过了恢复时刻自动恢复', async () => {
    const { c, ask, clock } = mk([{ ok: false, reason: 'quota', code: 'quota_out' }, OK]);
    const answered = vi.fn();
    await c.send('a', 'zh-CN', answered);
    expect(c.get().quotaUntil).toBe(quotaResetAt(T0));
    expect(isQuotaOut(c.get(), T0)).toBe(true);
    await vi.waitFor(() => expect(c.get().turns.at(-1)).toMatchObject({ k: 'fail', reason: 'quota', ask: 'a', usage: { used: 10, limit: 50 } }));
    expect(answered).toHaveBeenCalledTimes(1);   // 服务器回的 quota_out 算答复了
    await c.send('b', 'zh-CN', answered);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(shape(c.get().turns)).toEqual(['me:a', 'fail:a', 'me:b', 'fail:b']);
    expect(c.get().turns.at(-1)).toMatchObject({ k: 'fail', reason: 'quota', ask: 'b', usage: { used: 10, limit: 50 } });
    expect(answered).toHaveBeenCalledTimes(1);   // 没发出去的不调（草稿留着）
    // 过了恢复时刻：再问就真的发
    clock.now = quotaResetAt(T0) + 1;
    expect(isQuotaOut(c.get(), clock.now)).toBe(false);
    await c.send('c', 'zh-CN', answered);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(c.get().quotaUntil).toBe(null);
    expect(c.get().turns.at(-1)).toMatchObject({ k: 'ai' });
  });

  it('断网、超时不调 onAnswered（草稿留着）；没同意调', async () => {
    const { c } = mk([{ ok: false, reason: 'failed', code: 'timeout' }, { ok: false, reason: 'consent', code: 'consent_required' }]);
    const answered = vi.fn();
    await c.send('a', 'zh-CN', answered);
    expect(answered).not.toHaveBeenCalled();
    await c.send('b', 'zh-CN', answered);
    expect(answered).toHaveBeenCalledTimes(1);
    expect(c.get().turns.at(-1)).toMatchObject({ k: 'fail', reason: 'consent' });
  });

  it('重试：拿掉那一句和失败卡，重新问同一句；失败卡不进历史', async () => {
    const { c, ask } = mk([{ ok: false, reason: 'failed', code: 'network' }, OK]);
    await c.send('a', 'zh-CN');
    const fail = c.get().turns.at(-1);
    expect(historyOf(c.get().turns)).toEqual([{ role: 'user', text: 'a' }]);
    c.retry(fail?.id ?? 0, 'zh-CN');
    await vi.waitFor(() => expect(c.get().turns.map((t) => t.k)).toEqual(['me', 'ai']));
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe('trimHistory', () => {
  it('最多 CHAT_MAX_MESSAGES 条、每条截字、开头必须是用户的话', () => {
    const msgs = Array.from({ length: CHAT_MAX_MESSAGES + 1 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), text: 'x'.repeat(CHAT_TEXT_MAX + 5) }));
    const out = trimHistory(msgs);
    expect(out.length).toBe(CHAT_MAX_MESSAGES - 1);
    expect(out[0]?.role).toBe('user');
    expect(out.every((m) => m.text.length === CHAT_TEXT_MAX)).toBe(true);
  });
  it('按字截：截点落在 emoji（代理对）中间的整个去掉，不留半个', () => {
    const text = `${'x'.repeat(CHAT_TEXT_MAX - 1)}\u{1F600}`;
    const out = trimHistory([{ role: 'user', text }]);
    expect(out[0]?.text).toBe('x'.repeat(CHAT_TEXT_MAX - 1));
  });
});

describe('askChat', () => {
  const sent: unknown[] = [];
  const deps = (status: number, body: unknown): FnDeps => ({
    accessToken: async () => 'tok',
    fetch: (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as FnDeps['fetch'],
    base: 'https://x.test/functions/v1',
    anonKey: 'anon',
  });
  const req = { messages: [{ role: 'user' as const, text: 'a' }], tz: 'Asia/Seoul', locale: 'zh-CN' };
  const sig = new AbortController().signal;

  it('成功、没同意、用完、退路、读不懂、出错状态码分别归类；请求体不带 now', async () => {
    const ok = { answer: 'a[1]', refs: [REF], searched: ['todo'], found: 1, quota_left: 3 };
    await expect(askChat(req, sig, deps(200, ok))).resolves.toMatchObject({ ok: true, answer: 'a[1]', quotaLeft: 3 });
    expect(sent[0]).toEqual({ messages: [{ role: 'user', text: 'a' }], tz: 'Asia/Seoul', locale: 'zh-CN', scope: 'main', web: true, memory: true });
    await expect(askChat(req, sig, deps(200, { consent_required: true }))).resolves.toMatchObject({ ok: false, reason: 'consent' });
    await expect(askChat(req, sig, deps(200, { quota_out: true, quota_left: 0 }))).resolves.toMatchObject({ ok: false, reason: 'quota' });
    await expect(askChat(req, sig, deps(200, { fallback: true, reason: 'timeout' }))).resolves.toMatchObject({ ok: false, reason: 'failed', code: 'timeout' });
    await expect(askChat(req, sig, deps(200, { what: 1 }))).resolves.toMatchObject({ ok: false, code: 'bad_response' });
    await expect(askChat(req, sig, deps(429, { error: 'rate_limited' }))).resolves.toMatchObject({ ok: false, reason: 'failed', code: 'rate_limited' });
  });

  it('第 2 段：带图的这一句把 images 原样送出；回包里的网页来源和 webs 交给界面；没联网 webs 为 0', async () => {
    sent.length = 0;
    const img = { mime: 'image/jpeg' as const, data: 'QUJD' };
    const web = { kind: 'web', title: '서울 날씨', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', site: 'weather.naver.com' };
    const ok = { answer: '会下雨[1]。', refs: [web], searched: [], found: 0, webs: 2, quota_left: 3 };
    await expect(askChat({ ...req, images: [img] }, sig, deps(200, ok))).resolves.toMatchObject({ ok: true, refs: [web], webs: 2 });
    expect(sent[0]).toMatchObject({ web: true, images: [img] });
    const plain = { answer: 'a', refs: [], searched: [], found: 0, quota_left: 3 };
    await expect(askChat(req, sig, deps(200, plain))).resolves.toMatchObject({ ok: true, webs: 0 });
    expect(sent[1]).not.toHaveProperty('images');
  });
});
