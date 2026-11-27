// /files 签名格式的回归测试（B1 P-files-sig 安全审查 10-29 要求补的；主体见 files-get.test.ts）：
// 旧的 v1 签名一律不认、请求头的各种变形写法一律不认、“超过上限”判断的 5 秒时钟余量（过期判断不放宽）。
import { describe, expect, it } from 'vitest';
import { b64url, objectUrl, sigHeaderValue, sign } from '../../functions/_lib/files-sign.ts';
import { CLOCK_SKEW_S, sigFrom } from '../../functions/files/[[path]].ts';
import { BASE, ENV, getReq, IMG, PDF, put, setup, T0 } from './files-harness.ts';
import { webp } from './files-fakes.ts';

/** 手算旧的 v1 签名：base64url(HMAC-SHA256(secret, "v1\nGET\n<桶>\n<路径>\n<e>\n<d>"))，没有用途 */
async function signV1(bucket: string, path: string, e: number, d: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(ENV.FILES_URL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`v1\nGET\n${bucket}\n${path}\n${e}\n${d}`));
  return b64url(new Uint8Array(mac));
}

describe('旧的 v1 签名（没有用途）一律不认', () => {
  it('?e=&d=&s=、?e=&s=、X-Files-Sig 三种写法都是 403 bad_signature', async () => {
    const s = setup();
    expect((await s.call(put(PDF, new Uint8Array([1])))).status).toBe(200);
    const e = T0 / 1000 + 30;
    const url = objectUrl(BASE, 'files', PDF);
    const withD = await signV1('files', PDF, e, 'a.pdf');
    const noD = await signV1('files', PDF, e, '');
    const reqs = [
      getReq({ url: `${url}?e=${e}&d=a.pdf&s=${withD}` }),
      getReq({ url: `${url}?e=${e}&s=${noD}` }),
      getReq({ url, sig: sigHeaderValue('download', e, 'a.pdf', withD) }),
      getReq({ url, sig: sigHeaderValue('view', e, '', noD) }),
    ];
    for (const r of reqs) {
      const got = await s.call(r);
      expect([got.status, await got.json()]).toEqual([403, { code: 'bad_signature' }]);
    }
    // 对照：同样的参数用 v2 签就能取（证明上面是因为 v1 才失败）
    const v2 = await sign(ENV.FILES_URL_SECRET, 'download', 'files', PDF, e, 'a.pdf');
    expect((await s.call(getReq({ url, sig: sigHeaderValue('download', e, 'a.pdf', v2) }))).status).toBe(200);
  });
});

describe('X-Files-Sig 的变形写法一律不认', () => {
  it('多头合并、键或用途大小写不对、带空格、末尾 &、键重复 → sigFrom 回 null', () => {
    const ok = 'p=view&e=1&d=&s=x';
    expect(sigFrom(ok, '')).not.toBeNull();
    for (const h of [
      `${ok}, ${ok}`, // 两个同名请求头被合并
      'P=view&e=1&d=&s=x',
      'p=View&e=1&d=&s=x',
      'p=view& e=1&d=&s=x',
      'p=view&e=1&d=&s=x&',
      'p=download&e=1&d=a.pdf&d=b.pdf&s=x',
      'p=view&e=1&d=&d=&s=x',
    ]) {
      expect(sigFrom(h, ''), h).toBeNull();
    }
  });

  it('真的请求里带两个 X-Files-Sig（被合并成一个值）→ 403 bad_signature', async () => {
    const s = setup();
    await s.call(put(IMG, webp(20)));
    const e = T0 / 1000 + 30;
    const v = sigHeaderValue('view', e, '', await sign(ENV.FILES_URL_SECRET, 'view', 'images', IMG, e, ''));
    const h = new Headers();
    h.append('X-Files-Sig', v);
    h.append('X-Files-Sig', v);
    const r = await s.call(new Request(objectUrl(BASE, 'images', IMG), { headers: h }));
    expect([r.status, await r.json()]).toEqual([403, { code: 'bad_signature' }]);
  });
});

describe('有效期上限的时钟余量（安全审查低）', () => {
  const at = async (s: ReturnType<typeof setup>, e: number) =>
    s.call(getReq({ url: objectUrl(BASE, 'images', IMG), sig: sigHeaderValue('view', e, '', await sign(ENV.FILES_URL_SECRET, 'view', 'images', IMG, e, '')) }));

  it('硬上限 600 秒：600 + 5 秒内过了硬上限这一关（再被按用途的 120 秒拦），600 + 6 秒被硬上限拦', async () => {
    expect(CLOCK_SKEW_S).toBe(5);
    const s = setup();
    const nowS = T0 / 1000;
    expect((await at(s, nowS + 605)).status).toBe(403);
    expect(s.logs.at(-1)?.code).toBe('get_ttl_over_purpose');
    expect((await at(s, nowS + 606)).status).toBe(403);
    expect(s.logs.at(-1)?.code).toBe('get_ttl_over_max');
  });

  it('按用途的上限：图片 view 120 + 5 秒放行，120 + 6 秒拒', async () => {
    const s = setup();
    await s.call(put(IMG, webp(20)));
    const nowS = T0 / 1000;
    expect((await at(s, nowS + 125)).status).toBe(200);
    const over = await at(s, nowS + 126);
    expect([over.status, await over.json()]).toEqual([403, { code: 'bad_signature' }]);
  });

  it('过期判断不放宽：到期那一秒还能取，过 1 秒就 expired（没有 5 秒余量）', async () => {
    const s = setup();
    await s.call(put(IMG, webp(20)));
    const nowS = T0 / 1000;
    expect((await at(s, nowS)).status).toBe(200);
    const late = await at(s, nowS - 1);
    expect([late.status, await late.json()]).toEqual([403, { code: 'expired' }]);
  });
});
