// B1 接手清单 LINT-binimport：build/check_arch.py 的 BINIMPORT 规则（实现在 build/check_binimport.mjs，TypeScript 编译器 API）——
// require、import、import()、export … from 等的目标不准以二进制扩展名结尾（Node 的 CJS 把不认识的扩展名当 JS 执行，二进制里藏的代码评审在 diff 里看不到）。
// 本文件：JS/TS 里的各种引入写法、createRequire 绑定、①读文件再执行、扩展名与例外、对照组、真仓库。同一 describe 的另外两份：
// • check-arch-binimport-robust.test.ts：正则与除号、④createRequire 的间接传递、深嵌套和大文件
// • check-arch-binimport-entry.test.ts：②非 JS 入口（package.json scripts、CI 的 run:、.sh、.ps1、网页）
// 11-14 CI-10 手写词法器换成 AST 时，原 6 份测试的用例都并进这三份（拦截情形一条没少；非 JS 入口按新范围收窄，见 entry 文件头）
// 共用的拼仓库、跑 check_arch 在 check-arch-binimport-harness.ts；每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { afterEach, describe, expect, it } from 'vitest';
import { binimport, cleanupDirs, lines, repo, ROOT, where } from './check-arch-binimport-harness.ts';

afterEach(cleanupDirs);

