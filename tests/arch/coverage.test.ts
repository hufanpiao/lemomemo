// TC-B0-02 的后半（QA D-06）：架构 2.3 规则表里的每一条规则，tests/arch-fixtures/ 里至少有一个违规样例，
// 少一条就报“规则无违规样例”。按规则号核（读架构文档 2.3 的表），不按 ESLint 规则名核——
// 同一个 ESLint 规则 id 下挂了好几条架构规则，删掉其中一条的全部样例，按规则名核是发现不了的（QA 改坏抽查 10）
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixtures, ROOT } from './fixture-header.ts';

/** 架构 2.3 的规则号：表格每行第一格（“A1 / A8”算 A1 一条，A8 在同一格里一起管）；
 *  规则号后可带括号说明，如 `| **A28**（0.33） |`、`| **A29**（0.33，UI-4 L-4，B1） |`（代码审查第二轮低 7） */
export function rulesOfArch2_3(doc: string): string[] {
  const start = doc.indexOf('### 2.3 ');
  const end = doc.indexOf('\n### ', start + 1);
  if (start < 0 || end < 0) throw new Error('架构文档里找不到 2.3 节');
  const ids: string[] = [];
  for (const line of doc.slice(start, end).split('\n')) {
    const m = /^\|\s*(?:\*\*)?([A-Z]\d+)(?:\s*\/\s*[A-Z]\d+)?(?:\*\*)?\s*(?:[（(][^）)|]*[）)])?\s*\|/.exec(line);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

/** 每条规则的违规样例在哪：各目录的样例文件头 rule=、check_arch 的样例目录名前缀、D1 的 .psql、W3 的构建目录 */
export function violationSamples(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (rule: string, where: string) => out.set(rule, [...(out.get(rule) ?? []), where]);
  for (const sub of ['eslint', 'stylelint', 'tsc']) {
    for (const f of loadFixtures(sub)) if (f.expect.length > 0 && f.rule) add(f.rule, `${sub}/${f.file}`);
  }
  // check_arch：每个样例是一棵迷你仓库，目录名以规则号开头（a14-env、w2-missing…）；以 -ok 结尾的是对照组
  for (const d of readdirSync(join(FIXTURES, 'check_arch'))) {
    if (d.endsWith('-ok')) continue;
    const id = /^([a-z]\d+)-/.exec(d)?.[1];
    if (id) add(id.toUpperCase(), `check_arch/${d}`);
  }
  // check_backend：A28 是 F1～F3 三项（架构 2.3 A28 ①②③）；F4、F5、F6、M1～M6 同一脚本另查、不另编 A 号，不映射
  for (const d of readdirSync(join(FIXTURES, 'check_backend'))) if (/^f[1-3]-/.test(d)) add('A28', `check_backend/${d}`);
  for (const f of readdirSync(join(ROOT, 'supabase', 'tests', 'd1-fixtures'))) if (f.endsWith('.psql')) add('D1', `d1-fixtures/${f}`);
  for (const d of readdirSync(join(FIXTURES, 'check_size'))) if (d.startsWith('w3-')) add('W3', `check_size/${d}`);
  return out;
}

/** “B1 落地”待办：规则表里已登记、标明 B1 才落地的规则，B0 暂不要求违规样例（落地时从这里删掉） */
export const B1_PENDING: readonly string[] = [
];

describe('架构 2.3：每条规则都有违规样例（按规则号核）', () => {
  const doc = readFileSync(join(ROOT, 'docs', '10-架构', '架构设计-v4.md'), 'utf8');
  const rules = rulesOfArch2_3(doc);

  it('规则表读出来是完整的（防止表格格式一变就什么都不核）', () => {
    for (const r of ['A1', 'A2', 'A11', 'A12', 'A13', 'A14', 'A15', 'A18', 'A19', 'A20', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A28', 'A29', 'D1', 'T1', 'T2', 'T3', 'W1', 'W2', 'W3']) {
      expect(rules).toContain(r);
    }
  });

  it('每条规则至少一个违规样例，缺了报“规则无违规样例”', () => {
    const samples = violationSamples();
    const missing = rules.filter((r) => !B1_PENDING.includes(r) && (samples.get(r) ?? []).length === 0).map((r) => `${r}：规则无违规样例`);
    expect(missing).toEqual([]);
  });

  it('“B1 落地”待办名单里的规则都还在规则表里（删了规则要同步删名单）', () => {
    expect(B1_PENDING.filter((r) => !rules.includes(r))).toEqual([]);
  });

  it('A28 的样例是 check_backend 的 f1～f3', () => {
    const a28 = violationSamples().get('A28') ?? [];
    for (const p of ['f1-', 'f2-', 'f3-']) expect(a28.some((x) => x.startsWith(`check_backend/${p}`))).toBe(true);
    expect(a28.every((x) => /^check_backend\/f[1-3]-/.test(x))).toBe(true);
  });

  it('样例写的规则号都在规则表里（写错号等于没写）；规则表以外的只认 0.31 / 2.0 等单列的几条', () => {
    const extra = new Set(['2.4', 'R2', 'P142']);
    const unknown = [...violationSamples().keys()].filter((r) => !rules.includes(r) && !extra.has(r));
    expect(unknown).toEqual([]);
  });

  it('自证：拿掉某条规则的全部样例（例如 A13，QA 改坏抽查 10），这里一定报出来', () => {
    const samples = violationSamples();
    samples.delete('A13');
    const missing = rules.filter((r) => !B1_PENDING.includes(r) && (samples.get(r) ?? []).length === 0);
    expect(missing).toEqual(['A13']);
  });

  it('W3 的样例目录确实有 manifest', () => {
    expect(existsSync(join(FIXTURES, 'check_size', 'w3-over-budget', 'manifest.json'))).toBe(true);
  });
});
