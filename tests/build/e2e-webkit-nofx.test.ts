// CI webkit 关模糊名单（tests/e2e/webkit-ci-nofx.ts）的把关：
//   • 名单写死：这里另存一份，名单一变这里就挂，逼着改的人送审说明理由（防止把玻璃观感类用例悄悄加进去、让测试变弱）；
//   • 名单里每条都真有这条用例（改名后名单不会悄悄失效）；
//   • 名单里的用例本身不查玻璃观感：不截图对比、不读 backdrop-filter、不看玻璃令牌和对比度；
//   • 名单里的用例连同它调用的本文件 helper（递归展开）都不查玻璃观感（审查 p4 S1、S2）；
//   • 只在 CI 的 webkit 项目生效，chromium、本机、名单外的同文件用例都照常开模糊；
//   • 不许另开口子（审查 p4 M1）：扫整个 tests/e2e，除名单文件和 session-fixture.ts 外谁也不许引用名单，
//     除名单文件外谁也不许自己写“把 backdrop-filter 设成 none”的注入。
// 为什么要关、第七轮二分数据：见 tests/e2e/webkit-ci-nofx.ts 文件头。
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOFX_RULE, WEBKIT_CI_NOFX, needsNoFx } from '../e2e/webkit-ci-nofx.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const E2E = join(ROOT, 'tests', 'e2e');
const spec = (f: string) => readFileSync(join(E2E, f), 'utf8');

/** tests/e2e 下所有 .ts（含子目录），路径相对 tests/e2e、用 / 分隔 */
function allE2eTs(dir: string = E2E): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    if (d.isDirectory()) return allE2eTs(full);
    return d.name.endsWith('.ts') ? [relative(E2E, full).split(/[\\/]/).join('/')] : [];
  });
}

/** 写死的副本：只收依赖帧率的动效时序用例（第七轮：CI webkit 软件合成下这 8 条按帧采样会挂） */
const FROZEN = {
  'b2-motion-list.spec.ts': [
    'M1 打勾后头 220 ms 里“已完成”组不动，之后只往上走、不回退',
    'N1 打勾：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字',
    'N1 删除：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字',
    'N1 今天页“没赶上”最后一条打勾：整组离开，不透明度 > 0.25 的每一帧，它的字不压“今天的安排”等别的字（第三轮 P2）',
    'M2 撤销恢复：新行看得见的每一帧都不和别的行、组标题重叠',
  ],
  'b2-tabbar.spec.ts': ['切页过程中底栏一直看得见；液滴点下去就走，不等页面（设计动效评审 D1）'],
};

/** 观感类用例的特征：出现在用例正文（含它调用的 helper）里就不许进名单。
 *  例外两种不算观感：hasAttribute('data-glass') 只是等引擎启动；
 *  “不透明度”是离开那一行的 opacity，不是玻璃透明度。数组的 .filter(...) 调用不算，读样式的 .filter 属性才算 */
