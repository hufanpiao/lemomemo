// settings 一行的 patch 内容（A31；B2 安全审查 FA3-2：恢复写法只在 core/setting-patch.ts 一处）
import { describe, expect, it } from 'vitest';
import { settingPatch } from '../setting-patch.ts';

describe('settingPatch', () => {
  it('值一样、没删没撤销：不写（null）', () => {
    expect(settingPatch({ value: 'cn', deleted_at: null, undone: false }, 'cn')).toBeNull();
  });

  it('值不一样：只写 value', () => {
    expect(settingPatch({ value: 'cn', deleted_at: null, undone: false }, 'kr')).toEqual({ value: 'kr' });
  });

  it('被软删过：顺带把 deleted_at 改回 null（值一样也写）', () => {
    expect(settingPatch({ value: 'cn', deleted_at: 5, undone: false }, 'cn')).toEqual({ value: 'cn', deleted_at: null });
  });

  it('被撤销过：顺带把 undone 改回 false', () => {
    expect(settingPatch({ value: 1, deleted_at: null, undone: true }, 0)).toEqual({ value: 0, undone: false });
  });

  it('只会写这两个“恢复”值，不会写成删除', () => {
    const d = settingPatch({ value: 1, deleted_at: '2026-11-01', undone: true }, 1) ?? {};
    expect(d).toEqual({ value: 1, deleted_at: null, undone: false });
  });
});
