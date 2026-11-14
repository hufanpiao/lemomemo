// LINT-binimport（build/check_arch.py BINIMPORT，实现在 build/check_binimport.mjs）：②非 JS 入口里“命令 + 二进制扩展名路径”
// 扫的入口（11-14 CI-10 按本仓库实际调 node、python、pwsh 的几处收窄；同日整块评审补上根目录 deno.json / deno.jsonc 的 tasks、
// JS/TS 里属性名是 command 的字符串）：package.json 根对象的 scripts、.yml / .yaml 的 run:、
// .sh / .bash、.ps1 / .psm1、.html 的 <script src>。不再扫（仓库里没有，或不是从这几处调解释器）：Makefile、.py 的 os.system、
// .bat / .cmd、无扩展名的 shebang 脚本和 .husky、.vue / .svelte、GitLab 式 script: / before_script: / command: 列表——以后加了这类入口要在 mjs 里补。
// 原 check-arch-binimport-source.test.ts（点号 source、反斜杠续行）11-14 并进本文件
// 共用的拼仓库、跑 check_arch 在 check-arch-binimport-harness.ts；每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { afterEach, describe, expect, it } from 'vitest';
import { binimport, cleanupDirs, lines, repo, where } from './check-arch-binimport-harness.ts';

afterEach(cleanupDirs);

