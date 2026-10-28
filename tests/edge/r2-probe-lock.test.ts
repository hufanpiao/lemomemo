// r2-probe 续：条件写不生效、删失败、没权限、超时、连不上时都如实报出来；总预算（含拿锁、读响应体、清理）；
// 按时段分键的锁（并发、锁过期时并发）；release。公共部分在 r2-probe-setup.ts。
import { describe, expect, it } from 'vitest';
import { handle } from '../../supabase/functions/_preview/r2-probe/handler.ts';
import { BUCKETS, COOLDOWN_MS, LOCK_BUCKET, lockKey } from '../../supabase/functions/_preview/r2-probe/probe.ts';
import { ObjStoreError } from '../../shared/objstore.ts';
import { leftover, lockCount, post, PREVIEW, type Report, setup, T0 } from './r2-probe-setup.ts';

describe('r2-probe：如实报出 R2 的问题', () => {
  it('条件写不生效（对象已在仍写成功）→ put_if_absent_again 不通过，code = overwrote；照样清干净', async () => {
    const s = setup({ ignoreIfNoneMatch: true });
    const rep = (await (await handle(post(), s.deps)).json()) as Report;
    expect(rep.ok).toBe(false);
    for (const b of rep.buckets) expect(b.steps.find((x) => x.step === 'put_if_absent_again')).toMatchObject({ ok: false, code: 'overwrote' });
    expect(leftover(s)).toEqual([0, 0, 0, 0]);
  });

  it('令牌碰得到正式桶（HEAD 回 404 = 有权限）→ isolation 不通过，code = allowed；正式桶里什么都没写', async () => {
    const s = setup({ prodReachable: true });
    const rep = (await (await handle(post(), s.deps)).json()) as Report;
    expect(rep.ok).toBe(false);
    expect(rep.isolation.map((i) => [i.ok, i.code, i.status])).toEqual(BUCKETS.map(() => [false, 'allowed', 404]));
    for (const b of BUCKETS) expect(s.mem.count(b, ''), b).toBe(0);
    expect(s.mem.calls.filter((c) => !c.bucket.startsWith('preview-')).map((c) => c.op)).toEqual(['head', 'head', 'head', 'head']);
  });

  it('批量删失败一次 → delete_many 报错码，清理步骤补删、最后为 0', async () => {
    const s = setup();
    s.mem.failOnce('deleteMany', new ObjStoreError('http', 500));
    const rep = (await (await handle(post(), s.deps)).json()) as Report;
    expect(rep.ok).toBe(false);
    const first = rep.buckets[0];
    expect(first?.steps.find((x) => x.step === 'delete_many')).toMatchObject({ ok: false, code: 'http', status: 500 });
    expect(first?.steps.find((x) => x.step === 'cleanup')).toMatchObject({ ok: true, count: 0 });
    expect(rep.buckets.slice(1).every((b) => b.ok)).toBe(true);
    expect(leftover(s)).toEqual([0, 0, 0, 0]);
  });

  it('某个桶第一步写就被拒（令牌没有这个桶的写权限）→ 这个桶后面几步跳过，仍再列一次；别的桶照常', async () => {
    const s = setup({ denyPut: 'preview-files' });
    const rep = (await (await handle(post(), s.deps)).json()) as Report;
    expect(rep.ok).toBe(false);
    const files = rep.buckets.find((b) => b.bucket === 'files');
    expect(files?.steps.map((x) => [x.step, x.code])).toEqual([
      ['put', 'denied'],
      ['put_if_absent_again', 'skipped'],
      ['get', 'skipped'],
      ['put_second', 'skipped'],
      ['list', 'skipped'],
      ['delete_many', 'skipped'],
      ['list_after', null],
    ]);
    expect(files?.steps[0]?.status).toBe(403);
    expect(rep.buckets.filter((b) => b.bucket !== 'files').every((b) => b.ok)).toBe(true);
  });

  it('连不上或没有锁所在桶的权限 → 503 lock_failed，带错误码和状态，不往下跑', async () => {
    const s = setup();
    s.mem.failOnce('get', new ObjStoreError('denied', 403));
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'lock_failed', code: 'denied', status: 403, region: 'ap-northeast-2' });
    expect(s.mem.calls.map((c) => c.op)).toEqual(['get']);
    const t = setup();
    t.mem.failOnce('get', new ObjStoreError('timeout'));
    expect(await (await handle(post(), t.deps)).json()).toMatchObject({ error: 'lock_failed', code: 'timeout' });
  });

  it('总预算用完（主步骤先停，清理用预留时间）→ 剩下的步骤和正式桶 HEAD 标 deadline；没清干净的桶一定在报告里如实写着', async () => {
    for (const tick of [300, 500, 800]) {
      const s = setup({ tick });
      const rep = (await (await handle(post(), s.deps)).json()) as Report;
      expect(rep.ok, String(tick)).toBe(false);
      expect(rep.buckets.flatMap((b) => b.steps.map((x) => x.code))).toContain('deadline');
      expect(rep.isolation.every((i) => i.code === 'deadline')).toBe(true);
      leftover(s).forEach((n, i) => {
        if (n > 0) expect(rep.buckets[i]?.steps.find((x) => x.step === 'cleanup')?.ok, `${tick} ${PREVIEW[i]}`).toBe(false);
      });
    }
  });

  it('预算在拿锁之前就用完 → 503 lock_failed / deadline，一个请求都不发', async () => {
    const s = setup({ budgetMs: 1 });
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'lock_failed', code: 'deadline' });
    expect(s.mem.calls).toEqual([]);
  });

  it('读锁的响应体一直不结束 → 读响应体也在预算里，按时报 deadline，不挂着', async () => {
    const s = setup({ hangGet: true, budgetMs: 60 });
    const t = Date.now();
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'lock_failed', code: 'deadline' });
    expect(Date.now() - t).toBeLessThan(2000);
    // 报 deadline 的同时中止了底下的请求（第二轮审查低 2）
    expect(s.aborted).toEqual([lockKey(T0)]);
  });
});

