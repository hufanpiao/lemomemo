// build/check_preload.mjs（预加载表去重的产物核对，代码审建议 1）：用临时目录现造 manifest 和块代码，
// 通过的样子一份，① 宿主已加载的 JS 还在、② 少 JS / 多 JS / 整张表不见、③ CSS 不一样各一份，以及没有 assets 目录时跳过（check_size 测试的假产物）；
// 复审建议 1～3 各一条：该留的都空时不要求有表、目标从 import 地址取、manifest 和产物对不上时只报一条
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPreload, fullDeps, mapDepsCalls } from '../../build/check_preload.mjs';

// main 静态引 jsx；懒加载 Page，Page 静态引 jsx 和 Settings，带 Page.css、Settings.css
const manifest = {
  'index.html': { file: 'assets/main.js', imports: ['_jsx.js'], dynamicImports: ['Page.tsx'], css: ['assets/main.css'] },
  '_jsx.js': { file: 'assets/jsx.js' },
  'Page.tsx': { file: 'assets/Page.js', imports: ['_jsx.js', '_Settings.js'], css: ['assets/Page.css'] },
  '_Settings.js': { file: 'assets/Settings.js', imports: ['_jsx.js'], css: ['assets/Settings.css'] },
};
// 不去重时 Vite 写的表：Page、jsx、Settings、Settings.css、Page.css；去重后去掉 jsx
const GOOD = ['assets/Page.js', 'assets/Settings.js', 'assets/Settings.css', 'assets/Page.css'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Man = Record<string, { file: string; css?: string[] }>;

/** list：main 块里懒加载 Page 的表（文件名，写进 m.f 再换成下标），null 表示没写表；man：manifest，里面的文件都建成空文件 */
function app(list: string[] | null, withAssets = true, man: Man = manifest): string {
  const d = mkdtempSync(join(tmpdir(), 'check-preload-'));
  dirs.push(d);
  mkdirSync(join(d, '.vite'));
  writeFileSync(join(d, '.vite', 'manifest.json'), JSON.stringify(man));
  if (!withAssets) return d;
  mkdirSync(join(d, 'assets'));
  for (const c of Object.values(man)) for (const f of [c.file, ...(c.css ?? [])]) writeFileSync(join(d, f), '');
  // 压缩后的样子：import 的地址是模板字符串
  const code = list
    ? `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=${JSON.stringify(list)})))=>i.map(i=>d[i]);\n` +
      'e(()=>import(`./Page.js`),__vite__mapDeps([' +
      list.map((_, i) => i).join(',') +
      ']));'
    : 'e(()=>import("./Page.js"),[]);';
  writeFileSync(join(d, 'assets', 'main.js'), code);
  return d;
}

describe('预加载表去重的产物核对', () => {
  it('按 Vite 的顺序重算不去重时的表：先 JS 再往下走，最后记块自己的 CSS；宿主本身不算', () => {
    const g = new Map([
      ['assets/main.js', { imports: ['assets/jsx.js'], dynamic: [], css: [] }],
      ['assets/jsx.js', { imports: [], dynamic: [], css: [] }],
      ['assets/Page.js', { imports: ['assets/jsx.js', 'assets/Settings.js'], dynamic: [], css: ['assets/Page.css'] }],
      ['assets/Settings.js', { imports: ['assets/jsx.js'], dynamic: [], css: ['assets/Settings.css'] }],
    ]);
    expect(fullDeps(g, 'assets/Page.js', 'assets/main.js')).toEqual([
      'assets/Page.js',
      'assets/jsx.js',
      'assets/Settings.js',
      'assets/Settings.css',
      'assets/Page.css',
    ]);
  });

  it('从块代码里取出每处表，目标取前面紧挨着的 import 地址（相对宿主目录）；找不到地址的 target 为 null', () => {
    const code =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/a.js","assets/b.css"])))=>i.map(i=>d[i]);' +
      'x(()=>import(`./a.js`),__vite__mapDeps([0,1]));y(()=>import("./c.js"),__vite__mapDeps([1]));z(__vite__mapDeps([0]));' +
      // 真实产物里还有这两种：import 后面接 .then，或者整段 async 函数里 await import
      't(()=>import(`./d.js`).then(e=>e.t),__vite__mapDeps([0]));t(async()=>{let e=await import(`./e.js`);return e.x},__vite__mapDeps([1]))';
    expect(mapDepsCalls(code, 'assets/main.js')).toEqual([
      { target: 'assets/a.js', deps: ['assets/a.js', 'assets/b.css'] },
      { target: 'assets/c.js', deps: ['assets/b.css'] },
      { target: null, deps: ['assets/a.js'] },
      { target: 'assets/d.js', deps: ['assets/a.js'] },
      { target: 'assets/e.js', deps: ['assets/b.css'] },
    ]);
  });

  it('去重对的产物通过', () => {
    expect(checkPreload(app(GOOD))).toEqual({ calls: 1, errors: [] });
  });

  it('① 宿主已加载的 jsx 还在表里就失败', () => {
    const r = checkPreload(app(['assets/Page.js', 'assets/jsx.js', 'assets/Settings.js', 'assets/Settings.css', 'assets/Page.css']));
    expect(r.errors).toEqual([expect.stringContaining('① 表里还有宿主已加载的 JS：assets/jsx.js')]);
  });

  it('② 少了 Settings 就失败；多了闭包外的块也失败', () => {
    expect(checkPreload(app(['assets/Page.js', 'assets/Settings.css', 'assets/Page.css'])).errors).toEqual([
      expect.stringContaining('② 少了 JS：assets/Settings.js'),
    ]);
    expect(checkPreload(app([...GOOD, 'assets/Other.js'])).errors).toEqual([expect.stringContaining('② 多了闭包外的 JS：assets/Other.js')]);
  });

  it('② 该有表的懒加载整张表不见了就失败', () => {
    expect(checkPreload(app(null)).errors).toEqual([expect.stringContaining('assets/main.js → assets/Page.js：② 整张预加载表不见了')]);
  });

  it('③ CSS 少一个或顺序变了都失败', () => {
    expect(checkPreload(app(['assets/Page.js', 'assets/Settings.js', 'assets/Page.css'])).errors).toEqual([
      expect.stringContaining('③ CSS 和不去重时不一样'),
    ]);
    expect(checkPreload(app(['assets/Page.js', 'assets/Settings.js', 'assets/Page.css', 'assets/Settings.css'])).errors).toEqual([
      expect.stringContaining('③ CSS 和不去重时不一样'),
    ]);
  });

  it('建议 1：目标本身在宿主闭包里、又没有 CSS，去重后该留的都空，没有表也不报', () => {
    const man = {
      'index.html': { file: 'assets/main.js', imports: ['_jsx.js', 'Page.tsx'], dynamicImports: ['Page.tsx'] },
      '_jsx.js': { file: 'assets/jsx.js' },
      'Page.tsx': { file: 'assets/Page.js', imports: ['_jsx.js'] },
    };
    expect(checkPreload(app(null, true, man))).toEqual({ calls: 0, errors: [] });
  });

  it('建议 2：目标在宿主闭包里、只剩 CSS 时表的第一项是 CSS，按 import 地址认目标照样通过', () => {
    const man = {
      'index.html': { file: 'assets/main.js', imports: ['_jsx.js', 'Page.tsx'], dynamicImports: ['Page.tsx'] },
      '_jsx.js': { file: 'assets/jsx.js' },
      'Page.tsx': { file: 'assets/Page.js', imports: ['_jsx.js'], css: ['assets/Page.css'] },
    };
    expect(checkPreload(app(['assets/Page.css'], true, man))).toEqual({ calls: 1, errors: [] });
  });

  it('建议 3：manifest 里的文件在产物里找不到（读到了别的构建的 manifest），只报一条“对不上”，不逐个报假错', () => {
    const d = app(GOOD);
    rmSync(join(d, 'assets', 'Settings.js'));
    rmSync(join(d, 'assets', 'Page.css'));
    const r = checkPreload(d);
    expect(r.calls).toBe(0);
    expect(r.errors).toEqual([expect.stringMatching(/manifest 和产物对不上：manifest 里有 2 个文件.*找不到/)]);
  });

  it('没有 assets 目录（check_size 测试的假产物）就跳过', () => {
    expect(checkPreload(app(GOOD, false))).toEqual({ calls: 0, errors: [] });
  });
});
