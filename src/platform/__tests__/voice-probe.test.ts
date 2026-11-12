// R-68 探测（B3 FA-0）：标注怎么选、回包只取约定字段、上传的请求头和各种失败
// 录音本身 Q-5 起走正式录音器 recorder.ts（它的取消、出错、上限在 recorder*.test.ts；探测页怎么用在 app/__tests__/voice-probe-leave.test.tsx）
import { describe, expect, it, vi } from 'vitest';
import { labelsFor, PROBE_UPLOAD_TIMEOUT_MS, replyOf, uploadProbe, type UploadDeps } from '../voice-probe.ts';

describe('labelsFor', () => {
  it.each([
    ['audio/mp4', ['audio/mp4', 'audio/aac']],
    ['audio/mp4;codecs=mp4a.40.2', ['audio/mp4', 'audio/aac']],
    ['audio/aac', ['audio/mp4', 'audio/aac']],
    ['audio/webm;codecs=opus', ['audio/webm', 'audio/webm;codecs=opus']],
    ['audio/WEBM', ['audio/webm', 'audio/webm;codecs=opus']],
    ['audio/ogg', ['audio/ogg']],
    ['', ['application/octet-stream']],
  ])('%s → %j', (m, want) => expect(labelsFor(m)).toEqual(want));
});

describe('replyOf', () => {
  it('只取约定字段，类型不对的当 null，转写截到 2000 字', () => {
    const r = replyOf(200, { mime: 'audio/mp4', bytes: 12, gemini_http: '200', transcript: '字'.repeat(2100), email: 'a@b.c', user_id: 'u' }, 5);
    expect(r.mime).toBe('audio/mp4');
    expect(r.bytes).toBe(12);
    expect(r.gemini_http).toBeNull();
    expect([...(r.transcript ?? '')]).toHaveLength(2000);
    expect(Object.keys(r)).not.toContain('email');
    expect(Object.keys(r)).not.toContain('user_id');
  });

  it('不是对象 → 全空', () => expect(replyOf(500, 'x', 1)).toMatchObject({ status: 500, mime: null, error: null }));
});

const clip = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' });
const deps = (over: Partial<UploadDeps> = {}): UploadDeps => ({
  token: async () => 'jwt-abc',
  fetch: vi.fn(async () => new Response(JSON.stringify({ mime: 'audio/aac', result: 'ok', transcript: 'hi' }), { status: 200 })),
  now: () => 0,
  ...over,
});

describe('uploadProbe', () => {
  it('按给的标注、模型发，带 JWT；body 就是那段录音', async () => {
    const d = deps();
    const r = await uploadProbe(clip, 'audio/aac', 'gemini-3.1-flash-lite', d);
    expect(r).toMatchObject({ status: 200, mime: 'audio/aac', result: 'ok', transcript: 'hi' });
    const [url, init] = vi.mocked(d.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/functions\/v1\/voice-probe$/);
    const h = init.headers as Record<string, string>;
    expect(h['content-type']).toBe('audio/aac');
    expect(h['x-model']).toBe('gemini-3.1-flash-lite');
    expect(h['authorization']).toBe('Bearer jwt-abc');
    expect(init.body).toBe(clip);
    expect(init.method).toBe('POST');
  });

  it('没登录不发', async () => {
    const d = deps({ token: async () => null });
    expect(await uploadProbe(clip, 'audio/mp4', 'gemini-3.1-flash-lite', d)).toMatchObject({ status: 0, error: 'signed_out' });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('非 200 照样显示状态和错误码；回的不是 JSON 也不崩', async () => {
    expect(
      await uploadProbe(clip, 'audio/mp4', 'gemini-3.1-flash-lite', deps({ fetch: async () => new Response(JSON.stringify({ error: 'unsupported_type', raw_type: 'audio/mp4' }), { status: 415 }) })),
    ).toMatchObject({ status: 415, error: 'unsupported_type', raw_type: 'audio/mp4' });
    expect(await uploadProbe(clip, 'audio/mp4', 'gemini-3.1-flash-lite', deps({ fetch: async () => new Response('oops', { status: 502 }) }))).toMatchObject({
      status: 502,
      error: null,
    });
  });

  it('网络错 → network；超时 → timeout', async () => {
    const boom = async (): Promise<never> => {
      throw new TypeError('Failed to fetch');
    };
    expect(await uploadProbe(clip, 'audio/mp4', 'gemini-3.1-flash-lite', deps({ fetch: boom }))).toMatchObject({ status: 0, error: 'network' });
    vi.useFakeTimers();
    try {
      const hang = (_u: string, init: RequestInit): Promise<Response> =>
        new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      const p = uploadProbe(clip, 'audio/mp4', 'gemini-3.1-flash-lite', deps({ fetch: hang }));
      await vi.advanceTimersByTimeAsync(PROBE_UPLOAD_TIMEOUT_MS + 10);
      expect(await p).toMatchObject({ status: 0, error: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('uploadProbe 的取消（代码审 S1）', () => {
  it('传到一半取消 → cancelled，fetch 的信号也断了', async () => {
    const ac = new AbortController();
    let inner: AbortSignal | undefined;
    const hang = (_u: string, init: RequestInit): Promise<Response> =>
      new Promise((_r, reject) => {
        inner = init.signal ?? undefined;
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const p = uploadProbe(clip, 'audio/mp4', 'gemini-3.1-flash-lite', deps({ fetch: hang }), ac.signal);
    await vi.waitFor(() => expect(inner).toBeDefined());
    ac.abort();
    expect(await p).toMatchObject({ status: 0, error: 'cancelled' });
    expect(inner?.aborted).toBe(true);
  });

  it('已经取消了就不发', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetch = vi.fn();
    expect(await uploadProbe(clip, 'audio/mp4', 'gemini-3.1-flash-lite', deps({ fetch }), ac.signal)).toMatchObject({ status: 0, error: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
