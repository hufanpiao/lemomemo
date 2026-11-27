// TC-B1-90（架构 0.29 续第 110 条①、续第 119 条②）：队列收到 try_later 只退避重试
// • 不计 tries；按“连续 try_later 次数”退避 5 秒、30 秒、2 分钟、之后每 5 分钟；不清本机、不设闸、不发 removed / disabled 事件
// • 连续次数是队列级的，存在 meta 的 try_later_streak（try_later 是整台服务器忙，不是某一条的问题）
// • 清零：任何一条发送成功（ack）；收到别的失败（其他 5xx、429、断网、4xx 等）也清零——“连续”指中间没夹别的回应：
//   服务器已经回了别的东西，说明那一阵忙已经过去或换了一种故障，下次再遇到 try_later 从 5 秒重新数，不沿用上一阵的长等待
// • 缺键或值不合法（不是非负整数）当 0
// • 服务器回的形状：Edge Function 回 503 {error: 'try_later'}；经 PostgREST 是 400、code 从 message 取出（见 outbox-logic.test.ts）
import { beforeEach, describe, expect, it } from 'vitest';
import type { Cache } from '../cache.ts';
import type { Outbox, OutboxItem } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { clock, seed, setup, todo, uid } from './outbox-fixtures.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

const TRY_LATER_503 = { status: 503, code: 'try_later', sid: null };

/** 两条待发（用例：outbox 里有 2 条），事件记下来 */
async function twoPending(): Promise<{ cache: Cache; outbox: Outbox; events: string[] }> {
  const { cache, outbox } = await setup();
  await seed(cache, 'todos', uid(1), todo(1), 5);
  await seed(cache, 'todos', uid(2), todo(2), 5);
  const events: string[] = [];
  outbox.onEvent((e) => events.push(e.type));
  await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改一' } });
  await outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '改二' } });
  return { cache, outbox, events };
}

const byId = async (outbox: Outbox, id: string): Promise<OutboxItem | undefined> => (await outbox.list()).find((i) => i.id === id);

