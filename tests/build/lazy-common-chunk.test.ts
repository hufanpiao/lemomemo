// lazy-common 分组（vite.config.ts 的 LAZY_COMMON_MODULES；B4b-1 第二轮，主持人选“乙”）的名单守门，只读源码：
// • 名单里的文件都在；
// • 都不在首屏静态闭包里（在的话整块会被拖进首屏）；
// • 它们自己静态引的本仓文件都已经在首屏闭包里（分组关了 includeDependenciesRecursively，引到首屏外的模块会让打开某页时多拖一块进来）；
// • 分组规则只认名单（不是通吃规则）：名单外的同目录文件不匹配
// 首屏文件数的上限另由 build/check_size.mjs 的 BUDGET.firstScreenFiles 在每次构建后核
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLazyCommon, LAZY_COMMON_MODULES } from '../../vite.config.ts';
import { ENTRY, GRAPH_TIMEOUT_MS, reach, rel, ROOT, staticSpecs } from './first-paint-lib.ts';

describe('lazy-common 分组名单', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const first = reach(ENTRY).prev;

  it('名单里的文件都在、都不在首屏闭包里', () => {
    for (const m of LAZY_COMMON_MODULES) {
      const f = resolve(ROOT, m);
      expect(existsSync(f), m).toBe(true);
      expect(first.has(f), `${m} 在首屏闭包里`).toBe(false);
    }
  });

  it('名单里每个模块静态引的本仓文件都已经在首屏闭包里', () => {
    const outside: string[] = [];
    for (const m of LAZY_COMMON_MODULES) {
      const f = resolve(ROOT, m);
      for (const spec of staticSpecs(readFileSync(f, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const to = resolve(dirname(f), spec.split('?')[0] ?? spec);
        if (!first.has(to) && !LAZY_COMMON_MODULES.some((x) => resolve(ROOT, x) === to)) outside.push(`${m} → ${rel(to)}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('分组规则只认名单：名单里的匹配（两种路径分隔符），名单外的不匹配', () => {
    for (const m of LAZY_COMMON_MODULES) {
      expect(isLazyCommon(resolve(ROOT, m)), m).toBe(true);
      expect(isLazyCommon(`D:\\x\\${m.replaceAll('/', '\\')}`), m).toBe(true);
    }
    for (const m of ['src/platform/save-file.test.ts', 'src/platform/files.ts', 'src/kit/hooks/useOnlineX.ts', 'shared/logic/linkify.ts']) expect(isLazyCommon(resolve(ROOT, m)), m).toBe(false);
  });
});
