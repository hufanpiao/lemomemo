// “＋”上方的小气泡（B3 S23）：前 3 次打开显示、每次启动只算一次、按住过就不再出现；次数记在 drafts 仓（prefs）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markPlusHeld, PLUS_HINT_ENABLED, PLUS_HINT_ID, plusHeldNow, plusHintThisLaunch, resetPlusHintForTest, watchPlusHeld } from '../data/plus-hint.ts';

type Draft = { id: string; kind: string; data: unknown; updated_at: number };

function fakeCache(init?: Draft) {
  const m = new Map<string, Draft>();
  if (init) m.set(init.id, init);
  return {
    m,
    getDraft: async (id: string) => m.get(id) ?? null,
    putDraft: async (d: Draft) => {
      m.set(d.id, d);
    },
  };
}
// 只用到 getDraft、putDraft
type Store = Parameters<typeof plusHintThisLaunch>[1];
const asStore = (c: ReturnType<typeof fakeCache>): Store => c as unknown as Store;

beforeEach(() => resetPlusHintForTest());

describe('plusHintThisLaunch', () => {
  it('FA-3 接上录音以后开关打开', () => expect(PLUS_HINT_ENABLED).toBe(true));

  it('前 3 次启动显示，第 4 次起不显示；次数记在 capture:hint', async () => {
    const c = fakeCache();
    const seen: (boolean | null)[] = [];
    for (let i = 0; i < 4; i++) {
      resetPlusHintForTest();
      seen.push(await plusHintThisLaunch(1000 + i, asStore(c)));
    }
    expect(seen).toEqual([true, true, true, false]);
    expect(c.m.get(PLUS_HINT_ID)).toMatchObject({ kind: 'hint', data: { opens: 3, held: false } });
  });

  it('同一次启动调几次只算一次', async () => {
    const c = fakeCache();
    expect(await plusHintThisLaunch(1, asStore(c))).toBe(true);
    expect(await plusHintThisLaunch(2, asStore(c))).toBe(true);
    expect(c.m.get(PLUS_HINT_ID)?.data).toEqual({ opens: 1, held: false });
  });

  it('按住过一次就不再出现', async () => {
    const c = fakeCache();
    expect(await plusHintThisLaunch(1, asStore(c))).toBe(true);
    await markPlusHeld(2, asStore(c));
    expect(c.m.get(PLUS_HINT_ID)?.data).toEqual({ opens: 1, held: true });
    resetPlusHintForTest();
    expect(await plusHintThisLaunch(3, asStore(c))).toBe(false);
  });

  it('存的数据坏了当 0 次', async () => {
    const c = fakeCache({ id: PLUS_HINT_ID, kind: 'hint', data: { opens: -2, held: 'x' }, updated_at: 0 });
    expect(await plusHintThisLaunch(1, asStore(c))).toBe(true);
    expect(c.m.get(PLUS_HINT_ID)?.data).toEqual({ opens: 1, held: false });
  });

  it('库没开（null）或读写出错：不出气泡、不抛错', async () => {
    expect(await plusHintThisLaunch(1, null)).toBeNull();
    resetPlusHintForTest();
    const bad = {
      getDraft: async () => {
        throw new Error('closing');
      },
      putDraft: async () => undefined,
    };
    expect(await plusHintThisLaunch(1, bad as unknown as Store)).toBeNull();
    await expect(markPlusHeld(1, bad as unknown as Store)).resolves.toBeUndefined();
    await expect(markPlusHeld(1, null)).resolves.toBeUndefined();
  });
});

describe('代码审建议 3（11-10）', () => {
  it('本机库还没准备好：返回 null、不记结果；准备好以后再查就照常算一次', async () => {
    expect(await plusHintThisLaunch(1, null)).toBeNull();
    const c = fakeCache();
    expect(await plusHintThisLaunch(2, asStore(c))).toBe(true);
    expect(c.m.get(PLUS_HINT_ID)?.data).toEqual({ opens: 1, held: false });
  });

  it('读写出错：返回 null（这次不出）、不记结果，下次再查（复审 R1）', async () => {
    let fail = true;
    const c = fakeCache();
    const flaky = {
      getDraft: async (id: string) => {
        if (fail) throw new Error('closing');
        return c.getDraft(id);
      },
      putDraft: c.putDraft,
    };
    expect(await plusHintThisLaunch(1, flaky as unknown as Store)).toBeNull();
    fail = false;
    expect(await plusHintThisLaunch(2, flaky as unknown as Store)).toBe(true);
  });

  it('按住过一次：当场通知（气泡收起），这次启动再查也是不出', async () => {
    const c = fakeCache();
    expect(await plusHintThisLaunch(1, asStore(c))).toBe(true);
    const seen = vi.fn();
    const off = watchPlusHeld(seen);
    const p = markPlusHeld(2, asStore(c));
    // 不等写库，调用当下就通知
    expect(seen).toHaveBeenCalledTimes(1);
    expect(plusHeldNow()).toBe(true);
    await p;
    expect(await plusHintThisLaunch(3, asStore(c))).toBe(false);
    // 再按一次不重复通知
    await markPlusHeld(4, asStore(c));
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});

