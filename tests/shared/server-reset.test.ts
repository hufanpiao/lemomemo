// shared/logic/server-reset.ts 的 mergeWithServerResets 和真库触发器逐条一致（REMIND-shown-persist 修订 1 第 3 节 ③、复审 L6～L8，11-05）。
// 向量读自 supabase/tests/rls/38_server_reset_parity.test.sql（那边在真库、离线库里跑同一批期望）；替身一半在 tests/edge/push-dispatch-mem-reset.test.ts。
// Node（vitest）和 Deno（deno task test）各跑一遍：只用 toBe、toEqual
import { describe, expect, it } from 'vitest';
import { mergeWithServerResets, occurrenceChanged } from '../../shared/logic/server-reset.ts';
import { fmtReset, loadResetVectors } from './server-reset-vectors.ts';

const { vectors, plan } = loadResetVectors();

describe('清系统列：纯函数和 rls/38 的真库期望一致', () => {
  it('向量全读到了（条数等于 rls/38 的 plan，不少于 20 条）', () => {
    expect(vectors.length).toBe(plan);
    expect(vectors.length >= 20).toBe(true);
  });
  it('逐条一致', () => {
    for (const v of vectors) expect(fmtReset(v.table, mergeWithServerResets(v.table, v.old, v.applied)), v.name).toBe(v.want);
  });
});

describe('清系统列：输入输出约定', () => {
  it('不改入参；old 为空（新建）只合并；不是提醒表的只合并', () => {
    const old = { date: '2026-11-05', remind_days: 0, pushed_for: 1, notified_for: 1, remind_at: 1 };
    const applied = { date: '2026-11-06' };
    const out = mergeWithServerResets('events', old, applied);
    expect(out).toEqual({ date: '2026-11-06', remind_days: 0, pushed_for: null, notified_for: null, snooze_at: null, defer_until: null, remind_at: 1 });
    expect(old).toEqual({ date: '2026-11-05', remind_days: 0, pushed_for: 1, notified_for: 1, remind_at: 1 });
    expect(applied).toEqual({ date: '2026-11-06' });
    expect(mergeWithServerResets('events', null, { date: '2026-11-06', pushed_for: 1 })).toEqual({ date: '2026-11-06', pushed_for: 1 });
    expect(mergeWithServerResets('notes', { date: 'a', pushed_for: 1 }, { date: 'b' })).toEqual({ date: 'b', pushed_for: 1 });
  });
  it('L7：forked 时传 appliedColumns 的结果，只看实际落库的列——同一个 sent.data，只落了标题就不清', () => {
    const server = { date: '2026-11-05', remind_days: 0, pushed_for: 1000, defer_until: 900, remind_at: 1000 };
    const sentData = { date: '2026-11-06', title: '改名' };
    const appliedForked = { title: '改名' };   // 服务器那边日期被别的设备改过，冲突列不落库
    expect(mergeWithServerResets('events', server, appliedForked)['pushed_for']).toBe(1000);
    expect(mergeWithServerResets('events', server, sentData)['pushed_for']).toBe(null);
  });
  it('补丁里值为 undefined 的键当作没带', () => {
    const out = mergeWithServerResets('events', { date: '2026-11-05', remind_days: 0, pushed_for: 1 }, { date: undefined });
    expect(out['pushed_for']).toBe(1);
    expect(out['date']).toBe('2026-11-05');
  });
  it('occurrenceChanged：time 只看空与非空', () => {
    expect(occurrenceChanged({ date: 'a', remind_days: 0, time: '09:00' }, { date: 'a', remind_days: 0, time: '10:00' })).toBe(false);
    expect(occurrenceChanged({ date: 'a', remind_days: 0, time: '09:00' }, { date: 'a', remind_days: 0, time: null })).toBe(true);
    expect(occurrenceChanged({ date: 'a', remind_days: 0 }, { date: 'a', remind_days: 0, time: null })).toBe(false);
  });
});
