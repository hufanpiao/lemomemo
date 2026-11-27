// 吉祥物静态图（Rive 第一帧，build/gen_mascot_stills.mjs 出）：和 .riv、舞台画布大小、目录里的 still 对得上。
// 换了 .riv、改了角色框或裁切没重出静态图，这里报错（静态图对不上，换成 Rive 那一帧会跳）
import { describe, expect, it } from 'vitest';
import { check, NO_STILL } from '../../../../build/gen_mascot_stills.mjs';
import { MASCOTS } from '../data/catalog.ts';
import { PRIVATE_DEF } from '../data/mascot-private.ts';

describe('吉祥物静态图', () => {
  it('stills.json、图片、.riv、目录里的 still 都对得上', () => {
    expect((check as () => string[])()).toEqual([]);
  });

  it('#2 不放静态图（同人作品，图也不进仓库）；NO_STILL 的不放', () => {
    expect(PRIVATE_DEF.still).toBeUndefined();
    for (const id of NO_STILL as string[]) expect(MASCOTS[id as keyof typeof MASCOTS].still).toBeUndefined();
  });
});
