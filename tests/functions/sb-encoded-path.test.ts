// `/sb/*` 的拒绝名单先做百分号解码再比（QA D-02、代码审查低 7、安全审查低 1；TC-B0-39、TC-B0-119 的转发层部分）。
// 上游（Kong、PostgREST、GoTrue）会解码路径：`%5F`、`%61`、多重编码 `%255F`、大小写不同的写法都不能绕过拒绝名单。
// 线上 Cloudflare 边缘会不会先规整这类编码，见 tests/e2e/sb-forward.preview.test.ts【待预览】。
import { describe, expect, it } from 'vitest';
import { handleSb, upstreamPath } from '../../functions/sb/[[path]].ts';
import { BASE, ENV, setup } from './sb-harness.ts';

describe('upstreamPath：百分号编码绕不过拒绝名单（QA D-02）', () => {
  it.each([
    // 单层：编码过的非保留字符
    '/sb/rest/v1/rpc/files%5Fauthorize',
    '/sb/rest/v1/rpc/files%5fauthorize',
    '/sb/rest/v1/rpc/%66iles_authorize',
    '/sb/rest/v1/rpc/%46ILES_AUTHORIZE',
    '/sb/auth/v1/%61dmin/users',
    '/sb/auth/v1/%41DMIN/users',
    '/sb/auth/v1/adm%69n',
    // 多重编码
    '/sb/rest/v1/rpc/files%255Fauthorize',
    '/sb/rest/v1/rpc/files%25255Fauthorize',
    '/sb/auth/v1/%2561dmin/users',
    '/sb/auth/v1/%252561dmin/users',
    // 编码的斜杠、点、反斜杠、空字节：单层早就拒，多重编码也拒
    '/sb/rest/v1/todos%2F..%2Fadmin',
    '/sb/rest/v1/todos%252F..%252Fadmin',
    '/sb/rest/v1/todos%252f..%252fadmin',
    '/sb/rest/v1/todos%25252F..',
    '/sb/rest/v1/%252e%252e/auth/v1/admin',
    '/sb/rest/v1/%252E%252E/x',
    '/sb/rest/v1/todos%255cx',
    '/sb/rest/v1/todos%2500',
    // 解码后落到拒绝的“/rest/v1/ 根”
    '/sb/rest/v1/%252F',
    // 解不开的编码一律拒
    '/sb/rest/v1/%',
    '/sb/rest/v1/todos%2',
    '/sb/rest/v1/todos%zz',
    '/sb/rest/v1/todos%C0%AF',
    // 编码层数过多也拒（不无限解下去）
    '/sb/rest/v1/todos%25252525252541',
  ])('%s → 拒绝', (p) => {
    expect(upstreamPath(BASE + p)).toBeNull();
  });

  it('正常的编码照常放行，转发原样（不替上游解码）', () => {
    expect(upstreamPath(BASE + '/sb/functions/v1/ai%2Dparse')).toBe('/functions/v1/ai%2Dparse');
    expect(upstreamPath(BASE + '/sb/rest/v1/rpc/files_authorize_x')).toBeNull(); // 前缀匹配：名单项开头的一律拒
    expect(upstreamPath(BASE + '/sb/rest/v1/todos%20x')).toBe('/rest/v1/todos%20x');
  });

  it.each(['/sb/rest/v1/rpc/files%5Fauthorize', '/sb/auth/v1/%2561dmin/users', '/sb/rest/v1/todos%252F..%252Fadmin'])(
    'handleSb：%s → 404，不请求上游',
    async (p) => {
      const s = setup();
      const r = await handleSb(new Request(BASE + p, { method: 'POST', headers: { 'X-App-Version': '4.0.0' } }), ENV, s.deps);
      expect(r.status).toBe(404);
      expect(s.fetchStub).not.toHaveBeenCalled();
    },
  );
});
