// shared/logic/project-examples.ts（R-497“学我以前怎么分的”）挑哪几条当例子，shared/schema/ai.ts 的 normExamples 怎么规整请求里的例子
import { describe, expect, it } from 'vitest';
import { PER_PROJECT, projectExamples } from '../../shared/logic/project-examples.ts';
import { AI_EXAMPLE_TITLE_LEN, AI_EXAMPLES_MAX, normExamples } from '../../shared/schema/ai.ts';

// updated_at 和库里一样是毫秒数（shared/schema/rows.ts 的 epochMs）
const T0 = Date.UTC(2026, 10, 27);
const row = (title: string, project: string, at: number, o: Record<string, unknown> = {}) => ({ id: `${title}-${at}`, title, project, updated_at: at, ...o });

describe('projectExamples', () => {
  it('只收自建项目：固定类别（中韩两套）、没分类的不收；删掉的、撤销的不收', () => {
    const todos = [
      row('跑步', '健身', T0 + 1),
      row('交报告', '工作', T0 + 2),
      row('영수증', '생활', T0 + 3),
      row('买菜', '', T0 + 4),
      row('瑜伽', '健身', T0 + 5, { deleted_at: 1 }),
      row('拉伸', '健身', T0 + 6, { undone: true }),
    ];
    expect(projectExamples([todos])).toEqual([{ title: '跑步', project: '健身' }]);
  });
  it('待办、日程一起挑，最近改过的在前（按毫秒数比，不按哪张表在前）；同一个标题只留最新那条', () => {
    const todos = [row('跑步', '健身', T0 - 7 * 86400000), row('给张总回邮件', 'NEOX', T0 - 86400000)];
    const events = [row('跑步', '晨练', T0 - 2 * 86400000), row('羽毛球', '健身', T0)];
    expect(projectExamples([todos, events])).toEqual([
      { title: '羽毛球', project: '健身' },
      { title: '给张总回邮件', project: 'NEOX' },
      { title: '跑步', project: '晨练' },
    ]);
  });
  it('每个项目最多 PER_PROJECT 条、一共最多 AI_EXAMPLES_MAX 条；标题截到 AI_EXAMPLE_TITLE_LEN 个字', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`事${i}`, `项目${i % 8}`, T0 - i * 60000));
    const out = projectExamples([rows]);
    expect(out).toHaveLength(AI_EXAMPLES_MAX);
    expect(out[0]).toEqual({ title: '事0', project: '项目0' });
    const per = new Map<string, number>();
    for (const e of out) per.set(e.project, (per.get(e.project) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThan(PER_PROJECT + 1);   // Deno 垫片（deno-vitest-shim.ts）没有 toBeLessThanOrEqual
    expect([...projectExamples([[row('长'.repeat(50), '健身', T0)]])[0]!.title]).toHaveLength(AI_EXAMPLE_TITLE_LEN);
  });
  it('updated_at 缺列或不是数字的排最后，不丢', () => {
    const rows = [{ id: 'a', title: '游泳', project: '健身' }, row('骑车', '健身', Number.NaN), row('跑步', '健身', T0)];
    expect(projectExamples([rows]).map((e) => e.title)).toEqual(['跑步', '游泳', '骑车']);
  });
});

describe('normExamples', () => {
  it('只留标题、项目都是非空字符串的，去空白、截长度，最多 AI_EXAMPLES_MAX 条；不是数组给空', () => {
    expect(normExamples('x')).toEqual([]);
    expect(normExamples([null, 1, { title: 1, project: 'a' }, { title: ' 跑步 ', project: ' 健身 ' }, { title: '', project: 'a' }])).toEqual([{ title: '跑步', project: '健身' }]);
    expect(normExamples(Array.from({ length: 30 }, () => ({ title: 'a', project: 'b' })))).toHaveLength(AI_EXAMPLES_MAX);
    expect([...normExamples([{ title: '长'.repeat(50), project: '项'.repeat(50) }])[0]!.project]).toHaveLength(40);
  });
});
