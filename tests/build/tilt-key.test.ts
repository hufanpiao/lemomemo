// 倾斜高光开关的本机键名（TILT-b2）：设置页写（features/settings/data/local.ts）、底栏读（motion/glass-tilt.ts）。
// motion 不能引 features、features 只能引 motion 的入口文件，两处各写一份常量；这里按源码文字核对两边一样
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const keyIn = (rel: string): string | undefined => /export const TILT_KEY = '([^']+)';/.exec(readFileSync(resolve(ROOT, rel), 'utf8'))?.[1];

describe('倾斜高光开关的键名', () => {
  it('设置页和底栏两处的 TILT_KEY 一样，都不是空的', () => {
    const a = keyIn('src/features/settings/data/local.ts');
    const b = keyIn('src/motion/glass-tilt.ts');
    expect(a).toBe('lemo.tilt');
    expect(b).toBe(a);
  });
});
