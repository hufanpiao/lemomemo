// 函数侧纪念日键名（supabase/functions/_shared/anniv-keys.ts）必须和 shared/logic/anniv/keys.ts 一字不差。
import { describe, expect, it } from 'vitest';
import * as fn from '../../supabase/functions/_shared/anniv-keys';
import * as shared from '../../shared/logic/anniv/keys';

describe('函数侧纪念日键名', () => {
  it('和 shared 一致', () => {
    expect(fn.ANNIV_KEY_OFFSETS).toBe(shared.ANNIV_KEY_OFFSETS);
    expect(fn.ANNIV_KEY_TIME).toBe(shared.ANNIV_KEY_TIME);
  });
});
