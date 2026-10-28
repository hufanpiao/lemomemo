// 架构 2.3：每条 ESLint 规则的违规样例都要真的被拦住；对照组（expect=none）不能误报
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtures, ROOT } from './fixture-header.ts';

const eslint = new ESLint({ cwd: ROOT });
const fixtures = loadFixtures('eslint');

async function lint(code: string, path: string) {
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, path) });
  if (!res) throw new Error('ESLint 没有返回结果');
  return res.messages;
}

describe('ESLint 架构规则（tests/arch-fixtures/eslint）', () => {
  it('样例齐全：每条规则至少一个', () => {
    const rules = new Set(fixtures.flatMap((f) => f.expect));
    for (const r of [
      'boundaries/dependencies',
      'lemo/feature-index-exports',
      'lemo/motion-tokens',
      'lemo/no-inline-color',
      'lemo/safe-href',
      'lemo/no-log-request',
      'no-restricted-imports',
      'no-restricted-globals',
      'no-restricted-syntax',
      'react/no-danger',
      'no-console',
      '@typescript-eslint/no-explicit-any',
      '@typescript-eslint/ban-ts-comment',
      'react-hooks/rules-of-hooks',
      'react-hooks/exhaustive-deps',
      'react/jsx-no-target-blank',
      'react/no-array-index-key',
      'max-lines',
      'max-lines-per-function',
    ]) {
      expect(rules, r).toContain(r);
    }
  });

  for (const f of fixtures) {
    it(`${f.file} → ${f.expect.length ? f.expect.join(', ') : '应通过'}`, { timeout: 60_000 }, async () => {
      const messages = await lint(f.code, f.path);
      const fatal = messages.filter((m) => m.fatal);
      expect(fatal, '样例本身要能解析').toEqual([]);
      if (f.expect.length === 0) {
        expect(messages.filter((m) => m.severity === 2)).toEqual([]);
        return;
      }
      for (const rule of f.expect) {
        const hits = messages.filter((m) => m.ruleId === rule);
        expect(hits.length, `${rule} 没有拦住；实际：${messages.map((m) => m.ruleId).join(', ')}`).toBeGreaterThan(0);
        expect(hits.some((m) => m.severity === f.severity)).toBe(true);
      }
    });
  }
});
