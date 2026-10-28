// `/sb/*` 转发前，路径里一律不许出现 `%`（架构 0.33 第 10 条、14.2 第 1 点；QA D-02、代码审查低 7、安全审查低 1；TC-B0-39、TC-B0-119 的转发层部分）。
// 只看路径，查询串不受影响；在比白名单、拒绝名单之前判断；出现就本地 404 `not_found`，不请求上游。
// 原来“逐层解码再比”的那套已删掉（只留一套逻辑）：下面原来那些编码绕过的写法现在一律在第一步就被拒。
// 线上 Cloudflare 边缘会不会先把 `%61` 这类编码解开，见 tests/e2e/sb-forward.preview.test.ts【待预览】。
import { describe, expect, it } from 'vitest';
import { handleSb, upstreamPath } from '../../functions/sb/[[path]].ts';
import { BASE, ENV, setup } from './sb-harness.ts';

/** 架构 0.33 第 10 条要补的四条反例：编码过的非保留字符，上游解码后就是拒绝名单里的路径 */
const ARCH_COUNTEREXAMPLES = [
  '/sb/rest/v1/rpc/files%5Fauthorize',
  '/sb/rest/v1/rpc/%66iles_authorize',
  '/sb/auth/v1/%61dmin/users',
  '/sb/auth/v1/adm%69n',
];

describe('upstreamPath：路径里有 % 一律拒（架构 0.33 第 10 条）', () => {
  it.each(ARCH_COUNTEREXAMPLES)('四条反例 %s → 拒绝', (p) => {
    expect(upstreamPath(BASE + p)).toBeNull();
  });

  it.each([
    // 大小写不同的写法
    '/sb/rest/v1/rpc/files%5fauthorize',
    '/sb/rest/v1/rpc/%46ILES_AUTHORIZE',
    '/sb/auth/v1/%41DMIN/users',
    // 多重编码
    '/sb/rest/v1/rpc/files%255Fauthorize',
    '/sb/rest/v1/rpc/files%25255Fauthorize',
    '/sb/auth/v1/%2561dmin/users',
    '/sb/auth/v1/%252561dmin/users',
    // 编码的斜杠、点、反斜杠、空字节
    '/sb/rest/v1/todos%2F..%2Fadmin',
    '/sb/rest/v1/todos%252F..%252Fadmin',
    '/sb/rest/v1/%252e%252e/auth/v1/admin',
    '/sb/rest/v1/todos%255cx',
    '/sb/rest/v1/todos%2500',
    '/sb/rest/v1/%252F',
    // 解不开的编码
    '/sb/rest/v1/%',
    '/sb/rest/v1/todos%2',
    '/sb/rest/v1/todos%zz',
    '/sb/rest/v1/todos%C0%AF',
    // 原来当“正常编码”放行的，现在也拒：经 /sb 的合法路径里没有要编码的字符
    '/sb/functions/v1/ai%2Dparse',
    '/sb/rest/v1/todos%20x',
    '/sb/storage/v1/object/sign/vault-preview/0123456789abcdef0123456789abcdef%2Epptx',
    '/sb/realtime/v1/websocket%3Fx',
    // 只在最后一段、只有一个 % 也拒
    '/sb/rest/v1/todos%',
  ])('%s → 拒绝', (p) => {
    expect(upstreamPath(BASE + p)).toBeNull();
  });

  it('查询串里的 % 不受影响（PostgREST 的过滤值、Auth 的 redirect_to 都会编码）', () => {
    expect(upstreamPath(BASE + '/sb/rest/v1/todos?title=eq.%E4%B8%AD&select=*')).toBe('/rest/v1/todos');
    expect(upstreamPath(BASE + '/sb/auth/v1/verify?redirect_to=https%3A%2F%2Flemomemo.com%2Fapp%2F')).toBe('/auth/v1/verify');
    expect(upstreamPath(BASE + '/sb/storage/v1/object/sign/vault-preview/0123456789abcdef0123456789abcdef.pptx?token=a%2Bb')).toBe(
      '/storage/v1/object/sign/vault-preview/0123456789abcdef0123456789abcdef.pptx',
    );
    // # 之后的也不算路径
    expect(upstreamPath(BASE + '/sb/rest/v1/todos#%61')).toBe('/rest/v1/todos');
  });

  it.each([...ARCH_COUNTEREXAMPLES, '/sb/rest/v1/todos%20x', '/sb/rest/v1/todos%252F..%252Fadmin'])(
    'handleSb：%s → 本地 404 not_found，不请求上游',
    async (p) => {
      const s = setup();
      for (const method of ['GET', 'POST']) {
        const r = await handleSb(new Request(BASE + p, { method, headers: { 'X-App-Version': '4.0.0' } }), ENV, s.deps);
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ code: 'not_found' });
      }
      expect(s.fetchStub).not.toHaveBeenCalled();
    },
  );

  it('handleSb：查询串里有 % 的正常请求照常转发，查询串原样带给上游', async () => {
    const s = setup();
    const r = await handleSb(new Request(BASE + '/sb/rest/v1/todos?title=eq.%E4%B8%AD', { method: 'GET' }), ENV, s.deps);
    expect(r.status).toBe(200);
    expect(s.fetchStub).toHaveBeenCalledTimes(1);
    const sent = s.fetchStub.mock.calls[0]?.[0] as Request;
    expect(new URL(sent.url).pathname).toBe('/rest/v1/todos');
    expect(new URL(sent.url).search).toBe('?title=eq.%E4%B8%AD');
  });
});