describe('build/check_arch.py BINIMPORT（LINT-binimport）', () => {
  it('四种写法各报一条：require、import … from、await import()、export * from；行号对，退出码 1', () => {
    const body = lines(
      "const a = require('./a.png');",
      "import x from '../b.bin';",
      'async function f() {',
      "  return await import('./c.wasm');",
      '}',
      "export * from './d.png';",
      '',
    );
    const { code, errors } = binimport(repo({ 'lib/bad.ts': body }));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['lib/bad.ts:1', 'lib/bad.ts:2', 'lib/bad.ts:4', 'lib/bad.ts:6']);
    expect(errors.map((e) => /二进制扩展名 (\.\w+)/.exec(e.message)?.[1])).toEqual(['.png', '.bin', '.wasm', '.png']);
  });

  it('其他写法也报：副作用 import、export { } from、多行 import、TS 的 import = require、module.require、大写扩展名、带查询串、模板字符串、拼接、importScripts、new Worker、.node', () => {
    const body = lines(
      "import './side.gif';", // 1
      "export { a } from './e.webp';", // 2
      'import {', // 3
      '  b,', // 4
      "} from './f.jpg';", // 5
      "import g = require('./g.bin');", // 6
      "module.require('./h.png');", // 7
      "require('./UP.PNG');", // 8
      "require('./q.png?x=1');", // 9
      'require(`./t${n}.wasm`);', // 10
      "require('./c' + '.bin');", // 11
      "importScripts('ok.js', 'evil.png');", // 12
      "new Worker('./w.bin');", // 13
      "require('./addon.node');", // 14
      '',
    );
    const { errors } = binimport(repo({ 'lib/more.mjs': body }));
    // 多行 import 报在字符串所在的第 5 行（第 3、4 行不报）；拼接那一行是第二个字符串 '.bin' 命中
    const expected = [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n) => `lib/more.mjs:${n}`);
    expect(where(errors)).toEqual(expected);
  });

  it('createRequire（ESM 里把 .png 当代码执行的主要路子）：绑定的名字、连写、别名，以及 require.call/apply、require?.()、(0, require)() → 都报', () => {
    const body = lines(
      "import { createRequire } from 'node:module';", // 1
      'const r = createRequire(import.meta.url);', // 2
      "r('./a.png');", // 3
      'let r2; r2 = createRequire(import.meta.url);', // 4
      "r2?.('./b.bin');", // 5
      "r.call(null, './c.wasm');", // 6
      "createRequire(import.meta.url)('./d.png');", // 7
      "require.call(null, './e.png');", // 8
      "require.apply(null, ['./f.png']);", // 9
      "require?.('./g.png');", // 10
      "(0, require)('./h.png');", // 11
      "module.createRequire(import.meta.url)?.('./i.png');", // 12
      '',
    );
    const alias = lines(
      "import { createRequire as cr } from 'node:module';", // 1
      'var load = cr(import.meta.url);', // 2
      "load('./j.png');", // 3
      "cr(import.meta.url)('./k.png');", // 4
      '',
    );
    const { errors } = binimport(repo({ 'lib/cr.mjs': body, 'lib/alias.mts': alias }));
    expect(where(errors).sort()).toEqual(
      [...[3, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `lib/cr.mjs:${n}`), 'lib/alias.mts:3', 'lib/alias.mts:4'].sort(),
    );
    expect(errors.find((e) => e.line === 3 && e.file === 'lib/cr.mjs')?.message).toContain('createRequire');
  });

  it('createRequire 的绑定：TS 类型注解（含 => 和泛型）、module. / m. / m?. 前缀、{ createRequire: cr } 解构别名、绑定名的 .apply → 都报', () => {
    const files = {
      'tools/annot.ts': lines(
        "import { createRequire } from 'node:module';",
        'const r: NodeRequire = createRequire(import.meta.url);',
        "r('./a.png');", // 3
        'const r2: (id: string) => unknown = createRequire(import.meta.url);',
        "r2('./b.png');", // 5
        'const r3: Record<string, (id: string) => unknown>[\'x\'] = createRequire(import.meta.url);',
        "r3('./c.bin');", // 7
        'const x: number = 1, r4 = createRequire(import.meta.url);',
        "r4('./d.png');", // 9
        '',
      ),
      'tools/ns.mjs': lines(
        "import module from 'node:module';",
        'const r = module.createRequire(import.meta.url);',
        "r('./e.png');", // 3
        '',
      ),
      'tools/star.mjs': lines(
        "import * as m from 'node:module';",
        'const r = m.createRequire(import.meta.url);',
        "r('./f.png');", // 3
        'const q = m?.createRequire(import.meta.url);',
        "q('./g.png');", // 5
        '',
      ),
      'tools/destructure.mjs': lines(
        "const { createRequire: cr } = await import('node:module');",
        'const load = cr(import.meta.url);',
        "load('./h.png');", // 3
        "load.apply(null, ['./i.wasm']);", // 4
        '',
      ),
    };
    const { errors } = binimport(repo(files));
    expect(where(errors).sort()).toEqual(
      [
        'tools/annot.ts:3', 'tools/annot.ts:5', 'tools/annot.ts:7', 'tools/annot.ts:9',
        'tools/ns.mjs:3',
        'tools/star.mjs:3', 'tools/star.mjs:5',
        'tools/destructure.mjs:3', 'tools/destructure.mjs:4',
      ].sort(),
    );
  });

  it('跨行的类型注解：const r: 换行再写 NodeRequire = createRequire(…) → 报', () => {
    const body = lines("import { createRequire } from 'node:module';", 'const r:', '  NodeRequire = createRequire(import.meta.url);', "r('./x.png');", '');
    expect(where(binimport(repo({ 'tools/multi.ts': body })).errors)).toEqual(['tools/multi.ts:4']);
  });

  it('目标字符串超过 4096 个字符：不核对扩展名、按可疑报；正好 4096 个字符的照常核对', () => {
    const long = `./${'a'.repeat(4096)}.js`;
    const exact = `./${'a'.repeat(4096 - 5)}.js`;
    const { errors } = binimport(repo({ 'lib/long.js': lines(`require('${long}');`, `require('${exact}');`, '') }));
    expect(where(errors)).toEqual(['lib/long.js:1']);
    expect(errors[0]?.message).toContain('超过 4096');
  });

  it('对照：不是 createRequire 绑定出来的同名函数调用、createRequire 本身的参数 → 不报', () => {
    const body = lines(
      "import { createRequire } from 'node:module';",
      "const r = (p: string) => p.length;",
      "r('./x.png');", // 普通函数
      "const load = makeLoader(); load('./y.bin');", // 别的函数绑定
      "const req = createRequire('/tmp/a.png');", // createRequire 的参数只是基准路径，不执行
      "req('./ok.js');",
      '',
    );
    const { errors } = binimport(repo({ 'lib/plain.ts': body }));
    expect(errors).toEqual([]);
  });

  it('各种 JS/TS 扩展名都扫：.ts .tsx .mts .cts .js .jsx .mjs .cjs；不是代码的文件不扫', () => {
    const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    const files: Record<string, string> = Object.fromEntries(exts.map((ext) => [`lib/f${ext}`, "require('./x.bin');\n"]));
    files['docs/readme.md'] = "require('./x.bin');\n";
    files['lib/data.json'] = '{"a": "require(\'./x.bin\')"}\n';
    const { errors } = binimport(repo(files));
    expect(errors.map((e) => e.file).sort()).toEqual(exts.map((ext) => `lib/f${ext}`).sort());
  });

  it('注释和字符串里的假 import 不报；正则字面量里的引号不打乱后面的扫描', () => {
    const body = lines(
      "// require('./a.png')", // 1
      "/* import x from './b.bin';", // 2
      "   export * from './d.png'; */", // 3
      "const s = \"require('./c.wasm')\";", // 4
      "const t = `import('./c.wasm')`;", // 5
      "const r = /'/; const u = 'from';", // 6
      "const v = 1 / 2; const w = require('./real.bin');", // 7
      '',
    );
    const { errors } = binimport(repo({ 'lib/fake.ts': body }));
    expect(where(errors)).toEqual(['lib/fake.ts:7']);
  });

  it('合法例外：src/ 下 import / export … from / import() 引图片并带 ?url 或 ?inline → 不报', () => {
    const body = lines(
      "import logo from './logo.png?url';",
      "import icon from '../assets/icon.webp?inline';",
      "export { default as bg } from './bg.JPG?url';",
      "const lazy = () => import('./big.avif?url');",
      '',
    );
    const { code, errors } = binimport(repo({ 'src/app/assets.ts': body }));
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  });

  it('例外的边界：不带后缀、.bin/.wasm 带后缀、?raw、require 带后缀、模板字符串、src/ 外带后缀 → 都报', () => {
    const body = lines(
      "import a from './a.png';", // 1 不带后缀
      "import b from './b.bin?url';", // 2 不是图片
      "import c from './c.wasm?inline';", // 3 不是图片
      "import d from './d.png?raw';", // 4 ?raw 不放行
      "const e = require('./e.png?url');", // 5 require 不放行
      'const f = import(`./f.png?url`);', // 6 模板字符串不放行
      "import g from './g.png?url&x';", // 7 后缀写死，多一个参数不放行
      '',
    );
    const { errors } = binimport(repo({ 'src/app/bad.ts': body, 'build/tool.ts': "import x from './x.png?url';\n" }));
    expect(where(errors).sort()).toEqual([
      'build/tool.ts:1',
      ...Array.from({ length: 7 }, (_, i) => `src/app/bad.ts:${i + 1}`),
    ].sort());
  });

  it('对照：普通的 .ts/.js/.json/.css 引用、Array.from() / storage.from() 调用、new URL 引 .wasm（不执行）、（非 git 目录下的）node_modules → 不报', () => {
    const body = lines(
      "import a from './a.ts';",
      "import b from './b.json';",
      "import './c.css';",
      "const d = require('./d.js');",
      "const e = Array.from('x.png');",
      "await bucket.from('backups').upload('notes.json.gz');",
      "const f = new URL('./f.wasm', import.meta.url);",
      '',
    );
    const { code, errors } = binimport(repo({ 'lib/ok.ts': body, 'node_modules/pkg/index.js': "require('./x.bin');\n" }));
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  });

  it('①读文件再执行：eval / new Function / vm.runInThisContext / vm.Script / vm.compileFunction / process.dlopen 的参数里有二进制扩展名 → 报', () => {
    const body = lines(
      "import { readFileSync } from 'node:fs';", // 1
      "eval(readFileSync('./a.png', 'utf8'));", // 2
      "new Function(readFileSync('./b.bin', 'utf8'))();", // 3
      "vm.runInThisContext(readFileSync('./c.png', 'utf8'));", // 4
      "vm.runInNewContext(readFileSync('./d.bin', 'utf8'), {});", // 5
      "vm.runInContext(readFileSync('./e.png', 'utf8'), ctx);", // 6
      "new vm.Script(readFileSync('./f.png', 'utf8'));", // 7
      "vm.compileFunction(readFileSync('./g.wasm', 'utf8'));", // 8
      "process.dlopen(module, './h.node');", // 9
      "globalThis.eval?.(readFileSync('./i.png', 'utf8'));", // 10
      '',
    );
    const { errors } = binimport(repo({ 'lib/exec.mjs': body }));
    expect(where(errors)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `lib/exec.mjs:${n}`));
    expect(errors[0]?.message).toContain('eval()');
  });

  it('①对照：只读不执行的 readFileSync / fetch / new URL、eval 的参数里没有二进制扩展名 → 不报', () => {
    const body = lines(
      "const a = readFileSync('./a.png');",
      "const b = await fetch('/icon.png');",
      "const c = new URL('./c.wasm', import.meta.url);",
      "eval('1 + 1');",
      "const d = new Function('x', 'return x');",
      "const evaluate = (s) => s; evaluate('./e.png');",
      "await page.$eval('img[src=\"logo.png\"]', (el) => el.src);",
      "const s = new Script({ name: 'x', icon: 'logo.png' });", // 自定义的 Script，不是 vm.Script
      "function Script(o) { return o } Script('a.png');",
      '',
    );
    expect(binimport(repo({ 'lib/read.mjs': body })).errors).toEqual([]);
  });

  it('11-14 整块评审：字符串拼接、模板里的字面量插值、加载函数的别名、方括号属性名、Reflect.apply / construct → 都报（原来都是 0 报错）', () => {
    const body = lines(
      "require('./p.pn' + 'g');", // 1 两边都是字符串：折叠成 ./p.png
      "require(`./t.bi${'n'}`);", // 2 模板里的字面量代回去
      "const r = require; r('./q.bin');", // 3 require 的别名
      "let e2; e2 = eval; e2(readFileSync('./s.wasm', 'utf8'));", // 4 赋值得到的 eval 别名
      "const { require: rq } = module; rq('./u.bin');", // 5 解构改名
      "const r2 = r; r2('./v.png');", // 6 别名的别名
      "globalThis['require']('./w.bin');", // 7 方括号键是字面量
      "Reflect.apply(require, null, ['./x.png']);", // 8
      "Reflect.construct(Worker, ['./y.bin']);", // 9
      "require['call'](null, './z.png');", // 10
      "require('./a' + ('.p' + 'ng'));", // 11 嵌套拼接
      '',
    );
    const { errors } = binimport(repo({ 'lib/bypass.cjs': body }));
    expect(where(errors)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `lib/bypass.cjs:${n}`));
    expect(errors[0]?.message).toContain('./p.png');
    expect(errors[2]?.message).toContain('require 的别名');
    expect(errors[7]?.message).toContain('Reflect.apply(require()');
  });

  it('11-14 对照：拼出来不是二进制扩展名的、普通函数拿 require 当参数、Reflect.apply 别的函数、变量间接传路径（剩余风险，静态堵不住）→ 不报', () => {
    const body = lines(
      "require('./x.png' + '.js');", // 折叠后是 ./x.png.js
      "require(`./a${'.png'}.js`);",
      "const log = (f) => f; log(require); log('./b.png');",
      "Reflect.apply(fmt, null, ['./c.png']);",
      "const p = './d.bin'; require(p);", // 剩余风险：变量间接（文件头写明）
      "const o = { r: 1 }; o['r']('./e.png');",
      '',
    );
    expect(binimport(repo({ 'lib/ok.cjs': body })).errors).toEqual([]);
  });

  it('真仓库：BINIMPORT 0 个错误', { timeout: 60_000 }, () => {
    expect(binimport(ROOT).errors).toEqual([]);
  });
});
