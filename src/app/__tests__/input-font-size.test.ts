// 触屏上可输入控件的字号不小于 16px（负责人 11-06 真机截图 7：点“项目”输入框，整页被放大并横移，左边被切掉）。
// iOS Safari 聚焦 font-size 小于 16px 的 input / select / textarea 会自动放大页面。修法是把触屏上的字号调到 ≥ 16px，
// 不准用 viewport 的 maximum-scale、user-scalable=no 禁缩放（无障碍：用户要能双指放大）。
// jsdom 不算样式，按源码核对：扫 src 里所有 .tsx 的 <input> / <select> / <textarea>（勾选框、单选等不弹键盘的类型除外），
// 每个必须带 CSS 模块类（className={styles.x}；导入名不限，按导入的文件认，如 form.input 认 Form.module.css，代码审建议 3），这些类在触屏（没有媒体查询，或媒体查询里有 pointer: coarse / hover: none）
// 下最后生效的 font-size 解析成 px 后 ≥ 16。写 font: inherit、不写字号的一律不通过（继承来的字号在源码里看不出来，要写明）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIN_PX = 16;
/** 不弹键盘、iOS 不会因它放大的类型 */
const NON_TEXT = new Set(['checkbox', 'radio', 'range', 'hidden', 'color', 'file', 'button', 'submit', 'reset', 'image']);

const tokens = new Map<string, number>(
  [...readFileSync('src/styles/tokens.css', 'utf8').matchAll(/(--fs-[\w-]+):\s*([\d.]+)px/g)].map((m) => [m[1] ?? '', Number(m[2])]),
);

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p, ext);
    return p.endsWith(ext) ? [p] : [];
  });
}

interface Rule {
  selectors: string[];
  media: string | null;
  decls: [string, string][];
}

/** 很小的 CSS 解析：去注释，按花括号嵌套拆出规则（只认 @media 一层嵌套，够 CSS 模块用） */
function parseCss(src: string): Rule[] {
  const css = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const walkBlock = (text: string, media: string | null): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walkBlock(body, head.slice(6).trim());
      else if (!head.startsWith('@')) {
        const decls = body
          .split(';')
          .map((d) => d.trim())
          .filter((d) => d.includes(':'))
          .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()] as [string, string]);
        out.push({ selectors: head.split(',').map((s) => s.trim()), media, decls });
      }
      i = j;
    }
  };
  walkBlock(css, null);
  return out;
}

/** 触屏手机上会生效的媒体查询：没有媒体查询，或者写的是 pointer: coarse / hover: none（宽屏、电脑那些不算） */
const touchMedia = (m: string | null): boolean => m === null || /pointer:\s*coarse|hover:\s*none/.test(m);

function px(v: string): number | null {
  const t = /^var\((--fs-[\w-]+)\)$/.exec(v);
  if (t) return tokens.get(t[1] ?? '') ?? null;
  const p = /^([\d.]+)px$/.exec(v);
  return p ? Number(p[1]) : null;
}

/** 类 cls 在触屏上最后生效的 font-size（px）；没写或解析不了为 null。只看以这个类结尾、不带伪类的选择器 */
function touchFontSize(rules: Rule[], cls: string): number | null {
  const re = new RegExp(`(^|[\\s>+~])\\.${cls}$`);
  let size: number | null = null;
  for (const r of rules) {
    if (!touchMedia(r.media) || !r.selectors.some((s) => re.test(s))) continue;
    for (const [k, v] of r.decls) {
      if (k === 'font-size') size = px(v);
      else if (k === 'font' && v !== 'inherit') size = px(v.split(/\s+/).find((w) => px(w) !== null) ?? '');
    }
  }
  return size;
}

interface Control {
  file: string;
  tag: string;
  /** [CSS 模块文件, 类名]：按导入名找到类来自哪个文件 */
  classes: [string, string][];
}

