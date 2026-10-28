// /sb 的存储收窄（架构 0.32 / R-213、14.2 第 1 点；TC-B0-119、S-B0 ⑧）：照片和附件改走 /files，/sb 只留 vault-preview 的 GET。
import { describe, expect, it } from 'vitest';
import { handleSb } from '../../functions/sb/[[path]].ts';
import { BASE, ENV, setup } from './sb-harness.ts';

describe('TC-B0-119：/sb 的存储收窄，files_authorize 不经 /sb', () => {
  const VP = '/sb/storage/v1/object/sign/vault-preview/0123456789abcdef0123456789abcdef.pptx?token=abc';
  it.each([
    ['POST', '/sb/storage/v1/object/images/u/n/i.webp'],
    ['PUT', '/sb/storage/v1/object/images/u/n/i.webp'],
    ['POST', '/sb/storage/v1/object/list/images'],
    ['POST', '/sb/storage/v1/object/sign/files/u/n/i.pdf'],
    ['GET', '/sb/storage/v1/object/sign/files/u/n/i.pdf?token=abc'],
    ['GET', '/sb/storage/v1/object/authenticated/images/u/n/i.webp'],
    ['GET', '/sb/storage/v1/object/public/images/x.webp'],
    ['GET', '/sb/storage/v1/bucket'],
    ['POST', '/sb/storage/v1/object/sign/vault-preview/0123456789abcdef0123456789abcdef.pptx'],
    ['DELETE', '/sb/storage/v1/object/sign/vault-preview/0123456789abcdef0123456789abcdef.pptx'],
    ['HEAD', VP],
    ['POST', '/sb/rest/v1/rpc/files_authorize'],
    ['POST', '/sb/rest/v1/rpc/FILES_AUTHORIZE'],
    ['POST', '/sb/rest/v1/rpc/files_authorize/'],
    ['GET', '/sb/rest/v1/rpc/files_authorize?p_op=get'],
  ])('%s %s → 本地 404，不转发', async (m, p) => {
    const s = setup();
    const r = await handleSb(new Request(BASE + p, { method: m, ...(m === 'GET' || m === 'HEAD' ? {} : { body: '{}' }), headers: { 'X-App-Version': '4.0.0' } }), ENV, s.deps);
    expect(r.status).toBe(404);
    if (m !== 'HEAD') expect(await r.json()).toEqual({ code: 'not_found' });
    expect(s.fetchStub).not.toHaveBeenCalled();
  });

  it('vault-preview 的 GET 照常转发（给微软取隐私记 PPT），查询串原样带上', async () => {
    const s = setup();
    const r = await handleSb(new Request(BASE + VP), ENV, s.deps);
    expect(r.status).toBe(200);
    expect(s.fetchStub).toHaveBeenCalledTimes(1);
    expect(new URL(s.first().url).pathname).toBe('/storage/v1/object/sign/vault-preview/0123456789abcdef0123456789abcdef.pptx');
    expect(new URL(s.first().url).search).toBe('?token=abc');
  });
});
