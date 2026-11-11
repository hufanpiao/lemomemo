// shared/logic/live-row.ts：一行还在不在（isLiveRow）、分类还活着没有（isLiveCategory）。前端各页和 ai-classify 共用这一份。
import { describe, expect, it } from 'vitest';
import { isLiveCategory, isLiveRow } from '../../shared/logic/live-row.ts';

describe('isLiveRow', () => {
  it('没有 deleted_at、deleted_at 为 undefined 或 null 都算还在；undone 为 true 算撤销', () => {
    expect(isLiveRow({})).toBe(true);
    expect(isLiveRow({ deleted_at: undefined, undone: undefined })).toBe(true);
    expect(isLiveRow({ deleted_at: null, undone: false })).toBe(true);
    expect(isLiveRow({ deleted_at: 0 })).toBe(false);
    expect(isLiveRow({ deleted_at: 5, undone: false })).toBe(false);
    expect(isLiveRow({ deleted_at: null, undone: true })).toBe(false);
  });
  it('deleted_at、undone 各种取值（含没有这一列、类型不对的怪值）都和“deleted_at 为 null 或没有、undone 不是 true”一致', () => {
    // 原来今天页、待办页各有一份对照（src/features/{today,todos}/__tests__/live-row.test.ts，11-12 随 isLive 包装一起删），并到这里
    const VALUES: unknown[] = [undefined, null, 0, 1, 1700000000000, -1, '', '0', 'x', true, false, NaN, {}, []];
    for (const d of VALUES) {
      for (const u of VALUES) {
        const r: Record<string, unknown> = {};
        if (d !== undefined) r['deleted_at'] = d;
        if (u !== undefined) r['undone'] = u;
        expect(isLiveRow(r), JSON.stringify(r)).toBe((d === null || d === undefined) && u !== true);
      }
    }
  });
});

describe('isLiveCategory', () => {
  it('还在、没合并进别的分类才算活着；删了的、撤销的、合并掉的都不算', () => {
    expect(isLiveCategory({})).toBe(true);
    expect(isLiveCategory({ deleted_at: null, undone: false, merged_into: null })).toBe(true);
    expect(isLiveCategory({ deleted_at: 1, merged_into: null })).toBe(false);
    expect(isLiveCategory({ deleted_at: null, undone: true, merged_into: null })).toBe(false);
    expect(isLiveCategory({ deleted_at: null, undone: false, merged_into: 'a' })).toBe(false);
  });
});
