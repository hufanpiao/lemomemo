// 本机库的名字、owner 和 pending_actions 的键、通知按键的类型和推迟上限只在 shared/local-db.ts 定义一处（第三方审查后端-5）
// 原来 sw/pending.ts、platform/exit-basics.ts、core/pending-actions.ts、sw/push-actions.ts 各写一份，靠 sw-pending.test.ts 逐项核对两边一致；
// 现在 SW 和页面都从 shared 引，这里钉住：别处不准再写这些值的定义
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOME = 'shared/local-db.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n).replace(/\\/g, '/');
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(n) && !n.endsWith('.d.ts') ? [p] : [];
  });
}

/** 去掉整行注释（// 开头、块注释里的 * 行）：注释里提到库名不算定义 */
const codeLines = (p: string): string[] =>
  readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

/** 每种定义的写法 */
const DEFS: [string, RegExp][] = [
  ['库名', /['"]planner-v4['"]/],
  ['owner 仓名', /=\s*['"]owner['"]/],
  ['owner 的键', /OWNER_KEY\s*=\s*['"]/],
  ['pending_actions 仓名', /=\s*['"]pending_actions['"]/],
  ['推迟上限', /SNOOZE_MAX_MIN\s*=/],
  ['推迟按键类型', /interface\s+(SnoozeAction|PendingSnooze)\b/],
  ['完成按键类型', /interface\s+(DoneAction|PendingDone)\b/],
  ['SW 写的记录类型', /interface\s+SwPendingAction\b/],
];

describe('SW 和页面共用的本机库常量只在 shared/local-db.ts 定义（后端-5）', () => {
  it('每一样只在 shared/local-db.ts 出现一次定义', () => {
    const files = [...sources('src'), ...sources('shared')].map((p) => ({ p, lines: codeLines(p) }));
    for (const [what, re] of DEFS) {
      const hits = files.flatMap(({ p, lines }) => lines.filter((l) => re.test(l)).map(() => p));
      expect(hits, what).toEqual([HOME]);
    }
  }, 30_000);

  it('SW（src/sw/pending.ts、push-actions.ts）和页面（platform/exit-basics.ts、core/pending-actions.ts）都从 shared 引', () => {
    for (const p of ['src/sw/pending.ts', 'src/sw/push-actions.ts', 'src/platform/exit-basics.ts', 'src/core/pending-actions.ts']) {
      expect(readFileSync(p, 'utf8'), p).toMatch(/from '\.\.\/\.\.\/shared\/local-db\.ts'/);
    }
  });

  it('shared/local-db.ts 不 import 任何东西（SW 包和首屏都引它，不能带进别的代码）', () => {
    expect(codeLines(HOME).join('\n')).not.toMatch(/\bimport\b|\bfrom\s*['"]|\brequire\s*\(/);
  });
});
