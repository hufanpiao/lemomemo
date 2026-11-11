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
