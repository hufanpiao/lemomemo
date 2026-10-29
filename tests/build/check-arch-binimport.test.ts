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
    const script = [
      'import importlib.util, pathlib, sys, time',
      'spec = importlib.util.spec_from_file_location("check_arch", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
      'errors = []; t = time.perf_counter()',
      'mod.check_binimport(pathlib.Path(sys.argv[2]), errors)',
      'print(time.perf_counter() - t)',
    ].join('\n');
    const seconds = Number(execFileSync('python', ['-I', '-c', script, join(ROOT, 'build', 'check_arch.py'), root], { encoding: 'utf8' }));
    expect(seconds).toBeLessThan(5);
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

  it('真仓库：BINIMPORT 0 个错误', { timeout: 60_000 }, () => {
    expect(binimport(ROOT).errors).toEqual([]);
  });
});
