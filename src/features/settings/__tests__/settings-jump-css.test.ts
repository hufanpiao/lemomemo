// 负责人 10-31（iPhone 主屏幕版）两条：
// ① “点击注销账号跟回退到设置页，注销账号 4 个字都会跳一下”。webkit 模拟 iPhone 15 实测两个原因：
//   • 进入：“注销账号”那一行是整行宽的 Pressable，按下 scale(0.97) 绕整行中心缩，左边的字从 x=30 被拉到 x=35、字高 19 → 18.4；
//     松手即点击、起页面切换，旧画面正好截在缩着的那一刻，淡出的 0.38 秒里一直定格 → 改成按下变淡、不缩放（只限 .row 里的 .rowBtn）
//   • 进入和返回：整页交叉淡入淡出时旧标题“设置”和新标题“注销账号”居中叠在一起 → 顶栏单独起名 page-head，先出后入（base.css，
//     那一侧的规则在 src/motion/__tests__/view-transition-css.test.ts）
// ② “界面语言 4 个字也不用特意加粗”：那一行的标签是 h2（读屏的分组标题），浏览器默认加粗；.tx 改成继承字重，和同页其他行一样（R-136）
// jsdom 不算 CSS 模块的样式，按源码文字核对；真浏览器里的字重、按下态、顶栏名字在 tests/e2e/b1-settings.spec.ts 实测
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = 'src/features/settings/ui';
const css = readFileSync(join(UI, 'SettingsPage.module.css'), 'utf8');
const pressable = readFileSync('src/motion/Pressable.module.css', 'utf8');

/** 取某个选择器（整行相等）的声明块 */
function block(src: string, selector: string): string {
  const at = src.indexOf(`\n${selector} {`);
  if (at < 0) return '';
  return src.slice(at, src.indexOf('}', at));
}

/** 选择器权重里的“类、属性、伪类”个数（这里只用到 .x 和 [x]） */
const classWeight = (sel: string): number => (sel.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length;

/** src 下所有 .css 文件的文字（去掉注释：base.css 的说明里也写着这个名字） */
function allCss(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.css'))
    .map((d) => readFileSync(join(d.parentPath, d.name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
}

describe('设置 ↔ 注销账号切换时“注销账号”不跳（负责人 10-31）', () => {
  it('顶栏 .top 起名 page-head；整个 src 只有这一处起这个名（一屏里只能有一个，设置和注销页不同时出现）', () => {
    expect(block(css, '.top')).toMatch(/view-transition-name: page-head;/);
    const owners = allCss('src').filter((s) => /view-transition-name:\s*page-head/.test(s));
    expect(owners).toHaveLength(1);
  });

  it('两屏的顶栏都用 .top（设置页和注销页）', () => {
    for (const f of ['SettingsPage.tsx', 'DeleteAccountView.tsx']) {
      expect(readFileSync(join(UI, f), 'utf8'), f).toContain('<header className={styles.top}>');
    }
  });

  it('行按钮按下：不缩放、改成变淡（--press-dim）', () => {
    const b = block(css, '.row .rowBtn[data-state="pressed"]');
    expect(b).toMatch(/transform: none;/);
    expect(b).toMatch(/opacity: var\(--press-dim\);/);
  });

  it('变淡带过渡（--dur-press、--ease-out）；减少动态效果的两种开关都关掉（权重比 Pressable 的 .pressable 高，得自己关）', () => {
    expect(block(css, '.row .rowBtn')).toMatch(/transition: opacity var\(--dur-press\) var\(--ease-out\);/);
    const media = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .row .rowBtn {'));
    expect(media.startsWith('@media'), '有 prefers-reduced-motion 分支').toBe(true);
    expect(media.slice(0, media.indexOf('}'))).toMatch(/transition: none;/);
    expect(block(css, ':global(:root[data-rm="1"]) .row .rowBtn')).toMatch(/transition: none;/);
    // 两个关掉的分支权重不低于开着的那条（:root[data-rm] 多一个属性和伪类；媒体查询里同权重、写在后面）
    expect(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .row .rowBtn {')).toBeGreaterThan(css.indexOf('\n.row .rowBtn {'));
  });

  it('权重盖得过 Pressable 自己的按下规则（不靠 CSS 打包的先后顺序）', () => {
    expect(pressable).toContain('.pressable[data-state="pressed"] {');
    expect(classWeight('.row .rowBtn[data-state="pressed"]')).toBeGreaterThan(classWeight('.pressable[data-state="pressed"]'));
  });

  it('用 .rowBtn 的两处（注销账号、导出全部数据）都在 <li className={styles.row}> 里，上面的规则管得到', () => {
    for (const f of ['AccountSection.tsx', 'DataSection.tsx']) {
      const src = readFileSync(join(UI, f), 'utf8');
      const at = src.indexOf('styles.rowBtn');
      expect(at, f).toBeGreaterThan(0);
      const li = src.lastIndexOf('<li', at);
      expect(src.slice(li, at), f).toContain('<li className={styles.row}>');
    }
  });
});

describe('“界面语言”不单独加粗（负责人 10-31，R-136）', () => {
  it('那一行的标签是 h2.tx；.tx 继承字重（span 本来就是常规字重，只有 h2 受影响）', () => {
    expect(readFileSync(join(UI, 'LanguageSection.tsx'), 'utf8')).toMatch(/<h2 id="settings-lang-title" className=\{styles\.tx\}>/);
    expect(block(css, '.tx')).toMatch(/font-weight: inherit;/);
  });
});
