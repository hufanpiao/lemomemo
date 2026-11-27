// FA-6 ③：首屏用的 SCHEMA_V 副本（core/schema-version.ts，不带 zod）必须等于 shared/schema/rows.ts 的正本
import { describe, expect, it } from 'vitest';
import { SCHEMA_V as source } from '../../../shared/schema/rows.ts';
import { SCHEMA_V as copy } from '../schema-version.ts';

describe('SCHEMA_V 副本', () => {
  it('和 shared/schema/rows.ts 一致（rows.ts 加 1 时这里一起改）', () => {
    expect(copy).toBe(source);
  });
});
