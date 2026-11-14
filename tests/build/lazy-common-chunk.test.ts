// 懒加载共用组（vite.config.ts 的 LAZY_GROUPS：lazy-common，B4b-1 第二轮主持人选“乙”；lazy-data，11-14 首屏腾空间）的名单守门，只读源码：
// • 名单里的文件都在、一个文件只在一组里；
// • 都不在首屏静态闭包里（在的话整块会被拖进首屏）；
// • 它们自己静态引的本仓文件都已经在首屏闭包里或同一组里（分组关了 includeDependenciesRecursively，引到首屏外、组外的模块会让打开某页时多拖一块进来；
//   引到别的组也不行，那样用这一组的页会把另一组整块带上）；
// • 分组规则只认名单（不是通吃规则）：名单外的同目录文件不匹配
// 首屏文件数的上限另由 build/check_size.mjs 的 BUDGET.firstScreenFiles 在每次构建后核
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAZY_GROUPS, lazyGroupOf } from '../../vite.config.ts';
import { ENTRY, GRAPH_TIMEOUT_MS, reach, rel, ROOT, staticSpecs } from './first-paint-lib.ts';

const groups = Object.entries(LAZY_GROUPS) as [string, readonly string[]][];
const all = groups.flatMap(([name, mods]) => mods.map((m) => ({ name, m })));

describe('懒加载共用组名单', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const first = reach(ENTRY).prev;

  it('名单里的文件都在、不重复、都不在首屏闭包里', () => {
    expect(new Set(all.map((x) => x.m)).size).toBe(all.length);
    for (const { m } of all) {
      const f = resolve(ROOT, m);
      expect(existsSync(f), m).toBe(true);
      expect(first.has(f), `${m} 在首屏闭包里`).toBe(false);
    }
  });

  it('名单里每个模块静态引的本仓文件都已经在首屏闭包里或同一组里', () => {
    const outside: string[] = [];
    for (const [name, mods] of groups) {
      const same = new Set(mods.map((x) => resolve(ROOT, x)));
      for (const m of mods) {
        const f = resolve(ROOT, m);
        for (const spec of staticSpecs(readFileSync(f, 'utf8'))) {
          if (!spec.startsWith('.')) continue;
          const to = resolve(dirname(f), spec.split('?')[0] ?? spec);
          if (!first.has(to) && !same.has(to)) outside.push(`${name}: ${m} → ${rel(to)}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it('分组规则只认名单：名单里的匹配到自己那一组（两种路径分隔符），名单外的不匹配', () => {
    for (const { name, m } of all) {
      expect(lazyGroupOf(resolve(ROOT, m)), m).toBe(name);
      expect(lazyGroupOf(`D:\\x\\${m.replaceAll('/', '\\')}`), m).toBe(name);
    }
    for (const m of ['src/platform/save-file.test.ts', 'src/platform/files.ts', 'src/kit/hooks/useOnlineX.ts', 'shared/logic/linkify.ts', 'src/core/write-gone.ts', 'shared/core/date.test.ts', 'src/core/setting-read.test.ts']) {
      expect(lazyGroupOf(resolve(ROOT, m)), m).toBeUndefined();
    }
  });
});
