// R-371 非正式版冷启动诊断入口（platform/vh-diag-boot.ts，11-10 代码审建议 2）：只管时间线；
// Gap fix 11-11 起默认开、正式版也做，main.tsx 按 vh-gapfix-gate.ts 直接加载 vh-gapfix.ts，不经这里
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startVhDiag } from '../vh-diag-boot.ts';
import { readGapFixLog } from '../vh-gapfix.ts';
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
describe('诊断入口 startVhDiag', () => {
  it('时间线开着才记；不跑 Gap fix（Gap fix 不经这里）', () => {
    mountBar();
    startVhDiag(frames().frame);
    expect(localStorage.getItem(TL_OUT_KEY)).toBeNull();
    expect(readGapFixLog()).toBe('');
    localStorage.setItem(ARM_KEY, '1');
    startVhDiag(frames().frame);
    expect(localStorage.getItem(ARM_KEY)).toBeNull();
    expect(readGapFixLog()).toBe('');
  });

  it('main.tsx 只在非正式版、时间线开着时加载本入口；时间线不单独 import()', () => {
    const main = readFileSync(resolve(__dirname, '../../app/main.tsx'), 'utf8');
    const block = main.slice(main.indexOf("import.meta.env.MODE !== 'production'"));
    expect(block).toContain(`if (localStorage.getItem('${ARM_KEY}')) void import('../platform/vh-diag-boot.ts')`);
    expect(main).not.toContain("import('../platform/vh-timeline.ts')");
  });
});
