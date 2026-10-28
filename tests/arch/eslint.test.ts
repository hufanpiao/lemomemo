// 架构 2.3：每条 ESLint 规则的违规样例都要真的被拦住；对照组（expect=none）不能误报
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtures, ROOT } from './fixture-header.ts';

// 唯一的改动：边界规则多认一个目录 tests/arch-fixtures/eslint-targets/（违规样例的引用目标，真文件）。
// 现在仓库里还没有任何功能的 data/，引不存在的文件时边界规则认不出类型、不报（QA D-07）；目录名照仓库的写，元素类型按路径结尾认
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: {
    settings: { 'boundaries/include': ['src/**/*', 'shared/**/*', 'tests/arch-fixtures/eslint-targets/**/*'] },
  },
});
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
        const all = messages.filter((m) => m.ruleId === rule);
        // 写了 message= 的，只算报错文字里有这一段的（防止被同一 ruleId 下“别的一条”拦住也算过）
        const hits = f.message === undefined ? all : all.filter((m) => m.message.includes(f.message ?? ''));
        const actual = messages.map((m) => `${m.ruleId}「${m.message}」`).join('；');
        expect(hits.length, `${rule}${f.message ? `（${f.message}）` : ''} 没有拦住；实际：${actual}`).toBeGreaterThanOrEqual(f.count);
        expect(hits.some((m) => m.severity === f.severity)).toBe(true);
      }
    });
  }
});
