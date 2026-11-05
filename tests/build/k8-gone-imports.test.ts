// K8 冲突提示的 core 内部入口只准 core/write-gone.ts 用（代码审查 S2）：
// • core/outbox-gone.ts（resolveGoneImpl）：静态、动态、import type 都只准 write-gone.ts 引；
// • core/outbox.ts 导出的 outboxCtx（每个 outbox 的内部上下文）：只准 write-gone.ts 引。
// 功能层、app 一律经 write-gone 的 resolveGone（方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.3，架构 4.1）。测试文件（__tests__）不管。
// 只读源码，不起子进程；下面先用几段假源码确认匹配规则拦得住
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ALLOWED = 'src/core/write-gone.ts';
const GONE = 'src/core/outbox-gone.ts';
const OUTBOX = 'src/core/outbox.ts';

const rel = (f: string): string => relative(ROOT, f).replaceAll('\\', '/');
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** 一个文件里违规的引用（file 是相对仓库根的路径，用来解析相对说明符） */
export function violations(file: string, src: string): string[] {
  if (file === ALLOWED || file === GONE || file === OUTBOX) return [];
  const code = strip(src);
  const out: string[] = [];
  const target = (spec: string): string | null => (spec.startsWith('.') ? rel(resolve(ROOT, dirname(file), spec)) : null);
  // 任何形式的引用：import … from、export … from、import('…')、import type
  for (const m of code.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    if (target(m[1] ?? '') === GONE) out.push(`引了 outbox-gone.ts：${m[0]}`);
  }
  // 从 outbox.ts 取 outboxCtx：花括号里点名，或 import * as X 之后用 X.outboxCtx
  for (const m of code.matchAll(/(?:import|export)\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (target(m[2] ?? '') !== OUTBOX) continue;
    const clause = m[1] ?? '';
    if (/\boutboxCtx\b/.test(clause)) out.push(`引了 outboxCtx：${m[0]}`);
    const ns = /\*\s*as\s+(\w+)/.exec(clause)?.[1];
    if (ns && new RegExp(`\\b${ns}\\s*\\.\\s*outboxCtx\\b`).test(code)) out.push(`经 ${ns}.outboxCtx 用了 outboxCtx`);
  }
  for (const m of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (target(m[1] ?? '') === OUTBOX && /\boutboxCtx\b/.test(code)) out.push('动态引 outbox.ts 并用了 outboxCtx');
  }
  return out;
}

function walk(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('K8 的 core 内部入口只准 write-gone.ts 引（代码审查 S2）', () => {
  it('匹配规则拦得住：静态、动态、type、export-from 引 outbox-gone；点名、命名空间引 outboxCtx', () => {
    const f = 'src/features/x/data/a.ts';
    expect(violations(f, "import { resolveGoneImpl } from '../../../core/outbox-gone.ts';")).toHaveLength(1);
    expect(violations(f, "const m = await import('../../../core/outbox-gone.ts');")).toHaveLength(1);
    expect(violations(f, "import type { X } from '../../../core/outbox-gone.ts';")).toHaveLength(1);
    expect(violations('src/core/write.ts', "export { resolveGoneImpl } from './outbox-gone.ts';")).toHaveLength(1);
    expect(violations(f, "import { outboxCtx, type Outbox } from '../../../core/outbox.ts';")).toHaveLength(1);
    expect(violations(f, "import * as O from '../../../core/outbox.ts';\nO.outboxCtx.get(o);")).toHaveLength(1);
    expect(violations(f, "const o = await import('../../../core/outbox.ts'); o.outboxCtx;")).toHaveLength(1);
    // 不误报：别的导出、注释里提到、write-gone 自己
    expect(violations(f, "import { createOutbox } from '../../../core/outbox.ts';\n// outboxCtx 见 outbox-gone.ts")).toEqual([]);
    expect(violations(ALLOWED, "import { resolveGoneImpl } from './outbox-gone.ts';\nimport { outboxCtx } from './outbox.ts';")).toEqual([]);
  });

  it('src、shared 里除 write-gone.ts 以外没有文件引 outbox-gone.ts 或 outboxCtx', () => {
    const bad: string[] = [];
    for (const p of [...walk(join(ROOT, 'src'), []), ...walk(join(ROOT, 'shared'), [])]) {
      const file = rel(p);
      for (const v of violations(file, readFileSync(p, 'utf8'))) bad.push(`${file}：${v}`);
    }
    expect(bad).toEqual([]);
  });
});
