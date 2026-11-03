// build/check_contrast.py（架构 8.1、L7；B6-exe 任务单 F12）：
//   算法用临时目录里现拼的迷你皮肤和清单测（公式、半透明按最坏底色、渐变逐个色标、多层背景、半透明前景、modes、清单出错）；
//   真仓库那一条只核对“清单在现有四套里都算得出来、和皮肤视觉稿‘对比度实测’的数对得上”，不断言全部达标——
//   不达标的项交视觉设计和负责人定（TC-B2-60），这里不把皮肤的现状写死。本文件起 python 子进程。
//   F12 代码审查 M1～M4、S1～S3：认不出的写法一律退出码 2、按精确值判定、最坏底色确实由项目色决定的数据、var() 缺省值的先后。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'build', 'check_contrast.py');

interface Result {
  theme: string;
  id: string;
  kind: string;
  min: number;
  ratio: number;
  exact: number;
  fg: string;
  bg: string;
  ok: boolean;
}
interface Report {
  themes?: string[];
  results?: Result[];
  failed?: number;
  error?: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function exec(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('python', ['-I', SCRIPT, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}
function run(args: string[]): { code: number; report: Report } {
  const { code, out } = exec(['--json', ...args]);
  return { code, report: JSON.parse(out) as Report };
}

const BACKDROPS = {
  light: { colors: ['#141518'], projectTokens: ['--p1', '--p2'], pick: 'darkest' },
  dark: { colors: ['#FFFFFF', '#F2DF4A'], projectTokens: ['--p1', '--p2'], pick: 'brightest' },
};
const THRESHOLDS = { text: { min: 4.5 }, nontext: { min: 3 } };

type Pair = { id: string; fg: string; bg: string | string[]; kind: string; modes?: string[] };

/**
 * 迷你仓库：skins 是 { 'x-light': '--a:#fff;…' }，pairs 只写要紧的字段（what、source 自动补）。
 * 脚本要求每套皮肤浅色、深色都有（S3），只给了一种时另一种照抄同一份变量
 */
function fixture(skins: Record<string, string>, pairs: Pair[], extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lemo-contrast-'));
  dirs.push(root);
  mkdirSync(join(root, 'build'));
  mkdirSync(join(root, 'src', 'styles', 'skins'), { recursive: true });
  const all = { ...skins };
  for (const [k, body] of Object.entries(skins)) {
    const [skin, mode] = k.split('-');
    const other = `${skin}-${mode === 'light' ? 'dark' : 'light'}`;
    all[other] ??= body;
  }
  const css = Object.entries(all)
    .map(([k, body]) => {
      const [skin, mode] = k.split('-');
      return `/* 注释 {不算} */\n:root[data-skin="${skin}"][data-theme="${mode}"]{${body}}`;
    })
    .join('\n');
  writeFileSync(join(root, 'src', 'styles', 'skins', 'x.css'), css);
  const full = pairs.map((p) => ({ what: p.id, source: '测试', ...p }));
  writeFileSync(
    join(root, 'build', 'contrast-pairs.json'),
    JSON.stringify({ thresholds: THRESHOLDS, backdrops: BACKDROPS, pairs: full, ...extra }),
  );
  return root;
}

const P = '--p1:#808080;--p2:#C0C0C0;';
const one = (r: Report, theme: string, id: string): Result => {
  const hit = r.results?.find((x) => x.theme === theme && x.id === id);
  if (!hit) throw new Error(`报告里没有 ${theme} ${id}`);
  return hit;
};
/** 只有一项 ab（--a 对 --b）的迷你仓库，跑完返回 x-light 那一项 */
const ab = (vars: string, kind = 'text', extra: Record<string, unknown> = {}) => {
  const res = run(['--root', fixture({ 'x-light': `${P}${vars}` }, [{ id: 'ab', fg: '--a', bg: '--b', kind }], extra)]);
  return { ...res, r: res.report.results ? one(res.report, 'x-light', 'ab') : undefined };
};

describe('build/check_contrast.py：算法', () => {
  it('WCAG 2.x 相对亮度公式：黑白 21、#777 对白 4.48 判正文不过、判非文字过；退出码按有没有不达标', () => {
    const root = fixture({ 'x-light': `${P}--k:#000000;--w:#FFFFFF;--g:#777777;` }, [
      { id: 'bw', fg: '--k', bg: '--w', kind: 'text' },
      { id: 'grey-text', fg: '--g', bg: '--w', kind: 'text' },
      { id: 'grey-icon', fg: '--g', bg: '--w', kind: 'nontext' },
    ]);
    const { code, report } = run(['--root', root]);
    expect(code).toBe(1);
    expect(one(report, 'x-light', 'bw').ratio).toBe(21);
    expect(one(report, 'x-light', 'grey-text')).toMatchObject({ ratio: 4.48, ok: false, min: 4.5 });
    expect(one(report, 'x-light', 'grey-icon')).toMatchObject({ ratio: 4.48, ok: true, min: 3 });
    expect(report.failed).toBe(2); // x-light、照抄的 x-dark 各一次
  });

  it('全部达标退出码 0；#RGB、rgb() 空格写法、百分比透明度都认得；var() 逐层解开', () => {
    const { code, r } = ab('--a:#000;--b:var(--c);--c:rgb(255 255 255 / 100%);');
    expect(code).toBe(0);
    expect(r).toMatchObject({ ratio: 21, fg: '#000000', bg: '#FFFFFF' });
  });

  it('按精确值判定，不先取整（M4）：精确 4.4972 的两位小数是 4.50，照样判不过；文字输出打 4 位小数', () => {
    const { code, r } = ab('--a:rgb(118.7 118.7 118.7);--b:#FFFFFF;');
    expect(code).toBe(1);
    expect(r).toMatchObject({ ratio: 4.5, ok: false });
    expect(r?.exact).toBeGreaterThan(4.495);
    expect(r?.exact).toBeLessThan(4.5);
    const root = fixture({ 'x-light': `${P}--a:rgb(118.7 118.7 118.7);--b:#FFFFFF;` }, [{ id: 'ab', fg: '--a', bg: '--b', kind: 'text' }]);
    expect(exec(['--root', root]).out).toContain('4.4972 < 4.5');
  });

  it('浅色半透明背景：叠到墨黑和最深的项目色上，取最低（视觉稿那种算法：80% 白叠墨黑 = #D0D0D1，82% 是 #D5D5D5）', () => {
    // rgba(255,255,255,.8) 叠 #141518 = #D0D0D1；叠最深的项目色 #808080 更亮，不是最坏
    const root = fixture({ 'x-light': `${P}--fg:#141518;--glass:rgba(255,255,255,.8);` }, [
      { id: 'glass', fg: '--fg', bg: '--glass', kind: 'text' },
    ]);
    const r = one(run(['--root', root]).report, 'x-light', 'glass');
    expect(r.bg).toBe('#D0D0D1');
    expect(r.ratio).toBe(11.86);
  });

  it('深色半透明背景：叠到白、柠檬黄和最亮的项目色上，取最低', () => {
    // rgba(30,33,42,.84) 叠白 = #42454C（视觉稿磨砂玻璃·深色弹层）
    const root = fixture({ 'x-dark': `${P}--fg:#B4B8C1;--glass:rgba(30,33,42,.84);` }, [
      { id: 'glass', fg: '--fg', bg: '--glass', kind: 'text' },
    ]);
    const r = one(run(['--root', root]).report, 'x-dark', 'glass');
    expect(r.bg).toBe('#42454C');
    expect(r.ratio).toBe(4.86);
  });

  it('项目色确实最坏时（S1）：浅色挑最深的项目色、深色挑最亮的项目色；固定底色换成不起作用的浅灰、深灰', () => {
    // 50% 白：底色 #E0E0E0 → #F0F0F0；--p1 #808080 → #C0C0C0（最坏）；--p2 #C0C0C0 → #E0E0E0。挑反了或不加项目色都对不上
    // 50% 黑：底色 #202020 → #101010；--p2 #C0C0C0 → #606060（对白字最坏）；--p1 #808080 → #404040
    const backdrops = {
      light: { colors: ['#E0E0E0'], projectTokens: ['--p1', '--p2'], pick: 'darkest' },
      dark: { colors: ['#202020'], projectTokens: ['--p1', '--p2'], pick: 'brightest' },
    };
    const root = fixture(
      { 'x-light': `${P}--k:#000;--w:#fff;--lt:rgba(255,255,255,.5);--dk:rgba(0,0,0,.5);` },
      [
        { id: 'light-tint', fg: '--k', bg: '--lt', kind: 'nontext' },
        { id: 'dark-tint', fg: '--w', bg: '--dk', kind: 'nontext' },
      ],
      { backdrops },
    );
    const { report } = run(['--root', root]);
    expect(one(report, 'x-light', 'light-tint').bg).toBe('#C0C0C0');
    expect(one(report, 'x-light', 'dark-tint').bg).toBe('#606060');
  });

  it('多种固定底色逐个算，不只看第一种（S1）：第二种底色才是最坏', () => {
    const backdrops = { light: { colors: ['#F0F0F0', '#202020'] }, dark: { colors: ['#FFFFFF'] } };
    const { r } = ab('--a:#000;--b:rgba(255,255,255,.5);', 'nontext', { backdrops });
    expect(r?.bg).toBe('#909090');
  });

  it('深浅由半透明色本身决定，不看主题名：深色主题里的白色半透明也按墨黑算', () => {
    const root = fixture({ 'x-dark': `${P}--fg:#000000;--tint:rgba(255,255,255,.5);` }, [
      { id: 'tint', fg: '--fg', bg: '--tint', kind: 'nontext' },
    ]);
    const r = one(run(['--root', root]).report, 'x-dark', 'tint');
    // 50% 白叠 #141518 = #8A8A8C，比叠 --p1 #808080（结果 #C0C0C0）更暗，是最坏
    expect(r.bg).toBe('#8A8A8C');
  });

  it('渐变逐个色标：线性渐变每个色标是一种底，上层光斑按自身透明度分别叠到每种底上（视觉稿 #C8DCEA 那一格）', () => {
    const grad =
      'radial-gradient(50% 30% at 0% 78%, rgba(127,191,228,.28), transparent 70%), linear-gradient(165deg, #F5F4EE, #E4E7EC)';
    const root = fixture({ 'x-light': `${P}--fg:#141518;--scr:${grad};` }, [
      { id: 'screen', fg: '--fg', bg: '--scr', kind: 'text' },
    ]);
    const r = one(run(['--root', root]).report, 'x-light', 'screen');
    expect(r.bg).toBe('#C8DCEA');
    expect(r.ratio).toBe(12.91);
  });

  it('背景最底下是半透明光斑叠实色（登录页那种写法），按光斑叠在实色上算', () => {
    const login = 'radial-gradient(80% 50% at 85% 0%, rgba(242,223,74,.45), transparent 70%), #F3F4F6';
    const root = fixture({ 'x-light': `${P}--fg:#595C64;--login:${login};` }, [
      { id: 'login', fg: '--fg', bg: '--login', kind: 'text' },
    ]);
    const r = one(run(['--root', root]).report, 'x-light', 'login');
    expect(r.bg).toBe('#F3EBA9');
    expect(r.ratio).toBe(5.48);
  });

  it.each([
    // M1 ④：渐变里带括号缺省值的 var()，--c 存在就用 --c（黑），缺省值整段不看；原来只捞到缺省值里的白，误判全部达标
    ['渐变里带括号缺省值的 var，变量存在', '--c:#000;--b:linear-gradient(var(--c, rgba(255,255,255,1)), #FFF);', '#000000', 1],
    ['var 缺省值不优先：--c 存在就用 --c', '--c:#000;--b:var(--c, #FFF);', '#000000', 1],
    ['var 变量不存在才用缺省值，缺省值里可以有括号和 var', '--w:#FFF;--b:var(--nope, var(--nope2, var(--w)));', '#FFFFFF', 21],
    ['渐变的色标带一个、两个位置，过渡提示跳过', '--b:linear-gradient(to right, #000 0% 10%, 30%, #FFF 90%);', '#000000', 1],
  ])('%s', (_n, vars, bg, ratio) => {
    const { r } = ab(`--a:#000;${vars}`, 'nontext');
    expect(r).toMatchObject({ bg, ratio });
  });

  it('多层背景（第一个在最上面）：选中块叠在玻璃上，玻璃再叠在最坏底色上', () => {
    const root = fixture({ 'x-light': `${P}--fg:#000000;--pill:rgba(0,0,0,.5);--tint:rgba(255,255,255,.5);` }, [
      { id: 'stack', fg: '--fg', bg: ['--pill', '--tint'], kind: 'nontext' },
      { id: 'tint-only', fg: '--fg', bg: '--tint', kind: 'nontext' },
    ]);
    const { report } = run(['--root', root]);
    // tint 叠 #141518 = #8A8A8C；再叠 50% 黑 = #454546，比只有 tint 暗
    expect(one(report, 'x-light', 'stack').bg).toBe('#454546');
    expect(one(report, 'x-light', 'stack').ratio).toBeLessThan(one(report, 'x-light', 'tint-only').ratio);
  });

  it('半透明前景先叠到背景上再算', () => {
    const { r } = ab('--a:rgba(0,0,0,.5);--b:#FFFFFF;', 'nontext');
    expect(r?.fg).toBe('#808080');
    // 叠出来是 127.5 灰（显示取整成 #808080），相对亮度 0.214，对白 1.05 / 0.264 = 3.98
    expect(r?.ratio).toBe(3.98);
  });

  it('modes 只在指定的深浅下算；没写 modes 两种都算', () => {
    const root = fixture({ 'x-light': `${P}--a:#000;--b:#fff;`, 'x-dark': `${P}--a:#fff;--b:#000;` }, [
      { id: 'light-only', fg: '--a', bg: '--b', kind: 'text', modes: ['light'] },
      { id: 'both', fg: '--a', bg: '--b', kind: 'text' },
    ]);
    const { report } = run(['--root', root]);
    expect(report.themes).toEqual(['x-dark', 'x-light']);
    expect(report.results?.map((r) => `${r.theme} ${r.id}`).sort()).toEqual(['x-dark both', 'x-light both', 'x-light light-only']);
  });

  it.each([
    ['变量不存在', '--b:var(--nope);', '没有变量 --nope'],
    ['循环引用', '--b:var(--c);--c:var(--b);', '循环引用'],
    ['缺省值里的循环引用', '--b:var(--nope, var(--b));', '循环引用'],
    ['底色完全透明', '--b:transparent;', '完全透明'],
    // M1：不在渐变里、在渐变里的认不出的写法都报 2，不许悄悄丢掉
    ['hsl', '--b:hsl(0 0% 100%);', '颜色写法不认识'],
    ['命名色', '--b:white;', '颜色写法不认识'],
    ['color-mix', '--b:color-mix(in srgb, #000 50%, #fff);', '颜色写法不认识'],
    ['渐变里的命名色', '--b:linear-gradient(165deg, white, #E4E7EC);', '渐变里的色标认不出'],
    ['渐变里的 hsl', '--b:linear-gradient(165deg, hsl(0 0% 0%), #FFF);', '渐变里的色标认不出'],
    ['渐变里的 color-mix', '--b:linear-gradient(color-mix(in srgb, #000 50%, #fff), #FFF);', '渐变里的色标认不出'],
    ['渐变里的 calc', '--b:linear-gradient(rgb(calc(10) 0 0), #FFF);', '渐变里的色标认不出'],
    ['渐变方向写错', '--b:linear-gradient(to sideways, #000, #FFF);', '渐变里的色标认不出'],
    ['渐变里有空参数', '--b:linear-gradient(#000, , #FFF);', '空参数'],
    // M2：原来这几种让 Python 抛异常、退出码 1
    ['变量值为空', '--b:;', '--b 是空值'],
    ['有空的一层', '--b:#FFF, ;', '空的一层'],
    ['rgb(none …)', '--b:rgb(none 0 0);', '颜色分量认不出：none'],
    ['透明度大于 1', '--b:rgba(0,0,0,5);', '透明度超出 0～1'],
    ['透明度为负', '--b:rgba(0,0,0,-.1);', '透明度超出 0～1'],
    ['分量大于 255', '--b:rgb(300,0,0);', '颜色分量超出 0～255：300'],
    ['斜杠前少一个分量', '--b:rgb(0 0 / 50%);', '斜杠前要正好 3 个分量'],
    ['空格写法 4 个分量', '--b:rgb(0 0 0 50%);', '空格写法要正好 3 个分量'],
    ['括号不配对', '--b:rgb(0,0,0;', '括号不配对'],
  ])('%s → 退出码 2，报出是哪一套哪一项和原因', (_name, vars, msg) => {
    const { code, report } = ab(`--a:#000;${vars}`);
    expect(code).toBe(2);
    expect(report.error).toContain(msg);
    expect(report.error).toMatch(/^x-(light|dark) ab：/);
  });

  it.each([
    ['类别没有门槛', [{ id: 'x', fg: '--a', bg: '--b', kind: 'huge' }], {}, '没有门槛'],
    ['id 重复', [{ id: 'x', fg: '--a', bg: '--b', kind: 'text' }, { id: 'x', fg: '--b', bg: '--a', kind: 'text' }], {}, 'id 重复'],
    // M2 ③：脚本自己的异常（门槛不是数、pairs 不是数组）也归 2，不冒成退出码 1
    ['门槛不是数', [{ id: 'x', fg: '--a', bg: '--b', kind: 'text' }], { thresholds: { text: { min: 'abc' } } }, 'x-dark x：内部错误 ValueError'],
    ['pairs 不是数组', [], { pairs: 5 }, '内部错误：TypeError'],
  ])('清单%s → 退出码 2', (_name, pairs, extra, msg) => {
    const { code, report } = run(['--root', fixture({ 'x-light': `${P}--a:#000;--b:#fff;` }, pairs as Pair[], extra)]);
    expect(code).toBe(2);
    expect(report.error).toContain(msg);
  });

  it.each([
    ['皮肤目录里没有皮肤块', '', '没有找到'],
    ['选择器用单引号', `:root[data-skin='y'][data-theme='light']{--a:#000}`, '皮肤块的选择器认不出'],
    ['选择器后面多跟属性', ':root[data-skin="y"][data-theme="light"][data-rt="1"]{--a:#000}', '皮肤块的选择器认不出'],
    ['缺深色那一块', ':root[data-skin="y"][data-theme="light"]{--a:#000}', '皮肤 y 缺 dark'],
  ])('皮肤文件：%s → 退出码 2（S3）', (_name, css, msg) => {
    const root = fixture({ 'x-light': `${P}--a:#000;--b:#fff;` }, [{ id: 'x', fg: '--a', bg: '--b', kind: 'text' }]);
    writeFileSync(join(root, 'src', 'styles', 'skins', 'y.css'), `/* y */\n${css}`);
    const { code, report } = run(['--root', root]);
    expect(code).toBe(2);
    expect(report.error).toContain(msg);
  });

  it('不加 --json 时打中文摘要，不达标的逐条列出（4 位小数，向下截断）', () => {
    const root = fixture({ 'x-light': `${P}--g:#777777;--w:#FFFFFF;` }, [{ id: 'grey', fg: '--g', bg: '--w', kind: 'text' }]);
    const { out } = exec(['--root', root]);
    expect(out).toContain('不达标 x-light grey');
    expect(out).toContain('4.4780 < 4.5');
    expect(out).toContain('不达标 2 次');
  });
});

describe('build/check_contrast.py：真仓库的清单和皮肤', () => {
  const { code, report } = run([]);
  const results = report.results ?? [];
  const pairs = (JSON.parse(readFileSync(join(ROOT, 'build', 'contrast-pairs.json'), 'utf8')) as { pairs: { modes?: string[] }[] }).pairs;
  const expected = (mode: string) => pairs.filter((p) => (p.modes ?? ['light', 'dark']).includes(mode)).length;

  it('清单在现有四套（两种皮肤 × 浅深）里都算得出来：不是配置错误，每套的条数和按 modes 过滤后的清单一样多', () => {
    expect(report.error).toBeUndefined();
    expect([0, 1]).toContain(code);
    expect(report.themes).toEqual(['glass-dark', 'glass-light', 'simple-dark', 'simple-light']);
    for (const t of report.themes ?? []) expect(results.filter((r) => r.theme === t).length).toBe(expected(t.split('-')[1] ?? ''));
    expect(results.length).toBe(2 * (expected('light') + expected('dark')));
  });

  it.each([
    // [主题, 清单 id, 视觉稿“对比度实测”的数]；视觉稿把叠出来的颜色先取整成十六进制再算，差 0.01 以内算对上
    ['simple-light', 'text2-login', 5.48],
    ['simple-dark', 'text2-login', 4.59],
    ['glass-light', 'text-screen', 12.91],
    ['glass-light', 'sheet-text', 11.86],
    ['glass-light', 'k-title', 12.07],
    ['glass-light', 'p1s-screen', 3.38],
    ['glass-light', 'late-red', 4.68],
    ['glass-dark', 'late-red', 4.55],
    ['glass-dark', 'sheet-text2', 4.86],
    ['glass-dark', 'p4s-screen', 4.84],
    ['simple-light', 'on-p2', 10.12],
  ])('%s %s 和视觉稿一致（%s）', (theme, id, want) => {
    const r = one(report, theme, id);
    expect(Math.abs(r.ratio - want)).toBeLessThanOrEqual(0.011);
  });
});
