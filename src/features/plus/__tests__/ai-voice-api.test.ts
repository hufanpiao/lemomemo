// 录音上传 ai-voice（data/ai-voice-api.ts）：请求形状、各返回码、401 换令牌、本地拒发；
// X-Projects 的编码和服务器真的解码（supabase/functions/ai-voice/core.ts 的 decodeProjects）做往返
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { normProjects } from '../../../../shared/schema/ai.ts';
import { decodeProjects, MAX_PROJECTS_HEADER } from '../../../../supabase/functions/ai-voice/core.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { outcomeOf } from '../data/ai-outcome.ts';
import { createCallVoice, encodeProjects, voiceHeaders, type AiVoiceReq } from '../data/ai-voice-api.ts';
import { BLOB_MAX_BYTES } from '../data/record-logic.ts';

const NOW = Date.UTC(2026, 10, 2, 1, 0);
const URL_ = 'https://sb.test/functions/v1/ai-voice';
const clip = (bytes = 3): Blob => new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' });
const req = (over: Partial<AiVoiceReq> = {}): AiVoiceReq => ({
  audio: clip(), mime: 'audio/mp4', now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: [], scope: 'main', ...over,
});
const item = (over: Partial<AiItem> = {}): AiItem => ({
  kind: 'todo', title: 'AI title', date: null, time: null, duration_min: null, due: '2026-11-05', important: false,
  project: null, body: null, short: 'AI', date_basis: 'rel', anniv: null, confirm: null, ...over,
});
const reply = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OK = { intent: 'record', confidence: 1, transcript: '周四前交报销单', items: [item()], quota_left: 9 };
const live = (): AbortSignal => new AbortController().signal;

function api(res: () => Promise<Response>, token: () => Promise<string | null> = async () => 'jwt-1', refresh: () => Promise<string | null> = async () => null) {
  const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => res());
  return { fetch, call: createCallVoice({ fetch, url: URL_, anonKey: 'anon-1', token, refresh }) };
}
const sentHeaders = (f: ReturnType<typeof api>['fetch'], i = 0): Record<string, string> => f.mock.calls[i]?.[1]?.headers as Record<string, string>;

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
});

