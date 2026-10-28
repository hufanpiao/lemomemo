// /files/v1/* 经 wrangler pages dev 的真实运行环境（架构 0.32、14.2 第 11 点；任务单 FB-3、FB-4 的本地 E2E）：
// 后端是本机假后端（tests/e2e/fake-backends.ts：S3 替身独立验 SigV4，假 files_authorize），函数里的 aws4fetch、FixedLengthStream、
// crypto.subtle 都跑在 workerd 里。整条链路换成本地 Supabase + LocalStack（TC-B0-116）【待 Docker】，预览环境的 R2【待 R2】。
import { randomUUID } from 'node:crypto';
import { expect, test } from './csp-fixture.ts';

/** 1×1 的无损 webp（RIFF....WEBPVP8L） */
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

function ids() {
  const user = randomUUID();
  const path = `${user}/${randomUUID()}/${randomUUID()}.webp`;
  return { user, path, auth: `Bearer fakejwt.${user}` };
}

test.describe('/files/v1/*（本机假后端）', () => {
  test('上传 → 签链接 → 取回：字节一致、类型对、不缓存；重复上传 409；改签名 403', async ({ request }) => {
    const { path, auth } = ids();
    const headers = { Authorization: auth, 'X-App-Version': '4.0.0', 'Content-Type': 'image/webp' };
    const up = await request.put(`/files/v1/o/images/${path}`, { headers, data: WEBP });
    expect(up.status(), await up.text()).toBe(200);
    expect((await up.json()) as { etag: string }).toHaveProperty('etag');
    expect((await request.put(`/files/v1/o/images/${path}`, { headers, data: WEBP })).status()).toBe(409);

    const sign = await request.post('/files/v1/sign', {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      data: { items: [{ bucket: 'images', path, purpose: 'view' }] },
    });
    expect(sign.status()).toBe(200);
    const item = ((await sign.json()) as { items: { ok: boolean; url: string }[] }).items[0];
    expect(item?.ok).toBe(true);
    const url = new URL(item?.url ?? '');
    expect([...url.searchParams.keys()].sort()).toEqual(['d', 'e', 's']);

    const got = await request.get(url.pathname + url.search);
    expect(got.status()).toBe(200);
    expect(got.headers()['content-type']).toBe('image/webp');
    expect(got.headers()['cache-control']).toContain('no-store');
    expect(got.headers()['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(await got.body(), WEBP)).toBe(0);

    const bad = await request.get(url.pathname + url.search.replace(/s=[^&]+/, 's=AAAA'));
    expect(bad.status()).toBe(403);
    expect(await bad.json()).toEqual({ code: 'bad_signature' });
  });

  test('vault-* 不经 /files（403 bad_bucket）；别人的路径 403 not_owner；没带版本号 426；版本过低 426', async ({ request }) => {
    const me = ids();
    const other = ids();
    const h = { Authorization: me.auth, 'X-App-Version': '4.0.0', 'Content-Type': 'image/webp' };
    const vault = await request.put(`/files/v1/o/vault-images/${me.path}`, { headers: h, data: WEBP });
    expect([vault.status(), await vault.json()]).toEqual([403, { code: 'forbidden', reason: 'bad_bucket' }]);
    const theirs = await request.put(`/files/v1/o/images/${other.path}`, { headers: h, data: WEBP });
    expect([theirs.status(), await theirs.json()]).toEqual([403, { code: 'forbidden', reason: 'not_owner' }]);
    // QA D-10：真的不带 X-App-Version 头（原来这里发的是 3.9.0，和标题不符）
    const { 'X-App-Version': _omit, ...noVersion } = h;
    const none = await request.put(`/files/v1/o/images/${me.path}`, { headers: noVersion, data: WEBP });
    expect(none.status()).toBe(426);
    expect((await none.json()) as { code: string }).toHaveProperty('code', 'upgrade_required');
    const old = await request.put(`/files/v1/o/images/${me.path}`, { headers: { ...h, 'X-App-Version': '3.9.0' }, data: WEBP });
    expect(old.status()).toBe(426);
  });

  test('App 页面里用签名链接显示图片：能显示，没有 CSP 报错', async ({ page, request, csp }) => {
    const { path, auth } = ids();
    await request.put(`/files/v1/o/images/${path}`, { headers: { Authorization: auth, 'X-App-Version': '4.0.0', 'Content-Type': 'image/webp' }, data: WEBP });
    const sign = await request.post('/files/v1/sign', {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      data: { items: [{ bucket: 'images', path, purpose: 'view' }] },
    });
    const link = new URL(((await sign.json()) as { items: { url: string }[] }).items[0]?.url ?? '');
    await page.goto('/app/');
    const size = await page.evaluate(async (src) => {
      const img = document.createElement('img');
      img.src = src;
      document.body.append(img);
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, link.pathname + link.search);
    expect(size).toEqual([1, 1]);
    expect(await csp.violations()).toEqual([]);
  });
});
