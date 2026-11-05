// 首屏依赖图的帮手（从 first-paint-graph.test.ts 抽出，11-05：那个文件超过 300 行）：从入口只沿静态 import / export … from 走，
// 不起子进程；first-paint-graph.test.ts（zod、清单、玻璃、时区词典）和 first-paint-k8.test.ts（K8）共用
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const ENTRY = resolve(ROOT, 'src/app/main.tsx');

/** 推依赖图的用例的超时（L-e：缓存以后单跑约 0.7 秒；满载时留足余量，真卡死也能在 20 秒内发现） */
export const GRAPH_TIMEOUT_MS = 20_000;

export const rel = (f: string): string => relative(ROOT, f).replaceAll('\\', '/');

/** 去掉注释（字符串里的 // 很少见；误删只会多报“找不到文件”，不会漏边） */
export const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** 静态的 import / export … from / 副作用 import 的说明符；整句 import type、或花括号里全是 type 的不算 */
export function staticSpecs(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^'";]*?\s*from\s*)?['"]([^'"]+)['"]/g;
  for (const m of strip(src).matchAll(re)) {
    if (m[2]) continue;
    const clause = (m[3] ?? '').replace(/\s*from\s*$/, '').trim();
    if (m[1] === 'export' && !clause) continue;
    const braces = /^\{([^}]*)\}$/.exec(clause);
    if (braces) {
      const names = (braces[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(m[4] ?? '');
  }
  return out;
}

export type Read = (file: string) => string;

// 第四轮审查 L-e：这些用例反复从入口推依赖图，同一个文件会被读、解析很多遍，机器满载时超过 5 秒。
// 源码读一次缓存起来（测试期间不改文件；模拟变异走 withPatch，只换被改的那一个），解析结果按内容缓存
const fileCache = new Map<string, string>();
export const readCached: Read = (f) => {
  let src = fileCache.get(f);
  if (src === undefined) {
    src = readFileSync(f, 'utf8');
    fileCache.set(f, src);
  }
  return src;
};
const specCache = new Map<string, string[]>();
const specsOf = (src: string): string[] => {
  let out = specCache.get(src);
  if (!out) {
    out = staticSpecs(src);
    specCache.set(src, out);
  }
  return out;
};

/** 从 entry 出发静态可达的东西：文件（绝对路径）和包（pkg:名字）；prev 用来还原路径 */
export function reach(entry: string, read: Read = readCached): { prev: Map<string, string | null>; missing: string[] } {
  const prev = new Map<string, string | null>([[entry, null]]);
  const missing: string[] = [];
  const q = [entry];
  while (q.length) {
    const f = q.shift() as string;
    if (f.startsWith('pkg:') || !/\.(ts|tsx|mjs|js)$/.test(f)) continue;
    for (const spec of specsOf(read(f))) {
      const clean = spec.split('?')[0] ?? spec;
      let to: string;
      if (clean.startsWith('.')) {
        to = resolve(dirname(f), clean);
        if (!existsSync(to)) {
          missing.push(`${rel(f)} → ${spec}`);
          continue;
        }
      } else to = `pkg:${clean}`;
      if (!prev.has(to)) {
        prev.set(to, f);
        q.push(to);
      }
    }
  }
  return { prev, missing };
}

export const show = (n: string): string => (n.startsWith('pkg:') ? n : rel(n));

/** 首屏不许到的 */
export function forbidden(n: string): boolean {
  const s = show(n);
  return s === 'pkg:zod' || s.startsWith('pkg:zod/') || s === 'src/platform/zod-jitless.ts' || s.startsWith('shared/schema/') || s.startsWith('shared/manifests/');
}

/** 走到了不许到的模块：每个给一条从入口过来的路径 */
export function violations(entry: string, read?: Read): string[] {
  const { prev } = reach(entry, read);
  return [...prev.keys()].filter(forbidden).map((h) => {
    const path: string[] = [];
    for (let n: string | null | undefined = h; n; n = prev.get(n)) path.unshift(show(n));
    return path.join(' → ');
  });
}

/** 在真文件上加一行（模拟变异），别的照读 */
export const withPatch = (file: string, patch: (src: string) => string): Read => (f) => {
  const src = readCached(f);
  return f === resolve(ROOT, file) ? patch(src) : src;
};