describe('请求', () => {
  it('POST 到 ai-voice：带 JWT、apikey，类型和参数都在请求头，包体就是那段录音', async () => {
    const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => reply(200, OK));
    const audio = clip();
    const ac = new AbortController();
    await createCallVoice({ fetch, anonKey: 'anon-1', token: async () => 'jwt-1' })(req({ audio, now: NOW + 0.4, locale: 'ko' }), ac.signal);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/functions\/v1\/ai-voice$/);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      authorization: 'Bearer jwt-1', apikey: 'anon-1', 'content-type': 'audio/mp4',
      'x-now': String(NOW), 'x-tz': 'Asia/Seoul', 'x-locale': 'ko', 'x-scope': 'main',
    });
    expect(init?.body).toBe(audio);
    expect(init?.signal).toBe(ac.signal);
    expect(init?.cache).toBe('no-store');
  });

  it('日历页选中的日子、项目名：有才带', () => {
    expect(Object.keys(voiceHeaders(req()))).not.toContain('x-default-day');
    expect(Object.keys(voiceHeaders(req()))).not.toContain('x-projects');
    const h = voiceHeaders(req({ default_day: '2026-11-20', projects: ['NEOX'] }));
    expect(h['x-default-day']).toBe('2026-11-20');
    expect(decodeProjects(h['x-projects'] ?? null)).toEqual(['NEOX']);
  });

  it('拿不到会话令牌：不发', async () => {
    const { fetch, call } = api(async () => reply(200, OK), async () => null);
    await expect(call(req(), live())).rejects.toMatchObject({ name: 'SendError', fail: 'http' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('X-Projects 和服务器的解码往返', () => {
  const NAMES = ['NEOX 宣传片', '사이드 프로젝트', '🎬 剪辑', '带"引号"的', '反\\斜杠', 'a,b', '  首尾空格  ', 'NEOX 宣传片', '', '长'.repeat(60)];

  it('中文、韩文、表情、引号、反斜杠、逗号、空格、重复、超长：服务器解出来等于规整后的列表', () => {
    const h = encodeProjects(NAMES);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeProjects(h)).toEqual(normProjects(NAMES));
    expect(normProjects(NAMES)).toHaveLength(8);
  });

  it('超过 30 个只带前 30 个；一个都没有不带这个头', () => {
    const many = Array.from({ length: 45 }, (_v, i) => `项目${i}`);
    expect(decodeProjects(encodeProjects(many))).toEqual(many.slice(0, 30));
    expect(encodeProjects([])).toBeNull();
    expect(encodeProjects(['  ', ''])).toBeNull();
  });

  it('超过服务器的 4 KB：服务器留下前面完整的几项，顺序不变', () => {
    const long = Array.from({ length: 30 }, (_v, i) => String.fromCodePoint(0x4e00 + i).repeat(40));
    const h = encodeProjects(long) ?? '';
    expect(h.length).toBeGreaterThan(MAX_PROJECTS_HEADER);
    const got = decodeProjects(h);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got.length).toBeLessThan(30);
    expect(got).toEqual(long.slice(0, got.length));
  });

  it('真发出去的那个请求头，服务器解得开', async () => {
    const { fetch, call } = api(async () => reply(200, OK));
    await call(req({ projects: NAMES }), live());
    expect(decodeProjects(sentHeaders(fetch)['x-projects'] ?? null)).toEqual(normProjects(NAMES));
  });
});

describe('本地拒发（不花流量、不花次数）', () => {
  it('0 字节、超过 600 KB、没有类型：不发；刚好 600 KB 照发', async () => {
    const { fetch, call } = api(async () => reply(200, OK));
    for (const bad of [req({ audio: clip(0) }), req({ audio: clip(BLOB_MAX_BYTES + 1) }), req({ mime: '' })]) {
      await expect(call(bad, live())).rejects.toMatchObject({ name: 'SendError', fail: 'http' });
    }
    expect(fetch).not.toHaveBeenCalled();
    await call(req({ audio: clip(BLOB_MAX_BYTES) }), live());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('返回', () => {
  it('200 的各种包体原样交回，outcomeOf 认得', async () => {
    const cases: [unknown, string][] = [
      [OK, 'record'],
      [{ ai_failed: true, reason: 'timeout' }, 'ai_failed'],
      [{ quota_out: true, quota_left: 0 }, 'quota_out'],
      [{ consent_required: true }, 'consent_required'],
      [{ fallback: true, reason: 'vault_ai_off' }, 'fallback'],
    ];
    for (const [body, kind] of cases) {
      const raw = await api(async () => reply(200, body)).call(req(), live());
      expect(raw).toEqual(body);
      expect(outcomeOf(raw).kind).toBe(kind);
    }
    expect(outcomeOf(await api(async () => reply(200, OK)).call(req(), live()))).toMatchObject({ transcript: '周四前交报销单' });
  });

  it.each([400, 403, 413, 415, 426, 429, 500, 503])('%i：SendError http，只发一次', async (status) => {
    const { fetch, call } = api(async () => reply(status, { error: 'x' }));
    await expect(call(req(), live())).rejects.toMatchObject({ name: 'SendError', fail: 'http' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('2xx 但不是 JSON：bad_response', async () => {
    const { call } = api(async () => new Response('<html>oops</html>', { status: 200 }));
    await expect(call(req(), live())).rejects.toMatchObject({ name: 'SendError', fail: 'bad_response' });
  });

  it('断网的 TypeError、取消信号：原样抛', async () => {
    const down = new TypeError('Failed to fetch');
    await expect(api(async () => Promise.reject(down)).call(req(), live())).rejects.toBe(down);

    const ac = new AbortController();
    const why = new DOMException('timeout', 'TimeoutError');
    const fetch = vi.fn(
      (_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))),
    );
    const p = createCallVoice({ fetch, url: URL_, anonKey: 'anon-1', token: async () => 'jwt-1' })(req(), ac.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    ac.abort(why);
    await expect(p).rejects.toBe(why);
  });
});

describe('401 先换一次令牌再发', () => {
  it('换到新的：用新令牌把同一段录音再发一次', async () => {
    let n = 0;
    const refresh = vi.fn(async () => 'jwt-2');
    const { fetch, call } = api(async () => (++n === 1 ? reply(401, { error: 'session_revoked' }) : reply(200, OK)), undefined, refresh);
    const audio = clip();
    expect(await call(req({ audio }), live())).toEqual(OK);
    expect([sentHeaders(fetch, 0)['authorization'], sentHeaders(fetch, 1)['authorization']]).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
    expect([fetch.mock.calls[0]?.[1]?.body, fetch.mock.calls[1]?.[1]?.body]).toEqual([audio, audio]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(audio);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('换不到、换来的和原来一样：不再发', async () => {
    for (const refresh of [async () => null, async () => 'jwt-1']) {
      const { fetch, call } = api(async () => reply(401, {}), undefined, refresh);
      await expect(call(req(), live())).rejects.toMatchObject({ name: 'SendError', fail: 'http' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});

describe('运行日志：只补网络那一行没有的（字节数、类型、项目个数、本地拒发的原因）', () => {
  it('发出去的：只有开始一行（状态码和耗时在全局的 net 行里，这里不重复记）', async () => {
    const { call } = api(async () => reply(200, OK));
    await call(req({ projects: ['NEOX 宣传片', '사이드'] }), live());
    expect(lines).toEqual(['voice upload start bytes=3 mime=audio/mp4 projects=2']);
  });

  it('本地拒发：一行原因，带字节数', async () => {
    const { call } = api(async () => reply(200, OK));
    await call(req({ audio: clip(0) }), live()).catch(() => undefined);
    await call(req({ audio: clip(BLOB_MAX_BYTES + 1) }), live()).catch(() => undefined);
    await call(req({ mime: '' }), live()).catch(() => undefined);
    expect(lines).toEqual([
      'voice upload fail reason=empty bytes=0',
      `voice upload fail reason=too_large bytes=${BLOB_MAX_BYTES + 1}`,
      'voice upload fail reason=no_mime bytes=3',
    ]);
  });

  it('不记项目名、不记转写', async () => {
    const { call } = api(async () => reply(200, OK));
    await call(req({ projects: ['NEOX 宣传片'] }), live());
    await api(async () => reply(500, {})).call(req({ projects: ['NEOX 宣传片'] }), live()).catch(() => undefined);
    const all = lines.join('\n');
    expect(all).not.toContain('NEOX');
    expect(all).not.toContain('报销单');
  });
});
