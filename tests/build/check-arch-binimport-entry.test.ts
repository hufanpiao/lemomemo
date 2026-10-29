// LINT-binimport（build/check_arch.py BINIMPORT）：①读文件再执行（eval、vm、dlopen…）、②非 JS 入口（package.json scripts、CI yml、
// .sh、.py、Makefile、PowerShell、网页 <script src>）里“命令 + 二进制扩展名路径”
// 从 check-arch-binimport.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 共用的拼仓库、跑 check_arch、计时在 check-arch-binimport-harness.ts；每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { afterEach, describe, expect, it } from 'vitest';
import { binimport, cleanupDirs, lines, repo, where } from './check-arch-binimport-harness.ts';

afterEach(cleanupDirs);

describe('build/check_arch.py BINIMPORT（LINT-binimport）', () => {
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

  it('②PowerShell 的命令名不分大小写：PWSH -FILE、PowerShell.EXE -File → 报', () => {
    const ps1 = lines('PWSH -FILE ./x.png', 'PowerShell.EXE -File ./y.bin', 'Pwsh -File ok.ps1 -Icon a.png', ''); // 1、2 报，3 不报
    expect(where(binimport(repo({ 'build/a.ps1': ps1 })).errors)).toEqual(['build/a.ps1:1', 'build/a.ps1:2']);
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
});
