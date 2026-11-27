// vault-image（B5 任务单 S8；TC-B5-09 服务器一半、38、43 的响应头、TC-B0-75 vault-image upload 的契约）。
import { describe, expect, it } from 'vitest';
import { VAULT_IMAGE_MAX_BYTES } from '../../shared/schema/vault.ts';
import { VAULT_THUMB_MAX_BYTES } from '../../supabase/functions/_shared/vault-images.ts';
import { handle, isWebp, RATE_PER_MIN } from '../../supabase/functions/vault-image/core.ts';
import { A, B, uuid } from './vault-fakes.ts';
import { I, imageWorld, N, webp } from './vault-image-fakes.ts';

describe('upload', () => {
  it('webp 写进 vault-images，put 显式写 contentType image/webp（TC-B0-75 契约）；重传算成功', async () => {
    const w = imageWorld();
    const r = await w.upload(webp());
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(w.r2.puts).toEqual([{ bucket: 'vault-images', key: `${A}/${N}/${I}.webp`, contentType: 'image/webp' }]);
    expect((await w.upload(webp())).status).toBe(200);
    const t = await w.upload(webp(500), `?action=upload&note_id=${N}&image_id=${I}&part=thumb`);   // 缩略图不要求等于登记的字节数
    expect(t.status).toBe(200);
    expect(w.r2.keys('vault-images')).toEqual([`vault-images/${A}/${N}/${I}.t.webp`, `vault-images/${A}/${N}/${I}.webp`]);
  });

  it('只收预登记的图（整块评审第 3 条）：没登记、别人的、note_id 对不上、已删的、没登记缩略图却传缩略图一律 404，不写对象', async () => {
    const w = imageWorld();
    expect((await w.upload(webp(), `?action=upload&note_id=${N}&image_id=${uuid(7)}&part=full`)).status).toBe(404);
    expect((await w.upload(webp(), `?action=upload&note_id=${uuid(9)}&image_id=${I}&part=full`)).status).toBe(404);
    expect((await w.upload(webp(), undefined, undefined, B)).status).toBe(404);
    w.images.set(uuid(5), { note_id: N, bucket: 'vault-images', has_thumb: false, bytes: 64, user: A });
    expect((await w.upload(webp(), `?action=upload&note_id=${N}&image_id=${uuid(5)}&part=thumb`)).status).toBe(404);
    w.images.set(uuid(6), { note_id: N, bucket: 'vault-images', has_thumb: false, bytes: 64, user: A, deleted: true });
    expect((await w.upload(webp(), `?action=upload&note_id=${N}&image_id=${uuid(6)}&part=full`)).status).toBe(404);
    w.images.set(uuid(8), { note_id: N, bucket: 'images', has_thumb: false, bytes: 64, user: A });
    expect((await w.upload(webp(), `?action=upload&note_id=${N}&image_id=${uuid(8)}&part=full`)).status).toBe(404);
    expect(w.r2.puts).toEqual([]);
  });

  it('不是 webp 415；原图字节数不等于登记的 400；超过 2 MB、缩略图超过 128 KB 413（整块评审第 11 条）；参数不对 400', async () => {
    const w = imageWorld();
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    expect((await w.upload(png)).status).toBe(415);
    expect((await w.upload(webp(65))).status).toBe(400);
    expect((await w.upload(webp(63))).status).toBe(400);
    expect((await w.upload(webp(VAULT_IMAGE_MAX_BYTES + 1))).status).toBe(413);
    expect((await w.upload(webp(VAULT_THUMB_MAX_BYTES + 1), `?action=upload&note_id=${N}&image_id=${I}&part=thumb`)).status).toBe(413);
    expect((await w.upload(webp(VAULT_THUMB_MAX_BYTES), `?action=upload&note_id=${N}&image_id=${I}&part=thumb`)).status).toBe(200);
    expect((await w.upload(webp(), `?action=upload&note_id=${N}&image_id=x&part=full`)).status).toBe(400);
    expect(w.r2.puts.map((p) => p.key)).toEqual([`${A}/${N}/${I}.t.webp`]);
    expect(isWebp(webp(12))).toBe(true);
    expect(isWebp(webp(12).slice(0, 11))).toBe(false);
  });
});

describe('get', () => {
  it('直接回字节：image/webp、no-store、nosniff；缩略图要 has_thumb；别人的、普通桶的、已删的 404', async () => {
    const w = imageWorld();
    w.images.set(I, { note_id: N, bucket: 'vault-images', has_thumb: false, bytes: 80, user: A });
    await w.upload(webp(80));
    const r = await w.get({ action: 'get', image_id: I });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/webp');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(webp(80));
    expect((await w.get({ action: 'get', image_id: I, part: 'thumb' })).status).toBe(404);
    expect((await w.get({ action: 'get', image_id: I }, undefined, B)).status).toBe(404);
    w.images.set(uuid(5), { note_id: N, bucket: 'images', has_thumb: false, bytes: 1, user: A });
    expect((await w.get({ action: 'get', image_id: uuid(5) })).status).toBe(404);
    w.images.set(I, { note_id: N, bucket: 'vault-images', has_thumb: false, bytes: 80, user: A, deleted: true });   // 整块评审第 9 条
    expect((await w.get({ action: 'get', image_id: I })).status).toBe(404);
  });

  it('非 POST 405；每人每分钟 30 次；R2 没配 503 记 misconfigured:r2', async () => {
    const w = imageWorld();
    expect((await handle(new Request('http://x', { method: 'GET' }), w.deps)).status).toBe(405);
    for (let i = 0; i < RATE_PER_MIN; i++) await w.get({ action: 'get', image_id: I });
    expect((await w.get({ action: 'get', image_id: I })).status).toBe(429);
    w.advance(60_000);
    w.deps.r2 = null;
    expect((await w.get({ action: 'get', image_id: I })).status).toBe(503);
    expect(w.logs).toContain('misconfigured:r2');
  });
});

describe('账号停用（TC-B1-10）', () => {
  const denied = () => {
    const w = imageWorld();
    w.deps.authenticate = async () => ({ ok: false, response: new Response('{"error":"account_disabled"}', { status: 403 }) });
    return w;
  };
  it('TC-B1-10 vault-image：管理员停用的账号回 403 account_disabled，不取图', async () => {
    const w = denied();
    const r = await w.get({ action: 'get', image_id: I });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('account_disabled');
  });
  it('TC-B1-10 vault-image：没有 profiles 行的账号回 403 account_disabled，不写对象', async () => {
    const w = denied();
    const r = await w.upload(webp());
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('account_disabled');
    expect(w.r2.puts).toHaveLength(0);
  });
});
