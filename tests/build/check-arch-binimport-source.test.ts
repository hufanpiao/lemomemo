// LINT-binimport（build/check_arch.py BINIMPORT）：②点号 source（. 脚本）的命令开头位置、反斜杠续行、误判与照报的边界
// 从 check-arch-binimport.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 共用的拼仓库、跑 check_arch、计时在 check-arch-binimport-harness.ts；每条用例在临时目录现拼一棵迷你仓库（不是 git 仓库，check_arch 整棵树扫）
import { afterEach, describe, expect, it } from 'vitest';
import { binimport, cleanupDirs, lines, repo, where } from './check-arch-binimport-harness.ts';

afterEach(cleanupDirs);

describe('build/check_arch.py BINIMPORT（LINT-binimport）', () => {
  it('②点号 source 的命令开头位置：then / do / else / { / ( / 反引号 / $( / sh -c 和 bash -c 的引号里 / Makefile 的 @、- 前缀 → 报；普通文字里的点 → 不报', () => {
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
      '',
    );
    const make = lines('all:', '\t. ./env.bin && node x.mjs', '\t@. ./env2.bin', '\t-. ./env3.bin', ''); // 2、3、4
    const yml = lines('steps:', '  - run: . ./a.bin', '  - run: |', '      . ./b.bin', "  - name: 'note: . c.png'", '  - name: x', '    run: . ./d.bin', ''); // 2、4、7
    const pkg = '{"scripts": {"a": ". ./a.bin", "b":". ./b.bin", "c": "x && . ./c.bin", "d": "echo a: . d.png"}}\n';
    const { errors } = binimport(repo({ 'build/b.sh': sh, Makefile: make, 'a.yml': yml, 'package.json': pkg }));
    const got = where(errors);
    expect(got.filter((w) => w.startsWith('build/b.sh')).sort()).toEqual(
      [1, 3, 5, 6, 7, 8, 9, 10, 11, 13].map((n) => `build/b.sh:${n}`).sort(),
    );
    expect(got.filter((w) => w.startsWith('Makefile')).sort()).toEqual(['Makefile:2', 'Makefile:3', 'Makefile:4']);
    expect(got.filter((w) => w.startsWith('a.yml')).sort()).toEqual(['a.yml:2', 'a.yml:4', 'a.yml:7']);
    // 同一行里的三条（a、b、c）各报一次；d 是 echo 的文字，不报
    expect(errors.filter((e) => e.file === 'package.json').map((e) => /：(\S+?)（/.exec(e.message)?.[1])).toEqual(['./a.bin', './b.bin', './c.bin']);
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

  it('②点号 source 的误判：-c 只认 sh/bash/zsh/dash、点号后面第一个词是 - 开头就停、( 只认 $(、YAML 只认命令类键、JSON 只认 scripts 里的值 → 不报', () => {
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
      '',
    );
    const yml = lines(
      'args: . -o report.png',
      'working-directory: .',
      'paths:',
      '  - . ',
      '  - dist/logo.png',
      'description: . logo.png 是图标',
      '',
    );
    const pkg = '{"files": [". ", "logo.png"], "x": ". logo.png", "y": {"cwd": "."}, "scripts": {"ok": "node a.mjs"}}\n';
    expect(binimport(repo({ 'build/c.sh': sh, 'a.yml': yml, 'package.json': pkg })).errors).toEqual([]);
  });

  it('②点号 source 照报：YAML 的 run / script / before_script / command 和 script 列表、JSON 的 scripts 里的值、zsh -c / dash -c 的引号里', () => {
    const yml = lines(
      'script:', // 1
      '  - . ./x.bin', // 2
      'before_script:', // 3
      '  - . ./y.bin', // 4
      'steps:', // 5
      '  - run: . ./a.bin', // 6
      '    command: . ./b.bin', // 7
      '',
    );
    const pkg = '{"x": ". logo.png", "scripts": {"a": ". ./a.bin", "b": "x && . ./c.bin"}}\n';
    const sh = lines("zsh -c '. ./z.bin'", 'dash -c ". ./d.bin"', '');
    const { errors } = binimport(repo({ '.gitlab-ci.yml': yml, 'package.json': pkg, 'build/s.sh': sh }));
    expect(where(errors).sort()).toEqual(
      ['.gitlab-ci.yml:2', '.gitlab-ci.yml:4', '.gitlab-ci.yml:6', '.gitlab-ci.yml:7', 'build/s.sh:1', 'build/s.sh:2', 'package.json:1', 'package.json:1'].sort(),
    );
    expect(errors.filter((e) => e.file === 'package.json').map((e) => /：(\S+?)（/.exec(e.message)?.[1])).toEqual(['./a.bin', './c.bin']);
  });

  it('②点号 source：JSON 只认根对象第一层的 "scripts"、YAML 的 “- ” 列表项只认命令类键下面的、@ 和 - 前缀只认 Makefile', () => {
    const pkg = '{"scripts": {"a": "x"}, "config": {"scripts": {"b": ". ./b.bin"}}, "c": ". ./c.bin", "scripts2": {"d": ". ./d.bin"}}\n';
    const yml = lines(
      'files:', // 1
      '  - . logo.png', // 2 不报
      '  - .  icons/a.png', // 3 不报
      'paths:', // 4
      '  - . ', // 5 不报
      'script:', // 6
      '  - . ./env.bin', // 7 报
      '  # 注释', // 8
      '  - echo ok && . ./e2.bin', // 9 报（&& 之后）
      'after_script:', // 10
      '- . ./same-indent.bin', // 11 报：列表项和键同一缩进
      'cache:', // 12
      '  - . ./no.bin', // 13 不报：cache 不是命令类键
      'job:', // 14
      '  script:', // 15
      '    - . ./nested.bin', // 16 报
      '  artifacts:', // 17
      '    - . ./art.png', // 18 不报
      '',
    );
    const sh = lines('- . ./x.bin', '@. ./y.bin', '', ''); // sh 里不是命令开头 → 不报
    const { errors } = binimport(repo({ 'package.json': pkg, '.gitlab-ci.yml': yml, 'build/a.sh': sh }));
    expect(where(errors).sort()).toEqual(['.gitlab-ci.yml:11', '.gitlab-ci.yml:16', '.gitlab-ci.yml:7', '.gitlab-ci.yml:9']);
  });
});
