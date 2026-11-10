// R-371 非正式版冷启动诊断统一入口（platform/vh-diag-boot.ts，11-10 代码审建议 2）：main.tsx 两个开关一次判断、只留一处动态加载；
// 入口按开关分别启动时间线、Gap fix，只跑开着的那个
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startVhDiag } from '../vh-diag-boot.ts';
import { ON_KEY, readGapFixLog } from '../vh-gapfix.ts';
import { ARM_KEY, OUT_KEY as TL_OUT_KEY } from '../vh-timeline.ts';

/** 只收不跑的“帧”：只看启动那一刻做了什么 */
const frames = () => ({ frame: (_cb: () => void): void => undefined });
const mountBar = (): void => {
  const el = document.createElement('nav');
  el.dataset['testid'] = 'tabbar';
  document.body.append(el);
};

beforeEach(() => localStorage.clear());
afterEach(() => document.body.replaceChildren());
describe('统一入口 startVhDiag（代码审建议 2）', () => {
  it('只跑开着的那个：只开 Gap fix 不记时间线；只开时间线不跑 Gap fix；都开都跑', () => {
    mountBar();
    localStorage.setItem(ON_KEY, '1');
    startVhDiag(frames().frame);
    expect(readGapFixLog()).toMatch(/^gapfix start=/);
    expect(localStorage.getItem(TL_OUT_KEY)).toBeNull();
    localStorage.clear();
    localStorage.setItem(ARM_KEY, '1');
    startVhDiag(frames().frame);
    expect(readGapFixLog()).toBe('');
    expect(localStorage.getItem(ARM_KEY)).toBeNull();
    localStorage.clear();
    localStorage.setItem(ARM_KEY, '1');
    localStorage.setItem(ON_KEY, '1');
    startVhDiag(frames().frame);
    expect(readGapFixLog()).toMatch(/^gapfix start=/);
    expect(localStorage.getItem(ARM_KEY)).toBeNull();
  });

  it('main.tsx 两个开关一次判断、只留一处动态加载（统一入口）', () => {
    const main = readFileSync(resolve(__dirname, '../../app/main.tsx'), 'utf8');
    expect(main).toContain(`localStorage.getItem('${ARM_KEY}') || localStorage.getItem('${ON_KEY}')`);
    expect(main).toContain("import('../platform/vh-diag-boot.ts')");
    expect(main).not.toContain("import('../platform/vh-gapfix.ts')");
    expect(main).not.toContain("import('../platform/vh-timeline.ts')");
  });
});
