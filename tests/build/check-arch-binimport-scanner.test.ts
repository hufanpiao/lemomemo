// LINT-binimport（build/check_arch.py BINIMPORT）：③骨架扫描器（条件括号后的 / 当正则、真除号不当）、④createRequire 的间接传递
// 从 check-arch-binimport.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 共用的拼仓库、跑 check_arch、计时在 check-arch-binimport-harness.ts；每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { afterEach, describe, expect, it } from 'vitest';
import { binimport, cleanupDirs, lines, repo, where } from './check-arch-binimport-harness.ts';

afterEach(cleanupDirs);

describe('build/check_arch.py BINIMPORT（LINT-binimport）', () => {
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
});
