// 调 vault、vault-file 的那一层（data/vault-api.ts）：注入假 fetch 和假 supabase 会话
// • 审查第 13 条：call、fileCall 合成一份 jsonCall，读 JSON 合成一个 readJson——成功按 schema 校验、读不懂回 unknown，
//   错误体按 failOf / fileFailOf 落，上传回执读不出来当 null
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createVaultApi } from '../data/vault-api.ts';
import type { Db } from '../../../platform/supabase/client.ts';

const db = { auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } }, error: null }) } } as unknown as Db;

function api(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply(url, init);
  });
  return { a: createVaultApi(async () => db, { fetch: fetch as never, base: 'https://x/functions/v1', anonKey: 'anon' }), calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okShape = z.object({ ok: z.literal(true) });

describe('call / fileCall 同一套 JSON 读法', () => {
  it('成功按 schema 校验；读不懂（schema 不合、不是 JSON）回 unknown；带上 JWT、apikey、令牌', async () => {
    const { a, calls } = api(() => json(200, { ok: true }));
    expect(await a.call({ action: 'status' }, 'tok', okShape)).toEqual({ ok: true, value: { ok: true } });
    const h = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe('https://x/functions/v1/vault');
    expect(h['authorization']).toBe('Bearer jwt');
    expect(h['apikey']).toBe('anon');
    expect(h['x-vault-token']).toBe('tok');
    expect(await api(() => json(200, { nope: 1 })).a.call({ action: 'status' }, null, okShape)).toEqual({ ok: false, code: 'unknown' });
    expect(await api(() => new Response('不是 JSON', { status: 200 })).a.fileCall({ action: 'ms_preview_end' }, 'tok', okShape)).toEqual({ ok: false, code: 'unknown' });
  });

  it('错误体：vault 按 failOf（带 left），vault-file 自己的码放 fileCode；错误体不是 JSON 按 HTTP 状态', async () => {
    expect(await api(() => json(403, { error: 'pin_wrong', left: 2 })).a.call({ action: 'unlock', pin: '1111' }, null, okShape)).toEqual({ ok: false, code: 'pin_wrong', left: 2 });
    expect(await api(() => json(409, { error: 'exists' })).a.fileCall({ action: 'remove', id: 'a' }, 'tok', okShape)).toMatchObject({ ok: false, code: 'unknown', fileCode: 'exists' });
    expect(await api(() => new Response('<html>', { status: 502 })).a.call({ action: 'status' }, null, okShape)).toEqual({ ok: false, code: 'try_later' });
  });

  it('审查第 4 条：ms_preview_end 同步拿本机会话的 access token、当场发出 keepalive（不先 await getSession）；没令牌不带令牌头；回成没成', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let resolve!: (r: Response) => void;
    const fetch = vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Promise<Response>((r) => (resolve = r));
    });
    const a = createVaultApi(async () => db, { fetch: fetch as never, base: 'https://x/functions/v1', anonKey: 'anon', readAccessToken: () => 'sync-jwt' });
    const p = a.fileEnd(null);
    expect(calls).toHaveLength(1);
    const h = calls[0]?.init.headers as Record<string, string>;
    expect(h['authorization']).toBe('Bearer sync-jwt');
    expect(h['x-vault-token']).toBeUndefined();
    expect(calls[0]?.init.keepalive).toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'ms_preview_end' });
    resolve(json(401, { error: 'unauthorized' }));
    expect(await p).toBe(false);
    const b = api(() => json(200, { ok: true }));
    expect(await b.a.fileEnd('tok')).toBe(true);
    expect((b.calls[0]?.init.headers as Record<string, string>)['x-vault-token']).toBe('tok');
  });

  it('上传回执读不出来当 null（不是失败）', async () => {
    expect(await api(() => new Response('', { status: 200 })).a.fileUpload(new FormData(), 'tok')).toEqual({ ok: true, value: null });
  });
});
