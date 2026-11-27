// LINT-binimport（build/check_arch.py BINIMPORT，实现在 build/check_binimport.mjs）：正则与除号不打乱扫描、④createRequire 的间接传递、
// 深嵌套和大文件（耗时上限、解析器栈溢出时整个文件按可疑报）。
// 11-14 CI-10：原 check-arch-binimport-scanner.test.ts（③④）改名为本文件，并进原 check-arch-binimport-perf.test.ts 的耗时与健壮性用例；
// 换成 AST 以后“骨架扫描器把 / 当正则还是除号”不再是手写逻辑，③那几条留作对照（解析器认对了就不会吞后文）
// 共用的拼仓库、跑 check_arch、计时在 check-arch-binimport-harness.ts；每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { afterEach, describe, expect, it } from 'vitest';
import { binimport, cleanupDirs, lines, repo, timed, where } from './check-arch-binimport-harness.ts';

afterEach(cleanupDirs);

describe('build/check_arch.py BINIMPORT（LINT-binimport）', () => {
  it('③正则字面量：if / while / for / with 的条件 `)` 后面的 /`/ 是正则，不吞后文', () => {
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

  // ---- 耗时上限与健壮性（原 check-arch-binimport-perf.test.ts） ----

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

  it('模板 ${…} 嵌套 1000 层、2 万层：不崩，解析器栈溢出时整个文件按可疑报（报在第 1 行），5 秒内跑完', () => {
    const deep = `// head\nconst s = ${'`${'.repeat(1000)}require('./x.png')${'}`'.repeat(1000)};\nrequire('./y.bin');\n`;
    const { code, errors } = binimport(repo({ 'lib/deep.js': deep }));
    expect(code).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    const huge = timed(repo({ 'lib/deep.js': `// head\nconst s = ${'`${'.repeat(20_000)}require('./x.png')${'}`'.repeat(20_000)};\n` }));
    expect(huge.seconds).toBeLessThan(5);
    expect(huge.errors.length).toBeGreaterThan(0);
  });

  it('400 个约 4090 字、满是 ${ 却没有 } 的 require 目标：check_binimport 5 秒内跑完（${…} 替换线性扫描），扩展名照常核对', () => {
    const spec = (ext: string) => `./${'${'.repeat(2044)}${ext}`;
    const body = `${Array.from({ length: 400 }, () => `require('${spec('.js')}');`).join('\n')}\nrequire('${spec('.png')}');\n`;
    const { seconds, errors } = timed(repo({ 'lib/dollar.js': body }));
    expect(seconds).toBeLessThan(5);
    expect(errors).toEqual(['lib/dollar.js:401']);
  });

  it('②package.json：未闭合的 2 万个 "scripts":{（解析不了、不报不崩）、2 万条 scripts 各一处命中，check_binimport 各 5 秒内跑完、条条报（含起 node、载入 typescript；全量并发时约 2.4 秒）', () => {
    const unclosed = timed(repo({ 'package.json': '"scripts":{'.repeat(20_000) }));
    expect(unclosed.seconds).toBeLessThan(5);
    const body = JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`s${i}`, '. ./a.bin'])) });
    const many = timed(repo({ 'package.json': body }));
    expect(many.seconds).toBeLessThan(5);
    expect(many.errors.length).toBe(20_000);
  });

  it('长空白不回溯：单行 4 万个空格（.sh、yml 的 run: 后面）、createRequire 后跟 4 万个空格，check_binimport 各 5 秒内跑完（含起 node、载入 typescript）', () => {
    const sp = ' '.repeat(40_000);
    const cases: Record<string, string> = {
      'build/a.sh': `${sp}x\n`,
      'a.yml': `run:${sp}x\n- ${sp}x\n${sp}x\n`,
      'lib/a.mjs': `createRequire${sp}x\n`, // 绑定规则里 createRequire 后面的 \s*\)?\s*\(
      'lib/b.mjs': `createRequire; const cr = createRequire${sp}x\n`, // 别名规则的否定前瞻
      'lib/c.mjs': `createRequire(u).then(${sp}x\n`, // .then 回调参数前的空白
    };
    for (const [rel, body] of Object.entries(cases)) {
      const { seconds } = timed(repo({ [rel]: body }));
      expect(seconds, rel).toBeLessThan(5);
    }
  });

  it('②取词耗时：200 万字单行的 node "a" 重复、未闭合引号、\\" 三种，check_binimport 各 5 秒内跑完（行尾按换行位置二分，find 限在行内；本机约 1 秒、CI 约 2.1 秒，平方写法本机约 5.3 秒、CI 10 秒以上）；200 万字 / 100 万字耗时比 < 3（预热一次后各量 3 次取最小再比）', () => {
    const B = '\\';
    for (const unit of ['node "a" ', 'node "a ', `node ${B}"a `]) {
      const { seconds } = timed(repo({ 'build/a.sh': `${unit.repeat(Math.floor(2_000_000 / unit.length))}\n` }));
      expect(seconds, unit).toBeLessThan(5);
    }
    // 倍率：输入翻倍，线性约 2 倍、平方约 4 倍；不受机器快慢影响。阈值 3 取两者正中，不变
    // 抗抖动：两个规模的仓库各拼一次，先空跑一次预热，再交替各量 3 次取最小值（最小值最接近真实耗时，CI 偶发的慢一次被剔掉）
    const root = (n: number) => repo({ 'build/a.sh': `${'node "a" '.repeat(Math.floor(n / 9))}\n` });
    const big = root(2_000_000);
    const small = root(1_000_000);
    timed(small);
    const runs: Record<'big' | 'small', number[]> = { big: [], small: [] };
    for (let i = 0; i < 3; i++) {
      runs.small.push(timed(small).seconds);
      runs.big.push(timed(big).seconds);
    }
    const ratio = Math.min(...runs.big) / Math.min(...runs.small);
    const detail = `200 万字 / 100 万字耗时比 ${ratio.toFixed(2)}（各 3 次取最小；200 万字 ${runs.big.map((s) => s.toFixed(2)).join('/')} 秒，100 万字 ${runs.small.map((s) => s.toFixed(2)).join('/')} 秒）`;
    expect(ratio, detail).toBeLessThan(3);
    // 这条跑 10 次 check_binimport（本机约 10 秒、CI 约 20 秒），不吃默认的 30 秒，单独给 90 秒
  }, 90_000);
});
