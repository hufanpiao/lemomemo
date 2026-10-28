// D1 的“/files 规则表和清单一致”（build/d1/files-rules.ts；架构 0.32 第 9 条，BE-4，TC-B0-118 第三份样例）
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import { checkFilesRules, filesRulesFacts, GENERATED_HEADER } from '../../build/d1/files-rules.ts';

describe('/files 规则表和清单一致（build/d1/files-rules.ts）', () => {
  const facts = filesRulesFacts(allManifests);
  const sample = [`// ${GENERATED_HEADER}`, ...facts.map((f) => f.forms[0] ?? '')].join('\n');

  it('要核对的内容：images 两段、files 一段的 pathPattern，两个上限，类型', () => {
    const what = facts.map((f) => f.what);
    expect(what.filter((w) => w.includes('pathPattern'))).toHaveLength(3);
    expect(what).toContain('images 的大小上限 2097152');
    expect(what).toContain('files 的大小上限 10485760');
    expect(what.filter((w) => w.startsWith('files 的类型'))).toHaveLength(11);
    expect(what.some((w) => w.startsWith('vault-'))).toBe(false);   // vault-* 不进 /files 的规则表
  });

  it('按清单写的规则表通过；正则用 JSON 转义、正则字面量的写法也认', () => {
    expect(checkFilesRules({ generated: sample, functionExists: true }, allManifests).problems).toEqual([]);
    for (const k of [1, 2]) {
      const other = [`// ${GENERATED_HEADER}`, ...facts.map((f) => f.forms[k] ?? f.forms[0] ?? '')].join('\n');
      expect(checkFilesRules({ generated: other, functionExists: true }, allManifests).problems).toEqual([]);
    }
  });

  it('手改一个字：失败并报出是哪一项', () => {
    const p = checkFilesRules({ generated: sample.replace('pptx|docm', 'pptx|dccm'), functionExists: true }, allManifests).problems;
    expect(p.some((x) => x.includes('files 的 pathPattern'))).toBe(true);
    expect(checkFilesRules({ generated: sample.replace('10485760', '10485761'), functionExists: true }, allManifests).problems)
      .toContain('functions/_generated/files-rules.ts 和清单不一致：找不到 files 的大小上限 10485760');
  });

  it('没有“自动生成，不要手改”的文件头：失败', () => {
    expect(checkFilesRules({ generated: sample.replace(GENERATED_HEADER, ''), functionExists: true }, allManifests).problems[0]).toContain('文件头');
  });

  it('有生成器时逐字比：差一个空格也失败；一样就通过', () => {
    expect(checkFilesRules({ generated: sample, functionExists: true, render: () => sample }, allManifests)).toEqual({ problems: [], notes: [] });
    expect(checkFilesRules({ generated: sample, functionExists: true, render: () => `${sample} ` }, allManifests).problems[0]).toContain('重新生成');
  });

  it('规则表不在：/files 函数在就失败，函数也不在只记说明', () => {
    expect(checkFilesRules({ generated: null, functionExists: true }, allManifests).problems).toHaveLength(1);
    const r = checkFilesRules({ generated: null, functionExists: false }, allManifests);
    expect(r.problems).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });
});
