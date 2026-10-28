// 架构 2.3 A11、A24：Stylelint 的违规样例要被拦住，对照组不能误报
import { join } from 'node:path';
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';
import { loadFixtures, ROOT } from './fixture-header.ts';

const fixtures = loadFixtures('stylelint');

describe('Stylelint 架构规则（tests/arch-fixtures/stylelint）', () => {
  for (const f of fixtures) {
    it(`${f.file} → ${f.expect.length ? f.expect.join(', ') : '应通过'}`, async () => {
      const res = await stylelint.lint({
        code: f.code,
        codeFilename: join(ROOT, f.path),
        cwd: ROOT,
      });
      const warnings = res.results.flatMap((r) => r.warnings);
      if (f.expect.length === 0) {
        expect(warnings).toEqual([]);
        return;
      }
      for (const rule of f.expect) {
        expect(
          warnings.some((w) => w.rule === rule),
          `${rule} 没有拦住；实际：${warnings.map((w) => w.rule).join(', ')}`,
        ).toBe(true);
      }
    });
  }

  it('令牌文件本身豁免（由 build/tokens.py 生成）', async () => {
    const res = await stylelint.lint({
      code: ':root { --x: #fff; --dur-ui: 220ms; }',
      codeFilename: join(ROOT, 'src/styles/tokens.css'),
      cwd: ROOT,
    });
    expect(res.results.every((r) => r.ignored === true || r.warnings.length === 0)).toBe(true);
  });
});
