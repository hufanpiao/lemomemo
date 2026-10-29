// B1 接手清单 LINT-binimport：build/check_arch.py 的 BINIMPORT 规则——require、import、import()、export … from 的目标
// 不准以二进制扩展名结尾（Node 的 CJS 把不认识的扩展名当 JS 执行，二进制里藏的代码评审在 diff 里看不到）。
// 每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface Item {
  rule: string;
  file: string;
  line: number;
  message: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lemo-binimport-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

function binimport(root: string): { code: number; errors: Item[] } {
  const args = ['-I', join(ROOT, 'build', 'check_arch.py'), '--root', root, '--json', '--today', '2026-10-28'];
  let code = 0;
  let out: string;
  try {
    out = execFileSync('python', args, { encoding: 'utf8' });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    out = err.stdout;
  }
  const report = JSON.parse(out) as { errors: Item[] };
  return { code, errors: report.errors.filter((x) => x.rule === 'BINIMPORT') };
}

const where = (errors: Item[]) => errors.map((e) => `${e.file}:${e.line}`);
const lines = (...ls: string[]) => ls.join('\n');

/** 只计 check_binimport 本身的耗时（不算 python 启动、模块加载）；errors 是“文件:行号”列表 */
function timed(root: string): { seconds: number; errors: string[] } {
  const script = [
    'import importlib.util, json, pathlib, sys, time',
    'spec = importlib.util.spec_from_file_location("check_arch", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'errors = []; t = time.perf_counter(); mod.check_binimport(pathlib.Path(sys.argv[2]), errors)',
    'print(json.dumps({"seconds": time.perf_counter() - t, "errors": [f"{e[1]}:{e[2]}" for e in errors]}))',
  ].join('\n');
  const args = ['-I', '-c', script, join(ROOT, 'build', 'check_arch.py'), root];
  return JSON.parse(execFileSync('python', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as { seconds: number; errors: string[] };
}

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

  it('耗时上限：一行 5 万个 k:v=w（含、不含 createRequire 两种），check_binimport 5 秒内跑完（不算 python 启动；本机约 0.6 秒，留够 CI 余量，修补前要 119 秒）', () => {
    const kv = Array.from({ length: 50_000 }, (_, i) => `k${i}:v${i}=w`).join(',');
    const root = repo({
      'lib/plain.js': `x={${kv}}\n`,
      'lib/with-cr.js': `x={${kv},c:createRequire(u),d:load=createRequire(u)}\n`,
    });
    expect(timed(root).seconds).toBeLessThan(5);
  });

  it('括号配对一遍算完：1 万个未闭合的 require(、5 千层平衡嵌套的 require(…)，check_binimport 各 5 秒内跑完，结果照报', () => {
    // 最里层的 './z.png' 在每一层 require 的括号里，只报一次
    const unclosed = timed(repo({ 'lib/unclosed.js': `${"require('./a.js', ".repeat(10_000)}'./z.png'\n` }));
    const nested = timed(repo({ 'lib/nested.js': `${"require('./a.js', ".repeat(5_000)}'./z.png'${')'.repeat(5_000)};\n` }));
    expect(unclosed.seconds).toBeLessThan(5);
    expect(nested.seconds).toBeLessThan(5);
    expect(unclosed.errors).toEqual(['lib/unclosed.js:1']);
    expect(nested.errors).toEqual(['lib/nested.js:1']);
  });

  it('4 万条报错的文件：check_binimport 5 秒内跑完，行号逐条对（每文件算一次换行位置再二分）', () => {
    const { seconds, errors } = timed(repo({ 'lib/many.js': `// head\n${"require('./x.png');\n".repeat(40_000)}` }));
    expect(seconds).toBeLessThan(5);
    expect(errors).toEqual(Array.from({ length: 40_000 }, (_, i) => `lib/many.js:${i + 2}`));
  });

  it('模板 ${…} 嵌套 1000 层不崩（显式栈，不递归），最里层的 require 照报', () => {
    const deep = `// head\nconst s = ${'`${'.repeat(1000)}require('./x.png')${'}`'.repeat(1000)};\nrequire('./y.bin');\n`;
    const { code, errors } = binimport(repo({ 'lib/deep.js': deep }));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['lib/deep.js:2', 'lib/deep.js:3']);
  });

  it('模板嵌套 2 万层：check_binimport 2 秒内跑完（字面量只存下标），最里层的 require 照报', () => {
    const { seconds, errors } = timed(repo({ 'lib/deep.js': `// head\nconst s = ${'`${'.repeat(20_000)}require('./x.png')${'}`'.repeat(20_000)};\n` }));
    expect(seconds).toBeLessThan(2);
    expect(errors).toEqual(['lib/deep.js:2']);
  });

  it('400 个约 4090 字、满是 ${ 却没有 } 的 require 目标：check_binimport 2 秒内跑完（${…} 替换线性扫描），扩展名照常核对', () => {
    const spec = (ext: string) => `./${'${'.repeat(2044)}${ext}`;
    const body = `${Array.from({ length: 400 }, () => `require('${spec('.js')}');`).join('\n')}\nrequire('${spec('.png')}');\n`;
    const { seconds, errors } = timed(repo({ 'lib/dollar.js': body }));
    expect(seconds).toBeLessThan(2);
    expect(errors).toEqual(['lib/dollar.js:401']);
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

  // ---- LINT-binimport-gaps 第 ①～④ 条（10-29 第二轮） ----

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

  it('②非 JS 入口：package.json scripts、CI yml、.sh、.py、Makefile、无扩展名的 shebang 脚本里“命令 + 二进制扩展名路径” → 报', () => {
    const pkg = JSON.stringify(
      {
        scripts: {
          a: 'node assets/x.png', // 3
          b: 'node build/gen.mjs --out logo.png', // 4 不报：执行的是 gen.mjs
          c: 'tsx -r ./hook.bin main.ts', // 5 -r 预加载也执行
          d: 'node --import=./loader.wasm main.js', // 6
          e: 'cross-env A=1 python3 tools/run.bin && echo ok', // 7
          f: 'deno run ./x.png', // 8
        },
      },
      null,
      2,
    );
    const ci = lines(
      'jobs:', // 1
      '  t:', // 2
      '    steps:', // 3
      "      - uses: actions/setup-node@v4", // 4
      '        with:', // 5
      '          node-version: 22', // 6
      '      - run: python tools/x.bin', // 7
      '      - run: bash ./setup.sh', // 8 不报
      '      - run: |', // 9
      '          source env.bin', // 10
      '          node scripts/a.mjs out.png', // 11 不报
      '',
    );
    const sh = lines(
      '#!/bin/sh', // 1
      '. ./x.bin', // 2
      'source ./lib.sh', // 3 不报
      'cp a.png b.png', // 4 不报
      'set -e; sh ./payload.gz', // 5
      '',
    );
    const py = lines(
      'import os, subprocess', // 1
      'os.system("python payload.bin")', // 2
      'subprocess.run("node ./a.mjs --icon a.png", shell=True)', // 3 不报
      '',
    );
    const make = lines('all:', '\tnode ./build.png', ''); // 2
    const hook = lines('#!/usr/bin/env sh', 'node .husky/x.bin', ''); // 2
    const { errors } = binimport(
      repo({ 'package.json': pkg, '.github/workflows/ci.yml': ci, 'build/a.sh': sh, 'build/b.py': py, Makefile: make, '.husky/pre-commit': hook }),
    );
    expect(where(errors).sort()).toEqual(
      [
        'package.json:3', 'package.json:5', 'package.json:6', 'package.json:7', 'package.json:8',
        '.github/workflows/ci.yml:7', '.github/workflows/ci.yml:10',
        'build/a.sh:2', 'build/a.sh:5',
        'build/b.py:2',
        'Makefile:2',
        '.husky/pre-commit:2',
      ].sort(),
    );
    expect(errors.find((e) => e.file === 'package.json' && e.line === 3)?.message).toContain('node');
    expect(errors.find((e) => e.file === 'build/a.sh' && e.line === 2)?.message).toContain('命令 . 执行');
  });

  it('②选项处理：值是文件的选项看完接着找脚本、值不是文件的选项跳过它的值、python3.11 / python.exe / node.exe 也认', () => {
    const sh = lines(
      'node -r ./hook.js payload.png', // 1：-r 的值不是二进制，接着看 payload.png
      'python -W ignore payload.bin', // 2：-W 的值 ignore 不是文件
      'python3.11 payload.bin', // 3
      'node --max-old-space-size 4096 x.png', // 4
      'node --title app x.wasm', // 5
      'node -r ./a.js main.mjs out.png', // 6 不报：执行的是 main.mjs
      'python -X utf8 tool.py logo.png', // 7 不报
      '',
    );
    const ps1 = lines('& python.exe payload.bin', 'node.exe x.png', 'pwsh -File ./x.png', 'node.exe ./ok.mjs a.png', ''); // 1-3 报，4 不报
    const { errors } = binimport(repo({ 'build/a.sh': sh, 'build/a.ps1': ps1 }));
    expect(where(errors).sort()).toEqual(
      ['build/a.sh:1', 'build/a.sh:2', 'build/a.sh:3', 'build/a.sh:4', 'build/a.sh:5', 'build/a.ps1:1', 'build/a.ps1:2', 'build/a.ps1:3'].sort(),
    );
    expect(errors.find((e) => e.file === 'build/a.ps1' && e.line === 1)?.message).toContain('python.exe');
  });

  it('②PowerShell：-File 的值就是脚本、看完就停（后面是脚本自己的参数）；-ExecutionPolicy 带值、-NoProfile 不带值；-C 只对 node 系跳值', () => {
    const ps1 = lines(
      'pwsh -File x.ps1 -Icon a.png', // 1 不报
      'pwsh -File=x.ps1 a.png', // 2 不报
      'pwsh -File .\\a.ps1 -In logo.png', // 3 不报
      'powershell -NoProfile -ExecutionPolicy Bypass -File "D:\\x\\柠檬记APP\\tools\\keys\\a.ps1" -Target preview', // 4 不报（仓库里的写法）
      'powershell -NoProfile -ExecutionPolicy Bypass -File E:\\发布\\publish-v4.0.0.ps1 -Tag v4.0.0', // 5 不报（不带引号的 Windows 路径）
      'powershell -NoProfile -ExecutionPolicy Bypass -File ./x.png', // 6 报
      'powershell.exe -file:payload.bin', // 7 报（不分大小写、冒号写法）
      'pwsh -NoProfile -Command "& ./a.ps1" a.png', // 8 不报：-Command 后面是代码
      '',
    );
    const ci = lines('jobs:', '  t:', '    steps:', '      - run: pwsh -File build/make.ps1 -Icon logo.png', ''); // 4 不报
    const pkg = JSON.stringify({ scripts: { p: 'pwsh -NoProfile -File build/a.ps1 logo.png', s: '. ./a.bin' } }, null, 2); // 3 不报、4 报
    const sh = lines('sh -C ./gen.sh a.png', 'node -C dev x.png', 'echo "done" . "x.png"', ''); // 1 不报、2 报、3 不报
    const { errors } = binimport(repo({ 'build/a.ps1': ps1, '.github/workflows/ci.yml': ci, 'package.json': pkg, 'build/b.sh': sh }));
    expect(where(errors).sort()).toEqual(['build/a.ps1:6', 'build/a.ps1:7', 'build/b.sh:2', 'package.json:4'].sort());
  });

  it('②网页入口：.html / .vue / .svelte 的 <script src> 是二进制扩展名 → 报；.js/.ts、<img src> → 不报', () => {
    const html = lines(
      '<!doctype html>', // 1
      '<script src="./x.png"></script>', // 2
      '<script type="module" src="./main.ts"></script>', // 3 不报
      '<img src="./logo.png">', // 4 不报
      "<script\n  defer\n  src='/a.bin'></script>", // 5-7：报在 src 所在的第 7 行
      '',
    );
    const vue = lines('<template><div /></template>', '<script src="./c.wasm"></script>', ''); // 2
    const { errors } = binimport(repo({ 'site/index.html': html, 'src/C.vue': vue, 'src/D.svelte': '<script src=./d.bin></script>\n' }));
    expect(where(errors).sort()).toEqual(['site/index.html:2', 'site/index.html:7', 'src/C.vue:2', 'src/D.svelte:1'].sort());
  });

  it('②对照：yml 的 node-version / setup-node、shell 注释和普通文字里的 node、.md 文档 → 不报', () => {
    const ci = lines(
      'jobs:',
      '  t:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with: { node-version: 22, python-version: "3.12" }',
      '      - name: python and node',
      '        run: node --version && python -V',
      '',
    );
    const { errors } = binimport(repo({ '.github/workflows/ok.yml': ci, 'docs/a.md': 'node assets/x.png\n', 'build/ok.sh': 'echo "node" > a.png\n' }));
    expect(errors).toEqual([]);
  });

  it('③骨架扫描器：if / while / for / with 的条件 `)` 后面的 / 当正则，不再吞后文', () => {
    const body = lines(
      'if (ok) /`/.test(s);', // 1：原来把 / 当除号、反引号开模板，吞掉后面所有行
      "require('./x.png');", // 2
      "if (a) /'/.test(s) && require('./y.png');", // 3：原来把 '/.test… 当字符串
      'while (f(x)) /`/.exec(s);', // 4：条件里还有括号，按配对找到 while 的那个 (
      "require('./w.bin');", // 5
      'for await (const x of y) /`/.test(x);', // 6：for await (…) 也是语句头
      "require('./v.png');", // 7
      '',
    );
    // 真除号后面的 require 照报
    const div = "const half = (a + b) / 2; const z = require('./z.bin');\n";
    const { errors } = binimport(repo({ 'lib/re.js': body, 'lib/div.js': div }));
    expect(where(errors).sort()).toEqual(['lib/div.js:1', 'lib/re.js:2', 'lib/re.js:3', 'lib/re.js:5', 'lib/re.js:7']);
  });

  it('③对照：普通 `)` 后的真除号不当正则，后面字符串和模板的引号不翻转、里面的假 import / require 不报', () => {
    const body = lines(
      'const half = (a + b) / 2;',
      "const s = \"require('./x.png')\"; const q = (c) / 3;",
      "const t = (d) / 2 + 'require(\\'./y.bin\\')';",
      '',
    );
    // tests/build/check-size.test.ts 第 29 行的写法（模板 ${…} 里的 ((n * 3) / 4)），后面隔几行再放一个模板夹具
    const checkSize = lines(
      "  const js = (n: number) => `export const x = \"${randomBytes(Math.ceil((n * 3) / 4)).toString('base64')}\";\\n`;",
      "  writeFileSync(join(d, 'assets', 'index.js'), js(entryBytes));",
      '  return d;',
      '}',
      "const fixture = `import logo from './logo.png';`;",
      '',
    );
    const round = lines(
      'const pct = Math.round(ratio * 100) / 100; const url = `/api/items/${id}`;',
      'const title = `上传失败`;',
      "const fixture = `import logo from './logo.png'`;",
      '',
    );
    const files = {
      'lib/div.js': body,
      'tests/check-size.test.ts': checkSize,
      'tests/fixture.test.ts': round,
      'tests/a.test.ts': "expect(f(a) / 2).toBe(0.5); expect(e.message).toContain(\"a/b\"); expect(m).toBe(\"import x from 'a.png'\");\n",
      // . 后面的 for 不是语句头：Symbol.for('k') / 2 是除号
      'lib/sym.ts': "const v = Symbol.for('k') / 2; const s = \"a/b\"; log(\"from 'z.png'\");\n",
      'lib/msg.ts': "const pct = (done) / total; log(\"saved to dist/\" + name, \"copied from 'logo.png'\");\n",
      'lib/url.ts': "const w = (width) / 2, base = '/assets/'; const label = 'require(\"icon.png\") 已废弃';\n",
      'lib/tpl.ts': lines(
        'const h = (a) / 2; warn("path a/b, use ` here");',
        'const ok = 1;',
        "const doc = `示例：require('./logo.png') 会被拦`;",
        'const z = `x`;',
        '',
      ),
    };
    expect(binimport(repo(files)).errors).toEqual([]);
  });

  it('④createRequire 的间接传递：对象属性、this.属性、数组解构、.then 回调、加括号、(0, …)、先存别名再调用、await import().then → 都报', () => {
    const body = lines(
      "import { createRequire } from 'node:module';", // 1
      'const o = { r: createRequire(import.meta.url) };', // 2
      "o.r('./a.png');", // 3
      'const [r2] = [createRequire(import.meta.url)];', // 4
      "r2('./b.png');", // 5
      "import('node:module').then((m) => m.createRequire(import.meta.url)).then((r3) => r3('./c.png'));", // 6
      "(createRequire)(import.meta.url)('./d.png');", // 7
      'const r4 = (createRequire)(import.meta.url);', // 8
      "r4('./e.bin');", // 9
      "(0, createRequire)(import.meta.url)('./f.png');", // 10
      'const cr = createRequire;', // 11
      "cr(import.meta.url)('./g.png');", // 12
      'const r5 = cr(import.meta.url);', // 13
      "r5('./h.png');", // 14
      "const r6 = await import('node:module').then((m) => m.createRequire(import.meta.url));", // 15
      "r6('./i.png');", // 16
      'class A { r7 = createRequire(import.meta.url); f() { this.r7(\'./j.png\'); } }', // 17
      'const cr2: typeof createRequire = createRequire;', // 18
      "cr2(import.meta.url)('./k.png');", // 19
      '',
    );
    const { errors } = binimport(repo({ 'tools/indirect.mts': body }));
    expect(where(errors)).toEqual([3, 5, 6, 7, 9, 10, 12, 14, 16, 17, 19].map((n) => `tools/indirect.mts:${n}`));
  });

  it('④对照：createRequire 的参数（基准路径）本身、别名后的参数 → 不报', () => {
    const body = lines(
      "import { createRequire } from 'node:module';",
      'const cr = createRequire;',
      "const r = cr('/tmp/base.png');",
      "const o = { r2: (createRequire)('/tmp/b.png') };",
      "r('./ok.js'); o.r2('./ok.cjs');",
      'icons[sizeOf] = createRequire(import.meta.url);', // 下标赋值，不是解构：sizeOf 不收
      "sizeOf('./a.png'); rows[0][col] = createRequire(import.meta.url); col('./b.png');",
      '',
    );
    expect(binimport(repo({ 'tools/ok.mts': body })).errors).toEqual([]);
  });

  it('真仓库：BINIMPORT 0 个错误', { timeout: 60_000 }, () => {
    expect(binimport(ROOT).errors).toEqual([]);
  });
});
