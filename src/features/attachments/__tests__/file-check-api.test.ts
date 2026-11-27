// 调 file-check（data/file-check-api.ts）：经 platform/fn-call.ts 的 fnRequest 发（11-18 全 app 评审加密组第 4 条），
// 401 先换一次令牌再发；状态码口径同 shared/core/http-kind.ts（第 5 条）
import { describe, expect, it, vi } from 'vitest';
import { fileCheck, type CheckDeps } from '../data/file-check-api.ts';

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OK = { status: 'ok' };

function deps(reply: (auth: string) => Response | Promise<Response>, refresh: (() => Promise<string | null>) | null = null): { d: CheckDeps; f: ReturnType<typeof vi.fn> } {
  const f = vi.fn(async (_u: string, init: RequestInit) => reply((init.headers as Record<string, string>)['authorization'] ?? ''));
  return { f, d: { accessToken: async () => 'jwt', refresh: refresh ?? (async () => null), fetch: f as never, base: 'https://x/functions/v1', anonKey: 'anon' } };
}

describe('fileCheck', () => {
  it('401 先换一次令牌再发：成了照常回结果，不落 account；换不到才是 account', async () => {
    const ok = deps((a) => (a === 'Bearer jwt2' ? json(200, OK) : json(401, { error: 'unauthorized' })), async () => 'jwt2');
    expect(await fileCheck('f1', ok.d)).toMatchObject({ ok: true, status: 'ok' });
    expect(ok.f).toHaveBeenCalledTimes(2);
    const no = deps(() => json(401, { error: 'unauthorized' }));
    expect(await fileCheck('f1', no.d)).toEqual({ ok: false, kind: 'account', code: 'unauthorized' });
    expect(no.f).toHaveBeenCalledTimes(1);
  });

  it('状态码归类：429、408、5xx → retry；404 → gone；426 → upgrade；403 照旧 account；没令牌 → account', async () => {
    expect(await fileCheck('f1', deps(() => new Response('', { status: 429 })).d)).toMatchObject({ ok: false, kind: 'retry' });
    expect(await fileCheck('f1', deps(() => new Response('', { status: 408 })).d)).toMatchObject({ ok: false, kind: 'retry' });
    expect(await fileCheck('f1', deps(() => new Response('<html>', { status: 546 })).d)).toMatchObject({ ok: false, kind: 'retry', code: '546' });
    expect(await fileCheck('f1', deps(() => json(404, { error: 'not_found' })).d)).toEqual({ ok: false, kind: 'gone', code: 'not_found' });
    expect(await fileCheck('f1', deps(() => json(426, { code: 'upgrade_required' })).d)).toMatchObject({ ok: false, kind: 'upgrade' });
    expect(await fileCheck('f1', deps(() => json(403, { error: 'forbidden' })).d)).toMatchObject({ ok: false, kind: 'account' });
    const { d } = deps(() => json(200, OK));
    expect(await fileCheck('f1', { ...d, accessToken: async () => null })).toEqual({ ok: false, kind: 'account', code: 'no_session' });
  });

  it('断网 → retry network；回包读不懂 → retry bad_response', async () => {
    expect(await fileCheck('f1', deps(() => Promise.reject(new TypeError('Failed to fetch'))).d)).toEqual({ ok: false, kind: 'retry', code: 'network' });
    expect(await fileCheck('f1', deps(() => json(200, { nope: 1 })).d)).toEqual({ ok: false, kind: 'retry', code: 'bad_response' });
  });
});