const LOOK_MARKERS = [
  /toHaveScreenshot/, /toMatchSnapshot/, /\.screenshot\(/, // 截图、快照对比
  /getImageData|readPixels|toDataURL|\bpixels?\(|\bdist\(/, // 读像素、比像素距离的 helper
  /backdrop/i, /\.filter\b(?!\s*\()/, /getPropertyValue\(\s*['"`](?:filter|box-shadow|background-color)/, // 读模糊、滤镜
  /\b(?:boxShadow|backgroundColor)\b/, /box-shadow|background-color/, // 读阴影、底色（玻璃材质）
  /(?<!hasAttribute\(')data-glass/, /--g-(?!s[xy]\b)/, /玻璃/, /对比度/, /contrast/i, /(?<!不)透明度/,
];

/** 本文件顶层声明的函数（function f / const f = ），名字 → 源码（到下一个顶层声明或顶层 test 为止） */
function topLevelFns(src: string): Map<string, string> {
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)|^test(?:\.describe)?\(/gm;
  const hits: { at: number; name: string | null }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) hits.push({ at: m.index, name: m[1] ?? m[2] ?? null });
  const out = new Map<string, string>();
  for (const [i, h] of hits.entries()) if (h.name) out.set(h.name, src.slice(h.at, hits[i + 1]?.at ?? src.length));
  return out;
}

/** 用例正文 + 它（递归）调用到的本文件顶层函数的源码（审查 p4 S1：观感断言可能藏在 helper 里） */
function withHelpers(src: string, body: string): string {
  const fns = topLevelFns(src);
  const seen = new Set<string>();
  const queue = [body];
  let all = body;
  while (queue.length > 0) {
    const chunk = queue.pop() ?? '';
    for (const [name, code] of fns) {
      if (seen.has(name) || !new RegExp(`\\b${name}\\b`).test(chunk)) continue;
      seen.add(name);
      all += `\n${code}`;
      queue.push(code);
    }
  }
  return all;
}

/** 从 spec 源码里找出这条用例的正文（test('名字' 或参数化的 test(`前缀${x}后缀` 开头，到下一条 test( 为止） */
function bodyOf(src: string, title: string): string | null {
  const re = /\btest\((['`])((?:(?!\1).)*)\1/g;
  const starts: { at: number; title: string }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ at: m.index, title: m[2] ?? '' });
  for (const [i, s] of starts.entries()) {
    const pat = new RegExp(`^${s.title.split(/\$\{[^}]+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
    if (pat.test(title)) return src.slice(s.at, starts[i + 1]?.at ?? src.length);
  }
  return null;
}

describe('CI webkit 关模糊名单', () => {
  it('名单和写死的副本一字不差（改名单要同时改这里并送审）', () => {
    expect(WEBKIT_CI_NOFX).toEqual(FROZEN);
  });

  it('文件名都不是玻璃观感、CSP、截图类的 spec', () => {
    for (const f of Object.keys(WEBKIT_CI_NOFX)) expect(f).not.toMatch(/glass|look|contrast|screenshot|visual|csp|transition|vt-/i);
  });

  it('名单里每条用例都真的存在，且正文和它调用的 helper 都不查玻璃观感', () => {
    for (const [f, titles] of Object.entries(WEBKIT_CI_NOFX)) {
      const src = spec(f);
      for (const t of titles) {
        const body = bodyOf(src, t);
        expect(body, `${f} 里找不到用例：${t}`).not.toBeNull();
        const code = withHelpers(src, body ?? '');
        for (const mk of LOOK_MARKERS) expect(code, `${f}「${t}」正文或 helper 含观感特征 ${String(mk)}`).not.toMatch(mk);
      }
    }
  });

  it('参数化的 N1 两条名字和源码里的参数对得上', () => {
    const src = spec('b2-motion-list.spec.ts');
    expect(src).toContain("['打勾', 'todos-done-t4']");
    expect(src).toContain("['删除', 'todos-del-t3']");
  });

  it('只在 CI 的 webkit、名单内的用例生效', () => {
    const file = join(ROOT, 'tests', 'e2e', 'b2-tabbar.spec.ts');
    const title = '切页过程中底栏一直看得见；液滴点下去就走，不等页面（设计动效评审 D1）';
    expect(needsNoFx({ file, title, project: 'webkit', ci: true })).toBe(true);
    expect(needsNoFx({ file, title, project: 'chromium', ci: true })).toBe(false);
    expect(needsNoFx({ file, title, project: 'webkit', ci: false })).toBe(false);
    // 同文件名单外的用例（底栏样式）照常开模糊
    expect(needsNoFx({ file, title: '底栏样式：固定在底部、有切页名字 tabbar；页签触控区够高', project: 'webkit', ci: true })).toBe(false);
    // 别的文件同名用例不算
    expect(needsNoFx({ file: join(ROOT, 'tests', 'e2e', 'b2-tabbar-transition.spec.ts'), title, project: 'webkit', ci: true })).toBe(false);
  });

  it('关模糊样式只动 backdrop-filter，不碰别的属性', () => {
    const decls = NOFX_RULE.replace(/^[^{]*\{|\}\s*$/g, '').split(';').map((d) => d.trim()).filter(Boolean);
    expect(decls).toEqual(['backdrop-filter: none !important', '-webkit-backdrop-filter: none !important']);
  });

  it('helper 展开真的生效：N1 的正文只有 ghostRun(...)，展开后要带上取样函数', () => {
    const src = spec('b2-motion-list.spec.ts');
    const t = 'N1 打勾：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字';
    const code = withHelpers(src, bodyOf(src, t) ?? '');
    expect(code).toContain('async function ghostRun(');
    expect(code).toContain('async function startSampler(');
    // 往 helper 里藏一句截图对比，要查得出来
    const planted = src.replace('async function startSampler(', 'async function startSampler(/* await expect(page).toHaveScreenshot() */');
    expect(withHelpers(planted, bodyOf(planted, t) ?? '')).toMatch(/toHaveScreenshot/);
  });

  // 审查 p4 M1：扫整个 tests/e2e，不只看几个写死的文件
  const NOFX_REF = /webkit-ci-nofx|NOFX_RULE|needsNoFx/;
  // 只拦“设成 none”的注入写法；读 -webkit-backdrop-filter 的值（b2-tabbar-transition 查过渡中模糊在不在）是观感检查，照常允许
  const NOFX_INJECT = [
    /backdrop-filter\s*:\s*none/i, // CSS 文本（<style>、insertRule、replaceSync、cssText），含 -webkit- 前缀
    /(?:webkitB|b)ackdropFilter\s*=\s*['"`]none/, // el.style.backdropFilter = 'none'
    /setProperty\(\s*['"`](?:-webkit-)?backdrop-filter['"`]\s*,\s*['"`]none/i, // el.style.setProperty('backdrop-filter', 'none')
  ];

  it('tests/e2e 里除名单文件和 session-fixture.ts 外，谁也不许引用这份名单', () => {
    const files = allE2eTs();
    expect(files.length).toBeGreaterThan(40); // 确认真的扫到了整个目录
    for (const f of files) {
      if (f === 'webkit-ci-nofx.ts' || f === 'session-fixture.ts') continue;
      expect(spec(f), `${f} 引用了关模糊名单`).not.toMatch(NOFX_REF);
    }
  });

  it('tests/e2e 里除名单文件外，谁也不许自己写关模糊的注入', () => {
    for (const f of allE2eTs()) {
      if (f === 'webkit-ci-nofx.ts') continue;
      for (const re of NOFX_INJECT) expect(spec(f), `${f} 自己关了 backdrop-filter（${String(re)}）`).not.toMatch(re);
    }
  });

  it('注入写法的识别对得上：几种关法都拦得住，读值不误伤', () => {
    const hit = (code: string) => NOFX_INJECT.some((re) => re.test(code));
    expect(hit("sheet.insertRule('* { backdrop-filter: none !important }')")).toBe(true);
    expect(hit("s.textContent = '.bar{-webkit-backdrop-filter:none}'")).toBe(true);
    expect(hit("el.style.backdropFilter = 'none'")).toBe(true);
    expect(hit("el.style.webkitBackdropFilter = 'none'")).toBe(true);
    expect(hit("el.style.setProperty('-webkit-backdrop-filter', 'none', 'important')")).toBe(true);
    expect(hit("cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter')")).toBe(false);
  });

  it('session-fixture.ts 只调用一次 needsNoFx', () => {
    expect(spec('session-fixture.ts').match(/needsNoFx\(/g)?.length).toBe(1);
  });
});
