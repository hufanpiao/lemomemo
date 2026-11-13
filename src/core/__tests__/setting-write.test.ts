// core/setting-write.ts（REMIND-settings-core、FA-4 代码审查 L7）：提醒和日历共用的 settings 读写
// • settingValue：只认活着的那一行；settingWrite：insert / patch / 值一样不写 / 对象按 JSON 比 / 顺带恢复
// • createSettingWriter：排队按顺序写；刚 insert 还没进本机集合时按记下的 id patch、不再 insert；结果交给 onResult，save / update 也回写没写成
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let okNext = true;
const insert = vi.fn(async (_t: string, data: Record<string, unknown>) => {
  calls.push(`insert:${String(data['key'])}`);
  return { ok: okNext };
});
const patch = vi.fn(async (_t: string, id: string, _d: Record<string, unknown>) => {
  calls.push(`patch:${id}`);
  return { ok: okNext };
});
vi.mock('../write.ts', () => ({ write: { insert: (...a: Parameters<typeof insert>) => insert(...a), patch: (...a: Parameters<typeof patch>) => patch(...a) } }));

const { createSettingWriter, settingValue, settingWrite } = await import('../setting-write.ts');
type Row = { id: string; key?: unknown; value?: unknown; deleted_at?: unknown; undone?: unknown };

beforeEach(() => {
  calls.length = 0;
  okNext = true;
  insert.mockClear();
  patch.mockClear();
});

describe('settingValue', () => {
  it('只认活着的那一行；没有、被删、被撤销都是 undefined', () => {
    expect(settingValue([{ id: 'a', key: 'k', value: 1, deleted_at: null, undone: false }], 'k')).toBe(1);
    expect(settingValue([{ id: 'a', key: 'k', value: 1, deleted_at: 5 }], 'k')).toBeUndefined();
    expect(settingValue([{ id: 'a', key: 'k', value: 1, undone: true }], 'k')).toBeUndefined();
    expect(settingValue([{ id: 'a', key: 'k', value: 1, deleted_at: 5 }, { id: 'b', key: 'k', value: 2 }], 'k')).toBe(2);
    expect(settingValue([], 'k')).toBeUndefined();
  });
});

describe('settingWrite', () => {
  it('没有这一行 insert；有就 patch；值一样不写', () => {
    expect(settingWrite([], 'k', 'x')).toEqual({ op: 'insert', data: { key: 'k', value: 'x' } });
    expect(settingWrite([{ id: 'a', key: 'k', value: 'x' }], 'k', 'x')).toBeNull();
    expect(settingWrite([{ id: 'a', key: 'k', value: 'x' }], 'k', 'y')).toEqual({ op: 'patch', id: 'a', data: { value: 'y' } });
  });
  it('对象值按 JSON 比：一样不写，不一样 patch', () => {
    const rows: Row[] = [{ id: 'a', key: 'k', value: { start: '23:00', end: '08:00' } }];
    expect(settingWrite(rows, 'k', { start: '23:00', end: '08:00' })).toBeNull();
    expect(settingWrite(rows, 'k', { start: '22:00', end: '08:00' })).toEqual({ op: 'patch', id: 'a', data: { value: { start: '22:00', end: '08:00' } } });
  });
  it('被删、被撤销过的：patch 时顺带恢复（settingPatch）；对象值一样也要恢复', () => {
    expect(settingWrite([{ id: 'a', key: 'k', value: 'x', deleted_at: 9 }], 'k', 'x')).toEqual({ op: 'patch', id: 'a', data: { value: 'x', deleted_at: null } });
    expect(settingWrite([{ id: 'a', key: 'k', value: 'x', undone: true }], 'k', 'y')).toEqual({ op: 'patch', id: 'a', data: { value: 'y', undone: false } });
    const obj = { start: '23:00', end: '08:00' };
    expect(settingWrite([{ id: 'a', key: 'k', value: obj, deleted_at: 9 }], 'k', obj)).toEqual({ op: 'patch', id: 'a', data: { value: obj, deleted_at: null } });
  });
});

describe('createSettingWriter', () => {
  const make = (rows: Row[] = []) => {
    const results: boolean[] = [];
    let n = 0;
    const w = createSettingWriter({ rows: () => rows, newId: () => `new${++n}`, onResult: (ok) => results.push(ok) });
    return { w, results };
  };

  it('连点：刚 insert 的行还没进本机集合，第二下按记下的 id patch，不再 insert；值一样（按 JSON 比）不写', async () => {
    const { w, results } = make();
    await Promise.all([w.save('k', 'a'), w.save('k', 'b'), w.save('k', 'b')]);
    expect(calls).toEqual(['insert:k', 'patch:new1']);
    expect(patch).toHaveBeenCalledWith('settings', 'new1', { value: 'b' });
    expect(results).toEqual([true, true]);
    await w.save('o', { x: 1 });
    await w.save('o', { x: 1 });
    expect(calls).toEqual(['insert:k', 'patch:new1', 'insert:o']);
  });

  it('本机集合里有这一行：照 settingWrite patch；值一样不写、不回调', async () => {
    const { w, results } = make([{ id: 'a', key: 'k', value: 'x' }]);
    await w.save('k', 'x');
    expect(calls).toEqual([]);
    expect(results).toEqual([]);
    await w.save('k', 'y');
    expect(patch).toHaveBeenCalledWith('settings', 'a', { value: 'y' });
  });

  it('update 连点：本机集合还没跟上，按本页最后写的值算，后一下不盖掉前一下；集合跟上以后按集合里的算', async () => {
    const rows: Row[] = [{ id: 'a', key: 'k', value: ['x'] }];
    const { w } = make(rows);
    const add = (v: string) => (cur: unknown) => [...(Array.isArray(cur) ? cur : []), v];
    await Promise.all([w.update('k', add('p')), w.update('k', add('q'))]);
    expect(patch.mock.calls.map((c) => c[2])).toEqual([{ value: ['x', 'p'] }, { value: ['x', 'p', 'q'] }]);
    rows[0] = { id: 'a', key: 'k', value: ['x', 'p', 'q'] };
    await w.update('k', add('r'));
    expect(patch).toHaveBeenLastCalledWith('settings', 'a', { value: ['x', 'p', 'q', 'r'] });
    // 跟上以后别处改了（别的设备）：按集合里的新值算
    rows[0] = { id: 'a', key: 'k', value: ['z'] };
    await w.update('k', add('s'));
    expect(patch).toHaveBeenLastCalledWith('settings', 'a', { value: ['z', 's'] });
  });

  it('写不进本机：onResult(false)；insert 没成功的不记 id，下一次还是 insert', async () => {
    const { w, results } = make();
    okNext = false;
    await w.save('k', 'a');
    okNext = true;
    await w.save('k', 'b');
    expect(calls).toEqual(['insert:k', 'insert:k']);
    expect(results).toEqual([false, true]);
  });

  it('save / update 回写没写成：写进本机、值没变（不写）回 true，写不进本机回 false', async () => {
    const { w } = make([{ id: 'a', key: 'k', value: 'x' }]);
    expect(await w.save('k', 'x')).toBe(true);
    expect(await w.update('k', () => 'y')).toBe(true);
    okNext = false;
    expect(await w.save('k', 'z')).toBe(false);
    expect(await w.save('n', 'z')).toBe(false);
  });

  it('排队：前一条写抛错不影响后面的', async () => {
    const { w } = make();
    insert.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(w.save('k', 'a')).rejects.toThrow('boom');
    await w.save('j', 'b');
    expect(calls).toEqual(['insert:j']);
  });
});
