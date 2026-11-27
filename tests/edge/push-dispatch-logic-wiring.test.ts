// push-dispatch 的 logic 接线（代码审查《全天日程提醒-服务器》L1，11-04）：业务分支只在 logic.ts 的 makeLogic 里写一遍，
// 测试经替身执行的就是它；index.ts（真正部署的那份）和替身 push-dispatch-mem.ts 只各列一遍 shared 函数名。
// 这里按源码核对两份名单：名字、顺序、个数和 logic.ts 的 SharedFns 一致；每个名字在 index.ts 里从 ../_shared/gen/<模块> 引、
// 在替身里从 ../../shared/<模块> 引，<模块> 相同（gen 是 shared 的副本，copy_shared 生成）。index.ts 抄错、漏传、换成别的函数都会失败。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const INDEX = read('../../supabase/functions/push-dispatch/index.ts');
const MEM = read('./push-dispatch-mem.ts');
const LOGIC_SRC = read('../../supabase/functions/push-dispatch/logic.ts');

/** makeLogic({ a, b, c }) 里的名字（只认简写属性：值就是同名导入） */
function wired(src: string): string[] {
  const m = /makeLogic\(\{([^}]*)\}\)/.exec(src);
  if (!m) throw new Error('找不到 makeLogic({ … })');
  return (m[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
/** 名字 → 它从哪个模块引（import { … } from '…'） */
function importsOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^import \{([^}]*)\} from '([^']+)';$/gm)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '');
      if (name) out.set(name, m[2] ?? '');
    }
  }
  return out;
}

describe('push-dispatch 的 logic 接线：index.ts 和测试替身是同一份', () => {
  it('两边的名单一样，并且正好是 SharedFns 的全部键（不多不少）', () => {
    const keys = [...(/export interface SharedFns \{([\s\S]*?)\n\}/.exec(LOGIC_SRC)?.[1] ?? '').matchAll(/^\s+(\w+)[(:]/gm)].map((m) => m[1]);   // 函数写成 name(…)，常量 REMIND_RULES_VER 写成 name: 类型
    expect(keys.length).toBeGreaterThan(5);
    expect(wired(INDEX)).toEqual(wired(MEM));
    expect([...wired(INDEX)].sort()).toEqual([...keys].sort());
  });
  it('每个名字：index.ts 从 ../_shared/gen/<模块> 引，替身从 ../../shared/<模块> 引，<模块> 相同', () => {
    const gi = importsOf(INDEX);
    const mi = importsOf(MEM);
    for (const name of wired(INDEX)) {
      const g = gi.get(name);
      const m = mi.get(name);
      expect(g, `index.ts 没有导入 ${name}`).toMatch(/^\.\.\/_shared\/gen\//);
      expect(m, `替身没有导入 ${name}`).toMatch(/^\.\.\/\.\.\/shared\//);
      expect(g?.replace('../_shared/gen/', ''), name).toBe(m?.replace('../../shared/', ''));
    }
  });
  it('index.ts 里不再自己写分支（LOGIC 只经 makeLogic 生成）', () => {
    expect(INDEX).toMatch(/export const LOGIC: RoundLogic = makeLogic\(\{/);
    expect(INDEX).not.toMatch(/remindAtOf\s*:/);
    expect(INDEX).not.toMatch(/eventStartAt\s*:/);
  });
});