describe('TC-B1-90：队列收到 try_later', () => {
  it('连续 try_later：不计 tries，节奏 5 秒、30 秒、2 分钟、5 分钟、5 分钟；两条都留在 pending；不设闸、不发 removed，不回滚', async () => {
    const { cache, outbox, events } = await twoPending();
    const waits: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const a = await outbox.next();
      expect(a?.id).toBe(uid(1));
      expect(await outbox.fail(a?.op_id ?? '', TRY_LATER_503)).toBe('transient');
      const cur = await byId(outbox, uid(1));
      expect(cur?.tries).toBe(0);
      expect(cur?.state).toBe('pending');
      waits.push((cur?.next_at ?? 0) - clock.t);
      expect(await cache.getMeta('try_later_streak')).toBe(n);
      clock.t = cur?.next_at ?? clock.t;
    }
    expect(waits).toEqual([5_000, 30_000, 120_000, 300_000, 300_000]);
    expect((await outbox.list()).map((i) => [i.id, i.state, i.tries])).toEqual([
      [uid(1), 'pending', 0],
      [uid(2), 'pending', 0],
    ]);
    expect(outbox.isSuspended()).toBe(false);
    expect(events).not.toContain('removed');
    expect(events).not.toContain('disabled');
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('改一');
  });

  it('经 PostgREST 来的 400 try_later 也一样：不当永久失败，不进“发送失败”区', async () => {
    const { outbox, events } = await twoPending();
    const a = await outbox.next();
    expect(await outbox.fail(a?.op_id ?? '', { status: 400, code: 'try_later', sid: null })).toBe('transient');
    const cur = await byId(outbox, uid(1));
    expect([cur?.state, cur?.tries, (cur?.next_at ?? 0) - clock.t]).toEqual(['pending', 0, 5_000]);
    expect(events).not.toContain('error');
  });

  it('对照：别的 503、5xx、429、断网照旧计 tries、退避 2 秒起；夹在中间就把连续次数清零', async () => {
    const { cache, outbox } = await twoPending();
    let a = await outbox.next();
    await outbox.fail(a?.op_id ?? '', TRY_LATER_503);
    clock.t += 5_000;
    a = await outbox.next();
    await outbox.fail(a?.op_id ?? '', TRY_LATER_503);
    expect(await cache.getMeta('try_later_streak')).toBe(2);
    clock.t += 30_000;
    a = await outbox.next();
    expect(await outbox.fail(a?.op_id ?? '', { status: 503, sid: null })).toBe('transient');
    let cur = await byId(outbox, uid(1));
    expect([cur?.tries, (cur?.next_at ?? 0) - clock.t]).toEqual([1, 2_000]);
    expect(await cache.getMeta('try_later_streak') ?? 0).toBe(0);
    // 再来 try_later：从 5 秒重新数，tries 保持上一次的 1 不再加
    clock.t += 2_000;
    a = await outbox.next();
    await outbox.fail(a?.op_id ?? '', TRY_LATER_503);
    cur = await byId(outbox, uid(1));
    expect([cur?.tries, (cur?.next_at ?? 0) - clock.t]).toEqual([1, 5_000]);
    for (const f of [{ status: 500 }, { status: 429 }, { network: true }]) {
      clock.t = (await byId(outbox, uid(1)))?.next_at ?? clock.t;
      a = await outbox.next();
      const before = (await byId(outbox, uid(1)))?.tries ?? 0;
      expect(await outbox.fail(a?.op_id ?? '', { ...f, sid: null })).toBe('transient');
      expect((await byId(outbox, uid(1)))?.tries).toBe(before + 1);
      expect(await cache.getMeta('try_later_streak') ?? 0).toBe(0);
    }
  });

  it('任何一条发送成功就清零：之后再遇到 try_later 从 5 秒数起', async () => {
    const { cache, outbox } = await twoPending();
    let a = await outbox.next();
    await outbox.fail(a?.op_id ?? '', TRY_LATER_503);
    clock.t += 5_000;
    a = await outbox.next();
    await outbox.fail(a?.op_id ?? '', TRY_LATER_503);
    expect(await cache.getMeta('try_later_streak')).toBe(2);
    clock.t += 30_000;
    a = await outbox.next();
    await outbox.ack(a?.op_id ?? '', { status: 'ok', rev: 6, prev_rev: 5 });
    expect(await cache.getMeta('try_later_streak') ?? 0).toBe(0);
    a = await outbox.next();
    expect(a?.id).toBe(uid(2));
    await outbox.fail(a?.op_id ?? '', TRY_LATER_503);
    expect(((await byId(outbox, uid(2)))?.next_at ?? 0) - clock.t).toBe(5_000);
  });

  it('meta 里的值缺了或不合法（字符串、负数、小数）都当 0：下一次按第 1 次算 5 秒', async () => {
    for (const bad of ['x', -3, 2.5, null]) {
      const { cache, outbox } = await twoPending();
      await cache.setMeta('try_later_streak', bad as unknown as number);
      const a = await outbox.next();
      await outbox.fail(a?.op_id ?? '', TRY_LATER_503);
      expect(((await byId(outbox, uid(1)))?.next_at ?? 0) - clock.t).toBe(5_000);
      expect(await cache.getMeta('try_later_streak')).toBe(1);
    }
  });

  // R272-sugg ②：其余各支对 streak 的处理逐支锁住（先在 meta 里放 3，再发一次失败，看 streak 有没有被动）
  const cleared: Array<[string, { status?: number; code?: string }, string]> = [
    ['426 要升级', { status: 426, code: 'upgrade_required' }, 'upgrade'],
    ['401 令牌过期', { status: 401 }, 'auth'],
    ['永久失败（其他 4xx）', { status: 400, code: 'bad_input' }, 'permanent'],
    ['丢掉（not_found）', { status: 400, code: 'not_found' }, 'drop'],
  ];
  for (const [name, f, kind] of cleared) {
    it(`收到${name}：服务器回了别的，连续次数清零`, async () => {
      const { cache, outbox } = await twoPending();
      await cache.setMeta('try_later_streak', 3);
      const a = await outbox.next();
      expect(await outbox.fail(a?.op_id ?? '', { ...f, sid: null })).toBe(kind);
      expect(await cache.getMeta('try_later_streak')).toBeUndefined();
      if (kind === 'drop') expect(await byId(outbox, uid(1))).toBeUndefined();   // 这一项确实丢掉了
    });
  }

  const untouched: Array<[string, { status?: number; code?: string }, string]> = [
    ['被停用（account_disabled）', { status: 403, code: 'account_disabled' }, 'disabled'],
    ['注销冷静期（account_pending_deletion）', { status: 403, code: 'account_pending_deletion' }, 'disabled'],
    ['被移除（session_revoked）', { status: 401, code: 'session_revoked' }, 'removed'],
  ];
  for (const [name, f, kind] of untouched) {
    it(`收到${name}：设闸，不碰连续次数（随后整库清掉）`, async () => {
      const { cache, outbox } = await twoPending();
      await cache.setMeta('try_later_streak', 3);
      const a = await outbox.next();
      expect(await outbox.fail(a?.op_id ?? '', { ...f, sid: null })).toBe(kind);
      expect(outbox.isSuspended()).toBe(true);
      expect(await outbox.next()).toBeNull();   // 设闸后不再发送
      expect(await cache.getMeta('try_later_streak')).toBe(3);
    });
  }
});
