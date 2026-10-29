// LINT-binimport（build/check_arch.py BINIMPORT）：耗时上限与健壮性——超长行、深嵌套、大量报错、长空白、取词都不退化成平方
// 从 check-arch-binimport.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 共用的拼仓库、跑 check_arch、计时在 check-arch-binimport-harness.ts；每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { afterEach, describe, expect, it } from 'vitest';
import { binimport, cleanupDirs, repo, timed, where } from './check-arch-binimport-harness.ts';

afterEach(cleanupDirs);

describe('build/check_arch.py BINIMPORT（LINT-binimport）', () => {
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

  it('②package.json 的 "scripts" 范围一遍算完：2 万个未闭合的 "scripts":{、2 万个范围 × 2 万个命中，check_binimport 各 2 秒内跑完', () => {
    const unclosed = timed(repo({ 'package.json': '"scripts":{'.repeat(20_000) }));
    expect(unclosed.seconds).toBeLessThan(2);
    const body = `{${Array.from({ length: 20_000 }, () => '"scripts":{"a": ". ./a.bin"}').join(',')}}\n`;
    const many = timed(repo({ 'package.json': body }));
    expect(many.seconds).toBeLessThan(2);
    expect(many.errors.length).toBe(20_000);
  });

  it('长空白不回溯：单行 4 万个空格（.sh、Makefile、yml 的 run: / “- ” 后面）、createRequire 后跟 4 万个空格，check_binimport 各 0.5 秒内跑完', () => {
    const sp = ' '.repeat(40_000);
    const cases: Record<string, string> = {
      'build/a.sh': `${sp}x\n`,
      Makefile: `${sp}x\n`,
      'a.yml': `run:${sp}x\n- ${sp}x\n${sp}x\n`,
      'lib/a.mjs': `createRequire${sp}x\n`, // 绑定规则里 createRequire 后面的 \s*\)?\s*\(
      'lib/b.mjs': `createRequire; const cr = createRequire${sp}x\n`, // 别名规则的否定前瞻
      'lib/c.mjs': `createRequire(u).then(${sp}x\n`, // .then 回调参数前的空白
    };
    for (const [rel, body] of Object.entries(cases)) {
      const { seconds } = timed(repo({ [rel]: body }));
      expect(seconds, rel).toBeLessThan(0.5);
    }
  });

  it('②取词耗时：200 万字单行的 node "a" 重复、未闭合引号、\\" 三种，check_binimport 各 5 秒内跑完（行尾按换行位置二分，find 限在行内；本机约 1 秒、CI 约 2.1 秒，平方写法本机约 5.3 秒、CI 10 秒以上）', () => {
    const B = '\\';
    for (const unit of ['node "a" ', 'node "a ', `node ${B}"a `]) {
      const { seconds } = timed(repo({ 'build/a.sh': `${unit.repeat(Math.floor(2_000_000 / unit.length))}\n` }));
      expect(seconds, unit).toBeLessThan(5);
    }
    // 倍率：输入翻倍，线性约 2 倍、平方约 4 倍；不受机器快慢影响
    const at = (n: number) => timed(repo({ 'build/a.sh': `${'node "a" '.repeat(Math.floor(n / 9))}\n` })).seconds;
    const ratio = at(2_000_000) / at(1_000_000);
    expect(ratio, `200 万字 / 100 万字耗时比 ${ratio.toFixed(2)}`).toBeLessThan(3);
  });
});