describe('r2-probe：频率保护（按时段分键的锁，被挡回只花一次读）', () => {
  it('同一时段内再调 → 429 busy 和 Retry-After（到下一时段的秒数），只读了一次锁', async () => {
    const s = setup();
    expect((await handle(post(), s.deps)).status).toBe(200);
    s.mem.calls.length = 0;
    s.advance(10_000);
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: string; retry_after_s: number };
    expect(body.error).toBe('busy');
    expect(body.retry_after_s).toBe(Math.ceil((COOLDOWN_MS - 10_000) / 1000));
    expect(r.headers.get('retry-after')).toBe(String(body.retry_after_s));
    expect(s.mem.calls.map((c) => c.op)).toEqual(['get']);
  });

  it('到了下一时段 → 用新时段的锁正常跑；上一时段的锁留着，更早的才清掉', async () => {
    const s = setup();
    await handle(post(), s.deps);
    s.advance(COOLDOWN_MS);
    const r1 = await handle(post(), s.deps);
    expect(r1.status).toBe(200);
    const rep1 = (await r1.json()) as Report;
    expect(rep1.ok).toBe(true);
    expect(rep1.old_locks_removed).toBe(0);
    expect(lockCount(s)).toBe(2);
    s.advance(COOLDOWN_MS);
    const rep2 = (await (await handle(post(), s.deps)).json()) as Report;
    expect(rep2.old_locks_removed).toBe(1);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0))).toBe(0);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0 + COOLDOWN_MS))).toBe(1);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0 + 2 * COOLDOWN_MS))).toBe(1);
  });

  it('审查员的三步场景：k 拿锁 → k+1 跑完清旧锁 → now 还落在 k 末尾的晚到请求 → 必须 busy', async () => {
    const s = setup();
    expect((await handle(post(), s.deps)).status).toBe(200);
    s.at(T0 + COOLDOWN_MS + 1000);
    expect((await handle(post(), s.deps)).status).toBe(200);
    s.at(T0 + COOLDOWN_MS - 1);
    const late = await handle(post(), s.deps);
    expect(late.status).toBe(429);
    expect(await late.json()).toMatchObject({ error: 'busy' });
  });

  it('两个请求同时到 → 条件写只让一个拿到锁', async () => {
    const s = setup();
    const [a, b] = await Promise.all([handle(post(), s.deps), handle(post(), s.deps)]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
  });

  it('锁过期时并发（上一时段的锁还在，新时段三个请求同时到）→ 只有一个赢家，其余 429；新锁没被删', async () => {
    const s = setup();
    await handle(post(), s.deps);
    s.advance(COOLDOWN_MS + 1);
    const rs = await Promise.all([handle(post(), s.deps), handle(post(), s.deps), handle(post(), s.deps)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0 + COOLDOWN_MS + 1))).toBe(1);
    expect(lockCount(s)).toBe(2);
  });

  it('当前时段的锁已在（不管内容）→ 429，不碰它', async () => {
    const s = setup();
    s.mem.plant(`preview-${LOCK_BUCKET}`, lockKey(T0), new TextEncoder().encode('garbage'));
    expect((await handle(post(), s.deps)).status).toBe(429);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0))).toBe(1);
  });

  it('release 和 run 共用一个时段名额：跑过后同一时段 release 回 429；冷却期内连调 release 也回 429，只读一次锁', async () => {
    const s = setup({ wall: T0 + 60_000 });
    await handle(post(), s.deps);
    expect((await handle(post({ action: 'release' }), s.deps)).status).toBe(429);
    s.advance(COOLDOWN_MS);
    const r = await handle(post({ action: 'release' }), s.deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ released: true, removed: 0, leftovers: { images: 0, files: 0, 'vault-images': 0, 'vault-files': 0 } });
    for (let i = 0; i < 3; i++) {
      s.advance(10_000);
      s.mem.calls.length = 0;
      const again = await handle(post({ action: 'release' }), s.deps);
      expect(again.status).toBe(429);
      expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(s.mem.calls.map((c) => c.op)).toEqual(['get']);
    }
    // release 占了这个时段，run 也要等下一时段
    expect((await handle(post(), s.deps)).status).toBe(429);
  });

  it('release 在时段开头 30 秒内回 429（上一时段的 run 可能还在跑），一个请求都不发', async () => {
    const s = setup({ wall: T0 + 1000 });
    const r = await handle(post({ action: 'release' }), s.deps);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('29');
    expect(s.mem.calls).toEqual([]);
  });

  it('release 清掉测试对象和更早时段的锁，当前、上一时段的锁留着；四个桶除锁以外各剩 0', async () => {
    const s = setup({ wall: T0 + 60_000 });
    await handle(post(), s.deps);
    s.advance(COOLDOWN_MS);
    await handle(post(), s.deps);
    s.advance(COOLDOWN_MS);
    s.mem.plant('preview-vault-files', `_probe/${'cd'.repeat(16)}/b.txt`, new Uint8Array([1]));
    const r = await handle(post({ action: 'release' }), s.deps);
    expect(await r.json()).toEqual({ released: true, removed: 2, leftovers: { images: 0, files: 0, 'vault-images': 0, 'vault-files': 0 } });
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0))).toBe(0);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0 + COOLDOWN_MS))).toBe(1);
    expect(s.mem.count(`preview-${LOCK_BUCKET}`, lockKey(T0 + 2 * COOLDOWN_MS))).toBe(1);
    expect(leftover(s)).toEqual([0, 0, 0, 0]);
  });

  it('release 只删本函数命名的键；别的 _probe/ 键只报个数、不删，用户的对象不碰', async () => {
    const s = setup({ wall: T0 + 60_000 });
    const b = new Uint8Array([1]);
    s.mem.plant('preview-files', `_probe/${'ab'.repeat(16)}/a.txt`, b);
    s.mem.plant('preview-files', '_probe/someone-else.txt', b);
    s.mem.plant('preview-files', 'aaaaaaaa-0000-4000-8000-000000000001/x.pdf', b);
    const r = await handle(post({ action: 'release' }), s.deps);
    expect(await r.json()).toEqual({ released: true, removed: 1, leftovers: { images: 0, files: 1, 'vault-images': 0, 'vault-files': 0 } });
    expect(s.mem.count('preview-files', '_probe/someone-else.txt')).toBe(1);
    expect(s.mem.count('preview-files', 'aaaaaaaa-')).toBe(1);
    expect(s.deleted).toEqual([`_probe/${'ab'.repeat(16)}/a.txt`]);
  });
});