/** 找出 .tsx 里的 <input / <select / <textarea 开标签（到花括号外的第一个 >） */
function controlsIn(file: string, src: string): Control[] {
  // 文件里所有 CSS 模块导入：导入名 → 文件（相对这个 .tsx）
  const mods = new Map([...src.matchAll(/import\s+(\w+)\s+from\s+'(\.[^']+\.module\.css)'/g)].map((x) => [x[1] ?? '', join(dirname(file), x[2] ?? '')]));
  const out: Control[] = [];
  for (const m of src.matchAll(/<(input|select|textarea)\b/g)) {
    let depth = 0;
    let j = (m.index ?? 0) + m[0].length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tag = src.slice(m.index ?? 0, j + 1);
    const type = /\btype="([a-z]+)"/.exec(tag)?.[1];
    if (m[1] === 'input' && type !== undefined && NON_TEXT.has(type)) continue;
    const at = tag.indexOf('className={');
    let cn = '';
    if (at >= 0) {
      let d = 0;
      let k = at + 'className='.length;
      for (; k < tag.length; k++) {
        if (tag[k] === '{') d++;
        else if (tag[k] === '}' && --d === 0) break;
      }
      cn = tag.slice(at, k);
    }
    const classes = [...cn.matchAll(/\b(\w+)\.(\w+)/g)].flatMap((x): [string, string][] => {
      const css = mods.get(x[1] ?? '');
      return css === undefined ? [] : [[css, x[2] ?? '']];
    });
    out.push({ file, tag: m[1] ?? '', classes });
  }
  return out;
}

function problems(c: Control): string[] {
  const where = `${c.file.replaceAll('\\', '/')} <${c.tag}>`;
  if (c.classes.length === 0) return [`${where}：没带 CSS 模块类，字号看不出来`];
  const sizes = c.classes.map(([css, k]) => [k, touchFontSize(parseCss(readFileSync(css, 'utf8')), k)] as const);
  if (sizes.every(([, s]) => s === null)) return [`${where}：类 ${sizes.map(([k]) => k).join(' ')} 在触屏上没写 font-size（或写的是 font: inherit）`];
  return sizes.filter(([, s]) => s !== null && s < MIN_PX).map(([k, s]) => `${where}：.${k} 触屏字号 ${String(s)}px < ${MIN_PX}px`);
}

describe('触屏上可输入控件字号 ≥ 16px（iOS 聚焦不放大页面）', () => {
  const all = walk('src', '.tsx').flatMap((f) => controlsIn(f, readFileSync(f, 'utf8')));

  it('扫到了全站的可输入控件（防止扫描器失灵、什么都没查就通过）', () => {
    const files = new Set(all.map((c) => c.file.replaceAll('\\', '/')));
    for (const f of [
      'src/kit/components/Form.tsx',
      'src/features/reminders/ui/RemindDnd.tsx',
      'src/features/auth/ui/AuthPage.tsx',
      'src/features/settings/ui/DeleteAccountView.tsx',
    ]) expect(files, f).toContain(f);
    expect(all.filter((c) => c.file.replaceAll('\\', '/') === 'src/kit/components/Form.tsx').map((c) => c.tag).sort()).toEqual(['input', 'select', 'textarea']);
  });

  it('每一个都 ≥ 16px', () => {
    expect(all.flatMap(problems)).toEqual([]);
  });

  it('检查本身拦得住：15px、font: inherit、只在宽屏媒体查询里写 16px 都不通过；触屏媒体查询里改成 16px 才通过', () => {
    const base = '.a { font-size: var(--fs-15); } .b { font: inherit; } @media (width >= 900px) { .a { font-size: 16px; } }';
    expect(touchFontSize(parseCss(base), 'a')).toBe(15);
    expect(touchFontSize(parseCss(base), 'b')).toBeNull();
    expect(touchFontSize(parseCss(`${base} @media (any-pointer: coarse) { .a, .b { font-size: var(--fs-16); } }`), 'a')).toBe(16);
    expect(touchFontSize(parseCss(`${base} @media (any-pointer: coarse) { .a, .b { font-size: var(--fs-16); } }`), 'b')).toBe(16);
    expect(touchFontSize(parseCss('.a:focus-visible { font-size: 20px; } .a { font-size: 12px; }'), 'a')).toBe(12);
    const c = controlsIn(
      'x.tsx',
      "import styles from './x.module.css';\nimport form from './f.module.css';\n<input type=\"checkbox\" /><input className={`${form.i} ${styles.j}`} onChange={(e) => f(e)} /><textarea className={other.k} />",
    );
    // 导入名不限、按文件认（代码审建议 3）；没导入的对象（other.k）不算 CSS 模块类
    expect(c.map((x) => [x.tag, x.classes.map(([css, k]) => [css.replaceAll('\\', '/'), k])])).toEqual([
      ['input', [['f.module.css', 'i'], ['x.module.css', 'j']]],
      ['textarea', []],
    ]);
  });

  it('入口页不禁缩放：viewport 里没有 maximum-scale、user-scalable', () => {
    for (const f of ['src/index.html', 'src/auth/index.html']) {
      const vp = /<meta name="viewport" content="([^"]*)"/.exec(readFileSync(f, 'utf8'))?.[1];
      expect(vp, f).toBeDefined();
      expect(vp, f).not.toMatch(/maximum-scale|user-scalable/);
    }
  });
});
