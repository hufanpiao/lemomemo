// r2-probe（预览专用、一次性的 R2 探测函数；supabase/functions/_preview/r2-probe/，说明见 docs/09-路线图/B0-R2探测函数.md）
// 证明：只在 preview- 前缀下生效；过期回 410；只收 POST；只碰 _probe/ 前缀、跑完清干净、不动别的对象；响应里不回显凭据、endpoint、内容和键名。
// 出错时如实报、频率保护和 release 在 r2-probe-lock.test.ts；公共部分在 r2-probe-setup.ts。
import { describe, expect, it } from 'vitest';
import { EXPIRES_AT, handle } from '../../supabase/functions/_preview/r2-probe/handler.ts';
import { BUCKETS, LOCK_BUCKET, lockKey } from '../../supabase/functions/_preview/r2-probe/probe.ts';
import { putSeedObjects, seedObjects } from '../fakes/objstore-seed.ts';
import { leftover, lockCount, post, PREVIEW, type Report, SECRET_LIKE, setup, T0, touched } from './r2-probe-setup.ts';

describe('r2-probe：只在预览生效、到期失效', () => {
  it.each([['（没设）', undefined], ['空串（正式）', ''], ['prod-', 'prod-'], ['preview', 'preview']])('R2_BUCKET_PREFIX 是 %s → 404，不建客户端、不碰存储', async (_, prefix) => {
    const s = setup({ prefix });
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
    expect(s.made).toEqual([]);
    expect(s.mem.calls).toEqual([]);
  });

  it('过了 EXPIRES_AT（2026-11-10T15:00:00Z）→ 410 expired，不建客户端、不碰存储；正式环境照旧 404', async () => {
    expect(EXPIRES_AT).toBe(Date.parse('2026-11-10T15:00:00Z'));
    for (const wall of [EXPIRES_AT, EXPIRES_AT + 86_400_000]) {
      const s = setup({ wall });
      const r = await handle(post(), s.deps);
      expect(r.status).toBe(410);
      expect(await r.json()).toEqual({ error: 'expired' });
      expect((await handle(post({ action: 'release' }), s.deps)).status).toBe(410);
      expect((await handle(new Request('https://x/', { method: 'GET' }), s.deps)).status).toBe(410);
      expect(s.made).toEqual([]);
      expect(s.mem.calls).toEqual([]);
    }
    expect((await handle(post(), setup({ wall: EXPIRES_AT + 1, prefix: '' }).deps)).status).toBe(404);
    expect((await handle(post(), setup({ wall: EXPIRES_AT - 1 }).deps)).status).toBe(200);
  });

  it('只收 POST：GET、PUT、DELETE、OPTIONS → 405，不碰存储', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const s = setup();
      const r = await handle(new Request('https://x/functions/v1/r2-probe', { method }), s.deps);
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
      expect(s.mem.calls).toEqual([]);
    }
  });

  it.each([
    ['不是 JSON', 'run'],
    ['没有 action', {}],
    ['未知 action', { action: 'delete_all' }],
    ['多余的字段', { action: 'run', prefix: '' }],
    ['数组', ['run']],
    ['超过 256 字节', { action: 'run'.padEnd(300, ' ') }],
  ])('请求体%s → 400，不碰存储', async (_, body) => {
    const s = setup();
    const r = await handle(post(body), s.deps);
    expect(r.status).toBe(400);
    expect(s.mem.calls).toEqual([]);
  });

  it('缺令牌（建客户端抛错）→ 500 misconfigured，响应里没有错误原文和地址', async () => {
    const s = setup({ misconfigured: true });
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'misconfigured' });
    expect(text).not.toContain('r2.cloudflarestorage.com');
  });
});

describe('r2-probe：一次完整的运行', () => {
  it('四个预览桶各做写、条件写、读、列、批量删、再列，全部通过；正式桶被拒；跑完只剩当前时段的锁', async () => {
    const s = setup();
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const rep = (await r.json()) as Report;
    expect(rep.ok).toBe(true);
    expect(rep.region).toBe('ap-northeast-2');
    expect(rep.buckets.map((b) => b.bucket)).toEqual([...BUCKETS]);
    for (const b of rep.buckets) {
      expect(b.steps.map((x) => x.step), b.bucket).toEqual(['put', 'put_if_absent_again', 'get', 'put_second', 'list', 'delete_many', 'list_after']);
      expect(b.steps.every((x) => x.ok), b.bucket).toBe(true);
      expect(b.steps.find((x) => x.step === 'put_if_absent_again')).toMatchObject({ code: 'exists', status: 412 });
      expect(b.steps.find((x) => x.step === 'list')?.count).toBe(2);
      expect(b.steps.find((x) => x.step === 'list_after')?.count).toBe(0);
    }
    expect(rep.isolation.map((i) => [i.bucket, i.ok, i.code, i.status])).toEqual(BUCKETS.map((b) => [b, true, 'denied', 403]));
    expect(rep.old_locks_removed).toBe(0);
    expect(leftover(s)).toEqual([0, 0, 0, 0]);
    expect(lockCount(s)).toBe(1);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0))).toBe(1);
  });

  it('只碰 _probe/ 前缀：每个请求的键或前缀都以 _probe/ 开头，列只按本次的随机前缀或 _probe/lock-；正式桶一个请求都没进替身', async () => {
    const s = setup();
    await handle(post(), s.deps);
    expect(s.mem.calls.length).toBeGreaterThan(0);
    for (const k of touched(s.mem.calls)) expect(k.startsWith('_probe/'), k).toBe(true);
    for (const c of s.mem.calls.filter((x) => x.op === 'list')) expect(c.prefix).toMatch(/^_probe\/([0-9a-f]{32}\/|lock-)$/);
    // 删的只有自己写的 a.txt、b.txt（四个桶各一次）
    expect(s.deleted.length).toBe(8);
    for (const k of s.deleted) expect(k).toMatch(/^_probe\/[0-9a-f]{32}\/(a|b)\.txt$/);
    expect(s.mem.calls.every((c) => c.bucket.startsWith('preview-'))).toBe(true);
    expect(s.made).toEqual(['preview-', '']);
  });

  it('桶里原有的对象（A、B 两个用户的 seed）一个不少、没被读', async () => {
    const s = setup();
    await putSeedObjects({ put: (b, k, body, o) => s.mem.put(`preview-${b}`, k, body, o) });
    const before = PREVIEW.map((b) => s.mem.count(b, ''));
    s.mem.calls.length = 0;
    const r = await handle(post(), s.deps);
    expect(((await r.json()) as Report).ok).toBe(true);
    expect(PREVIEW.map((b) => s.mem.count(b, '') - (b === `preview-${LOCK_BUCKET}` ? 1 : 0))).toEqual(before);
    for (const o of seedObjects()) expect(touched(s.mem.calls)).not.toContain(o.key);
  });

  it('响应里没有令牌、endpoint、对象键名和内容', async () => {
    const s = setup();
    const text = await (await handle(post(), s.deps)).text();
    for (const v of SECRET_LIKE) expect(text).not.toContain(v);
    expect(text).not.toContain('_probe/');
    expect(text).not.toContain('a.txt');
    expect(text).not.toContain('lemo r2-probe');
    expect(text).not.toContain('r2.cloudflarestorage.com');
  });
});
