// 架构 2.3 A11、A24（含 17.2 第 5 点的 lemo/reduced-motion-override，UI-4 L-1）：Stylelint 的违规样例要被拦住，对照组不能误报
import { readFileSync } from 'node:fs';
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
        // message：报错文字里要有这一段；count：至少报几处（同一个规则 id 下的不同问题，只比 id 会混过去）
        const hits = warnings.filter((w) => w.rule === rule && (!f.message || w.text.includes(f.message)));
        expect(
          hits.length >= f.count,
          `${rule}${f.message ? `（含“${f.message}”）` : ''} 应至少报 ${f.count} 处；实际：${warnings.map((w) => `${w.rule} ${w.text}`).join(' | ')}`,
        ).toBe(true);
      }
    });
  }

  // 17.2 第 5 点（UI-4 L-1）：仓库里真实的 CSS 也按这条规则过一遍，减少动态效果的覆盖两段都在
  for (const file of ['src/motion/Pressable.module.css', 'src/kit/components/Dialog.module.css', 'src/styles/base.css']) {
    it(`${file} 通过 lemo/reduced-motion-override`, async () => {
      const res = await stylelint.lint({ files: join(ROOT, file), cwd: ROOT });
      const warnings = res.results.flatMap((r) => r.warnings).filter((w) => w.rule === 'lemo/reduced-motion-override');
      expect(warnings).toEqual([]);
    });
  }

  it('Pressable：两段减少动态效果覆盖里，按下仍有瞬时变淡的反馈（不缩放、不加过渡）', () => {
    const css = readFileSync(join(ROOT, 'src/motion/Pressable.module.css'), 'utf8');
    const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const rm = /:global\(:root\[data-rm="1"\]\) \.pressable\[data-state="pressed"\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const pressedInMedia = /\.pressable\[data-state="pressed"\] \{([^}]*)\}/.exec(media)?.[1] ?? '';
    for (const block of [pressedInMedia, rm]) {
      expect(block).toMatch(/transform: none;/);
      expect(block).toMatch(/opacity: var\(--press-dim\);/);
      expect(block).not.toMatch(/transition/);
    }
  });

  it('令牌文件本身豁免（由 build/tokens.py 生成）', async () => {
    const res = await stylelint.lint({
      code: ':root { --x: #fff; --dur-ui: 220ms; }',
      codeFilename: join(ROOT, 'src/styles/tokens.css'),
      cwd: ROOT,
    });
    expect(res.results.every((r) => r.ignored === true || r.warnings.length === 0)).toBe(true);
  });
});
