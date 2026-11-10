// B4 S10 ③：put 授权时把请求的 Content-Length 作为 p_items[0].content_length 交给 files_authorize（functions/_lib/files-authorize.ts）
// • 有长度：带上，值是 JSON 非负整数；没给或不是非负安全整数：不带这个键，照样调 RPC（函数层不拒，拒不拒由 RPC 定）
// • get（/files/v1/sign）不带，调用方给了也不带
// • RPC 回的 length_mismatch、length_required（单项 reason 或整批 raise）按现有映射原样透出：403 forbidden + reason，不碰存储
// • 还没加新入参的 RPC 只读 bucket、path：多出来的键不影响上传（部署顺序 /files 先上）
import { describe, expect, it } from 'vitest';
import { filesAuthorize, type AuthzConfig } from '../../functions/_lib/files-authorize.ts';
import { IMG, put, setup, signReq, THUMB } from './files-harness.ts';
import { bearer, fakeAuthz, UA, webp } from './files-fakes.ts';

function lib() {
  const authz = fakeAuthz();
  const cfg: AuthzConfig = { upstream: 'https://sb.example.test', anonKey: 'fake-anon-key', fetch: authz.fetch };
  return { authz, call: (op: 'put' | 'get', o?: { contentLength?: unknown }) => filesAuthorize(cfg, bearer(UA), op, [{ bucket: 'images', path: IMG }], o) };
}

describe('filesAuthorize 带 content_length（B4 S10 ③）', () => {
  it('put 有长度：p_items[0] 带 content_length（JSON 整数），0 也带', async () => {
    const s = lib();
    expect((await s.call('put', { contentLength: 1234 })).kind).toBe('ok');
    expect((await s.call('put', { contentLength: 0 })).kind).toBe('ok');
    expect(s.authz.calls.map((c) => c.items)).toEqual([
      [{ bucket: 'images', path: IMG, content_length: 1234 }],
      [{ bucket: 'images', path: IMG, content_length: 0 }],
    ]);
  });

  it('put 没给长度：不带这个键，照样调 RPC', async () => {
    const s = lib();
    expect((await s.call('put')).kind).toBe('ok');
    expect(s.authz.calls[0]?.items).toEqual([{ bucket: 'images', path: IMG }]);
    expect(Object.keys(s.authz.calls[0]?.items[0] ?? {})).not.toContain('content_length');
  });

  it('put 非法值（负数、小数、字符串、NaN、Infinity、超出安全整数、null）：不带这个键，照样调 RPC，函数层不拒', async () => {
    const s = lib();
    const bad: unknown[] = [-1, 1.5, '12', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null];
    for (const v of bad) expect((await s.call('put', { contentLength: v })).kind).toBe('ok');
    expect(s.authz.calls).toHaveLength(bad.length);
    for (const c of s.authz.calls) expect(c.items).toEqual([{ bucket: 'images', path: IMG }]);
  });

  it('get 不带：调用方给了也不带', async () => {
    const s = lib();
    expect((await s.call('get', { contentLength: 99 })).kind).toBe('ok');
    expect(s.authz.calls[0]).toEqual({ op: 'get', items: [{ bucket: 'images', path: IMG }] });
  });
});

describe('/files PUT 和 sign（B4 S10 ③）', () => {
  it('PUT 把请求的 Content-Length 传过去（原图、缩略图都传）', async () => {
    const s = setup();
    expect((await s.call(put(IMG, webp(1000)))).status).toBe(200);
    expect((await s.call(put(THUMB, webp(300), { bucket: 'images' }))).status).toBe(200);
    expect(s.authz.calls.map((c) => c.items[0]?.content_length)).toEqual([1000, 300]);
  });

  it('sign（get）不带 content_length', async () => {
    const s = setup();
    expect((await s.call(signReq([{ bucket: 'images', path: IMG, purpose: 'view' }]))).status).toBe(200);
    expect(s.authz.calls).toEqual([{ op: 'get', items: [{ bucket: 'images', path: IMG }] }]);
  });

  it('RPC 单项回 length_mismatch、length_required：403 forbidden 带原 reason，不碰存储', async () => {
    for (const why of ['length_mismatch', 'length_required']) {
      const s = setup();
      s.authz.deny.set(`put:images/${IMG}`, why);
      const r = await s.call(put(IMG, webp(1000)));
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'forbidden', reason: why });
      expect(s.store.objects.size).toBe(0);
    }
  });

  it('RPC 整批 raise length_required、length_mismatch（PostgREST 4xx {message}）：同样 403 forbidden 带原 reason', async () => {
    for (const why of ['length_required', 'length_mismatch']) {
      const s = setup();
      s.authz.batchError = why;
      s.authz.raise = true;
      const r = await s.call(put(IMG, webp(1000)));
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'forbidden', reason: why });
      expect(s.store.objects.size).toBe(0);
    }
  });
});