describe('build/check_arch.py BINIMPORT（LINT-binimport）', () => {
  it('②package.json scripts、CI 的 run:、.sh 里“命令 + 二进制扩展名路径” → 报；执行的是 .mjs、.sh 的不报', () => {
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
      '      - uses: actions/setup-node@v4', // 4
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
    const { errors } = binimport(repo({ 'package.json': pkg, '.github/workflows/ci.yml': ci, 'build/a.sh': sh }));
    expect(where(errors).sort()).toEqual(
      [
        'package.json:3', 'package.json:5', 'package.json:6', 'package.json:7', 'package.json:8',
        '.github/workflows/ci.yml:7', '.github/workflows/ci.yml:10',
        'build/a.sh:2', 'build/a.sh:5',
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

  it('②PowerShell 的命令名不分大小写：PWSH -FILE、PowerShell.EXE -File → 报', () => {
    const ps1 = lines('PWSH -FILE ./x.png', 'PowerShell.EXE -File ./y.bin', 'Pwsh -File ok.ps1 -Icon a.png', ''); // 1、2 报，3 不报
    expect(where(binimport(repo({ 'build/a.ps1': ps1 })).errors)).toEqual(['build/a.ps1:1', 'build/a.ps1:2']);
  });

  it('②网页入口：.html 的 <script src> 是二进制扩展名 → 报（跨行的报在 src 那一行）；.js/.ts、<img src> → 不报', () => {
    const html = lines(
      '<!doctype html>', // 1
      '<script src="./x.png"></script>', // 2
      '<script type="module" src="./main.ts"></script>', // 3 不报
      '<img src="./logo.png">', // 4 不报
      "<script\n  defer\n  src='/a.bin'></script>", // 5-7：报在 src 所在的第 7 行
      '<script src=./d.bin></script>', // 8 不带引号
      '',
    );
    const { errors } = binimport(repo({ 'site/index.html': html }));
    expect(where(errors).sort()).toEqual(['site/index.html:2', 'site/index.html:7', 'site/index.html:8'].sort());
  });

  it('②对照：yml 的 node-version / setup-node、run: 里只查版本、shell 注释和普通文字里的 node、.md 文档 → 不报', () => {
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
    const { errors } = binimport(repo({ '.github/workflows/ok.yml': ci, 'docs/a.md': 'node assets/x.png\n', 'build/ok.sh': 'echo "node" > a.png\n# node x.png\n' }));
    expect(errors).toEqual([]);
  });

  it('②点号 source 的命令开头位置：then / do / else / { / 反引号 / $( / && 之后 / sh -c、bash -c、zsh -c、dash -c 的引号里 → 报；普通文字里的点 → 不报', () => {
    const sh = lines(
      'if [ -f x ]; then . ./a.bin; fi', // 1
      'if [ -f x ]; then', // 2
      '  . ./b.bin', // 3
      'fi', // 4
      'true && . ./c.bin', // 5
      'x=`. ./d.bin`', // 6
      'y=$( . ./e.bin )', // 7
      '{ . ./f.bin; }', // 8
      'for i in 1; do . ./g.bin; done', // 9
      "sh -c '. ./h.bin'", // 10
      'bash -c ". ./i.bin"', // 11
      'echo a: . b.png', // 12 不报
      'if a; then x; else . ./j.bin; fi', // 13
      'echo then . k.png', // 14 不报：then 只是 echo 的参数（前面不是命令开头）
      "zsh -c '. ./z.bin'", // 15
      'dash -c ". ./d.bin"', // 16
      '',
    );
    const yml = lines('steps:', '  - run: . ./a.bin', '  - run: |', '      . ./b.bin', "  - name: 'note: . c.png'", '  - name: x', '    run: . ./d.bin', ''); // 2、4、7
    const pkg = '{"scripts": {"a": ". ./a.bin", "b":". ./b.bin", "c": "x && . ./c.bin", "d": "echo a: . d.png"}}\n';
    const { errors } = binimport(repo({ 'build/b.sh': sh, 'a.yml': yml, 'package.json': pkg }));
    const got = where(errors);
    expect(got.filter((w) => w.startsWith('build/b.sh')).sort()).toEqual(
      [1, 3, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16].map((n) => `build/b.sh:${n}`).sort(),
    );
    expect(got.filter((w) => w.startsWith('a.yml')).sort()).toEqual(['a.yml:2', 'a.yml:4', 'a.yml:7']);
    // 同一行里的三条（a、b、c）各报一次；d 是 echo 的文字，不报
    expect(errors.filter((e) => e.file === 'package.json').map((e) => /：(\S+?)（/.exec(e.message)?.[1])).toEqual(['./a.bin', './b.bin', './c.bin']);
  });

  it('②点号 source 的误判：-c 只认 sh 系、点号后面第一个词是 - 开头就停、( 只认 $(、YAML 只认 run:、JSON 只认根对象第一层 scripts 里的值 → 不报', () => {
    const sh = lines(
      'cp a.b c.d',
      'cd ../x && ls',
      './x.png',
      'cp $(pwd)/. x.png',
      "find . -name '*.png'",
      'find . x.png',
      'arr=( . a.png )',
      "grep -c '. x.png' log.txt",
      "git -c '. x.png'",
      'tar -c . logo.png',
      'echo {a,b} . x.png',
      'rsync -a ./ dest; . ./ok.sh',
      '. -x a.png',
      '- . ./x.bin', // 只在 YAML 列表里才是命令开头，sh 里不是
      '@. ./y.bin', // @ 前缀只在 Makefile 里有意义
      '',
    );
    const yml = lines(
      'args: . -o report.png',
      'working-directory: .',
      'paths:',
      '  - . ',
      '  - dist/logo.png',
      'description: . logo.png 是图标',
      'cache:',
      '  - . ./no.bin',
      '',
    );
    const pkg = '{"files": [". ", "logo.png"], "x": ". logo.png", "y": {"cwd": "."}, "config": {"scripts": {"b": ". ./b.bin"}}, "scripts2": {"d": ". ./d.bin"}, "scripts": {"ok": "node a.mjs"}}\n';
    expect(binimport(repo({ 'build/c.sh': sh, 'a.yml': yml, 'package.json': pkg })).errors).toEqual([]);
  });

  it('②反斜杠：续行 \\ 接着读下一行、a\\ b 算一个词、JSON 里的 \\"…\\" 取到里面的路径', () => {
    const B = '\\';
    const sh = lines(
      `node scripts/gen.mjs ${B}`, // 1 不报：续行后是 gen.mjs 的参数
      '  --out logo.png', // 2
      `node ${B}`, // 3
      '  scripts/gen.mjs logo.png', // 4 不报
      `node ${B}`, // 5
      '  assets/x.png', // 6 报（续行后的真目标，报在路径所在的第 6 行）
      `node my${B} script.mjs a.png`, // 7 不报：文件名是“my script.mjs”
      `node assets/a${B} b.png`, // 8 报：文件名是“a b.png”
      `convert in${B} 1.png out.png`, // 9 不报：不是命令词
      `python C:${B}tools${B}x.py a.png`, // 10 不报
      `python C:${B}tools${B}x.bin`, // 11 报
      `node x.mjs ${B}`, // 12 不报
      '  a.png', // 13
      '',
    );
    const pkg = [
      '{ "scripts": {',
      `  "a": "node ${B}"scripts/gen.mjs${B}" logo.png",`, // 2 不报
      `  "b": "node ${B}"assets/x.png${B}"",`, // 3 报
      `  "c": "node scripts${B}${B}gen.mjs logo.png",`, // 4 不报
      `  "d": "node assets${B}${B}x.png"`, // 5 报
      '} }',
      '',
    ].join('\n');
    const yml = lines('jobs:', '  t:', '    steps:', `      - run: node scripts/gen.mjs ${B}`, '          logo.png', ''); // 不报
    const { errors } = binimport(repo({ 'build/a.sh': sh, 'package.json': pkg, '.github/workflows/a.yml': yml }));
    expect(where(errors).sort()).toEqual(['build/a.sh:11', 'build/a.sh:6', 'build/a.sh:8', 'package.json:3', 'package.json:5'].sort());
    expect(errors.find((e) => e.file === 'build/a.sh' && e.line === 8)?.message).toContain('a b.png');
  });
});

describe('11-14 整块评审：根目录 deno.json / deno.jsonc 的 tasks、JS/TS 里属性名是 command 的字符串（原来不扫）', () => {
  it('deno.json 的 tasks（字符串、{ command }）、deno.jsonc（注释、尾逗号）→ 报；子目录的 deno.json、执行 .ts 的不报', () => {
    // { command } 对象用 fromEntries 拼：直接写 command: '…' 本文件自己就会被真仓库那条用例报出来
    const task = Object.fromEntries([['command', 'node tools/y.bin'], ['description', 'x']]);
    const deno = JSON.stringify({ tasks: { a: 'deno run ./x.png', b: task, c: 'deno run tools/ok.ts' } }, null, 2);
    const jsonc = lines('{', '  // 注释', '  "tasks": {', '    "d": "python3 tools/z.bin",', '  },', '}', '');
    const { errors } = binimport(repo({ 'deno.json': deno, 'sub/deno.json': deno }));
    expect(where(errors).sort()).toEqual(['deno.json:3', 'deno.json:4']);
    expect(errors[0]?.message).toContain('命令 deno');
    expect(where(binimport(repo({ 'deno.jsonc': jsonc })).errors)).toEqual(['deno.jsonc:4']);
  });

  it('playwright 式的 webServer.command（普通字符串、模板、引号键）→ 报；不是 command 键、执行 .ts 的不报', () => {
    const cfg = lines(
      'export default {',
      "  webServer: [{ command: 'node tests/e2e/fake.png' },", // 2
      '    { command: `npm run build && node ${dir}/serve.bin --port ${PORT}` },', // 3
      "    { 'command': 'python3 x.bin' },", // 4
      "    { command: 'node tests/e2e/fake-backends.ts', name: 'node a.png' }],", // 5 不报
      '};',
      '',
    );
    const { errors } = binimport(repo({ 'playwright.config.ts': cfg }));
    expect(where(errors)).toEqual(['playwright.config.ts:2', 'playwright.config.ts:3', 'playwright.config.ts:4']);
    expect(errors[1]?.message).toContain('serve.bin');
  });
});
