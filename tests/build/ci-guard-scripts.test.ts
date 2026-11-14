// 工作流共用的三个小检查脚本（第三方审查 CI-8：原来是 shell 副本散在 release-build、desktop、ai-eval 里）：在临时目录里直接用 bash 真跑正反例，
// 再钉住 release-build.yml、desktop.yml 调了它们。
// • build/ci/no-hidden-files.sh：要上传的目录里不许有点开头的文件（哪一步调它由 workflow-permissions.test.ts 的 checkUploads 核）
// • build/ci/no-source-map.sh：页面产物里不许有 .map、不许有 sourceMappingURL
// • build/ci/tag-on-main.sh：tag 对应的提交必须在 origin/main 上（临时仓库里用 update-ref 造 origin/main；git 配置隔离，不读本机的全局配置）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runOf, workflowSteps } from './workflow-steps.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const CI = join(ROOT, 'build', 'ci');
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';

/** 在新的临时目录里先 make(目录)，再在那里跑 build/ci/<script> args；返回退出码和全部输出。
 *  fakes：{ 命令名: 脚本正文 }，写进临时目录的 fake-bin/ 并排在 PATH 最前面（造 grep 出错、没有 deno 的环境） */
function run(script: string, args: string[], make: (d: string) => void = () => {}, fakes: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'lemo-ci-guard-'));
  try {
    make(d);
    const bin = join(d, 'fake-bin');
    mkdirSync(bin);
    for (const [name, body] of Object.entries(fakes)) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // Git for Windows 的 bin/bash.exe 启动时会把 /usr/bin 插到 PATH 最前，从外面排在前面的假命令会被盖掉：
    // 进了 bash 再把 fake-bin（换成 /c/… 形式）排到最前，然后 exec 真脚本
    const fakeBin = process.platform === 'win32' ? bin.replace(/^([A-Za-z]):/, (_, c: string) => `/${c.toLowerCase()}`).replaceAll('\\', '/') : bin;
    const argv = Object.keys(fakes).length
      ? ['--noprofile', '--norc', '-c', 'PATH="$FAKE_BIN:$PATH"; exec bash --noprofile --norc "$@"', '_', join(CI, script), ...args]
      : ['--noprofile', '--norc', join(CI, script), ...args];
    const r = spawnSync(BASH ?? 'bash', argv, { cwd: d, encoding: 'utf8', env: { PATH: process.env.PATH, FAKE_BIN: fakeBin } });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe.skipIf(!BASH)('no-hidden-files.sh（在临时目录里真跑）', () => {
  const hidden = (make: (out: string) => void) => run('no-hidden-files.sh', ['out/'], (d) => make(join(d, 'out')));
  it('没有点开头的文件（嵌套、带空格的文件名）：通过；目录名末尾的 / 不影响', () => {
    const r = hidden((o) => {
      mkdirSync(join(o, 'a b', 'c'), { recursive: true });
      writeFileSync(join(o, 'a b', 'c', 'x y.exe'), '1');
      writeFileSync(join(o, 'latest.json'), '{}');
    });
    expect(r.code, r.out).toBe(0);
  });
  it('嵌套目录里、带空格的点开头文件：失败，错误注解只写数量，列表在日志里', () => {
    const r = hidden((o) => {
      mkdirSync(join(o, 'a b', '.cache'), { recursive: true });
      writeFileSync(join(o, 'a b', '.cache', 'k'), '1');
      writeFileSync(join(o, '.x y'), '1');
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::out 里有 2 个点开头的文件或目录');
    expect(r.out).toContain('out/a b/.cache');
    expect(r.out).toContain('out/.x y');
    const err = r.out.split('\n').find((l) => l.startsWith('::error::')) ?? '';
    expect(err).not.toContain('.cache');
  });
  it.skipIf(process.platform === 'win32')('带换行的点开头文件名：按一个算，照样失败', () => {
    const r = hidden((o) => {
      mkdirSync(o);
      writeFileSync(join(o, '.a\nb'), '1');
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::out 里有 1 个点开头的文件或目录');
  });
  // Windows 上建符号链接要特权（EPERM），只在 Linux / macOS 上跑（CI 是 ubuntu）
  it.skipIf(process.platform === 'win32')('符号链接指向的目录里有点开头的文件：find -L 跟进去，失败', () => {
    const r = hidden((o) => {
      const real = join(o, '..', 'real');
      mkdirSync(real);
      writeFileSync(join(real, '.secret'), '1');
      mkdirSync(o);
      symlinkSync(real, join(o, 'link'));
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('out/link/.secret');
  });
  it('目录不存在、没给目录：失败（不放行）', () => {
    expect(hidden(() => {}).code).not.toBe(0);
    expect(run('no-hidden-files.sh', []).code).not.toBe(0);
  });
  // 11-14 整块评审：多行 path: | 的上传要一次查几个路径；if-no-files-found: ignore 的上传配 --allow-missing
  it('多个路径（目录、文件）：任一个里有点开头的就失败，数量合计；都干净才通过', () => {
    const make = (dirty: boolean) => (d: string) => {
      mkdirSync(join(d, 'a', 'x'), { recursive: true });
      mkdirSync(join(d, 'b'));
      writeFileSync(join(d, 'b', 'f.txt'), '1');
      writeFileSync(join(d, 'one.ts'), '1');
      if (dirty) {
        writeFileSync(join(d, 'a', 'x', '.k'), '1');
        writeFileSync(join(d, 'b', '.env.example'), '1');
      }
    };
    expect(run('no-hidden-files.sh', ['a/', 'b', 'one.ts'], make(false)).code).toBe(0);
    const r = run('no-hidden-files.sh', ['a/', 'b', 'one.ts'], make(true));
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::a b one.ts 里有 2 个点开头的文件或目录');
    expect(r.out).toContain('a/x/.k');
    expect(r.out).toContain('b/.env.example');
  });
  it('--allow-missing：不存在的路径跳过、存在的照查；不带时缺一个就失败；只写 --allow-missing 不写路径退出 2', () => {
    const make = (d: string) => {
      mkdirSync(join(d, 'rep'));
      writeFileSync(join(d, 'rep', '.hidden'), '1');
    };
    expect(run('no-hidden-files.sh', ['--allow-missing', 'gone/', 'gone2'], make).code).toBe(0);
    const r = run('no-hidden-files.sh', ['--allow-missing', 'gone', 'rep/'], make);
    expect(r.code).toBe(1);
    expect(r.out).toContain('rep/.hidden');
    expect(run('no-hidden-files.sh', ['rep', 'gone'], (d) => mkdirSync(join(d, 'rep'))).code).not.toBe(0);
    expect(run('no-hidden-files.sh', ['--allow-missing']).code).toBe(2);
  });
});

describe.skipIf(!BASH)('no-source-map.sh（在临时目录里真跑）', () => {
  const web = (files: Record<string, string>) =>
    run('no-source-map.sh', ['web'], (d) => {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(join(d, 'web', f, '..'), { recursive: true });
        writeFileSync(join(d, 'web', f), body);
      }
    });
  it('没有 .map、JS 里没有 sourceMappingURL：通过（CSS 里的注释不管）', () => {
    const r = web({ 'app/assets/a.js': 'console.log(1)', 'app/assets/a.css': '/*# sourceMappingURL=a.css.map */' });
    expect(r.code, r.out).toBe(0);
  });
  it('嵌套目录里有 .map 文件、或 JS 末尾带 sourceMappingURL：失败', () => {
    for (const files of [{ 'app/assets/deep/a.js.map': '{}' }, { 'app/assets/a.js': 'x\n//# sourceMappingURL=a.js.map' }]) {
      const r = web(files);
      expect(r.code, JSON.stringify(files)).toBe(1);
      expect(r.out).toContain('::error::web 里有 source map');
    }
  });
  it('目录不存在：失败（不放行）', () => {
    const r = run('no-source-map.sh', ['web']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('web 不存在');
  });
  // 11-14 整块评审：原来 find … | grep -q . 在 pipefail 下，.map 多到 find 的输出超过管道缓冲时 find 挨 SIGPIPE、管道按失败算，反而放行
  it('大量 .map 文件（find 的输出远超管道缓冲）：照样失败', () => {
    const r = run('no-source-map.sh', ['web'], (d) => {
      const dir = join(d, 'web', 'app', 'assets', 'a'.repeat(60));
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 1500; i += 1) writeFileSync(join(dir, `${'chunk-'.repeat(8)}${i}.js.map`), '');
    });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('::error::web 里有 source map');
  });
  it('grep 出错（退出码 2）：失败、不当成“没有 sourceMappingURL”放行', () => {
    const r = run('no-source-map.sh', ['web'], (d) => {
      mkdirSync(join(d, 'web'));
      writeFileSync(join(d, 'web', 'a.js'), 'x');
    }, { grep: 'exit 2' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('grep 出错（退出码 2）');
    expect(r.out).not.toContain('里没有 source map');
  });
});

// deno-frozen-lock.sh 里“_shared/gen/ 是空的”那一行（11-14 整块评审，同一个 SIGPIPE 问题：文件多了反而误报“是空的”）。
// 真 deno 的正反例在 deno-frozen-lock.test.ts；这里用假的 deno（直接退出 0），只看这一行的判断
describe.skipIf(!BASH)('deno-frozen-lock.sh 的 _shared/gen 判空（假 deno，在临时目录里真跑）', () => {
  const fn = (genFiles: number) => (d: string) => {
    mkdirSync(join(d, 'fn', '_shared', 'gen', 'b'.repeat(60)), { recursive: true });
    writeFileSync(join(d, 'fn', 'index.ts'), '');
    for (let i = 0; i < genFiles; i += 1) writeFileSync(join(d, 'fn', '_shared', 'gen', 'b'.repeat(60), `${'gen-'.repeat(10)}${i}.ts`), '');
  };
  it('_shared/gen 里文件很多：不误报“是空的”，跑到最后一行', () => {
    const r = run('deno-frozen-lock.sh', ['fn'], fn(1500), { deno: 'exit 0' });
    expect(r.code, r.out).toBe(0);
  });
  it('_shared/gen 是空的或不存在：报错', () => {
    for (const make of [fn(0), (d: string) => { mkdirSync(join(d, 'fn')); writeFileSync(join(d, 'fn', 'index.ts'), ''); }]) {
      const r = run('deno-frozen-lock.sh', ['fn'], make, { deno: 'exit 0' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('_shared/gen/ 是空的');
    }
  });
});

describe.skipIf(!BASH)('tag-on-main.sh（在临时 git 仓库里真跑）', () => {
  // 隔离 git 配置：不读本机全局、系统配置（签名、钩子之类都不带进来）
  const gitEnv = (d: string) => ({ GIT_CONFIG_GLOBAL: join(d, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  /** 提交 a 在 origin/main 上，b 是 a 之后另一条分支上的提交；返回 { a, b } */
  const repo = (d: string) => {
    writeFileSync(join(d, 'empty.gitconfig'), '');
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: d, encoding: 'utf8', env: { ...process.env, ...gitEnv(d) } });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'a');
    const a = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', a);
    git('commit', '-q', '--allow-empty', '-m', 'b');
    return { a, b: git('rev-parse', 'HEAD') };
  };
  /** pick：GITHUB_SHA 取 a、b，null 不设 */
  const onMain = (pick: 'a' | 'b' | null) => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-ci-guard-'));
    try {
      const ids = repo(d);
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...gitEnv(d) };
      if (pick) env.GITHUB_SHA = ids[pick];
      const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', join(CI, 'tag-on-main.sh')], { cwd: d, encoding: 'utf8', env });
      return { code: r.status, out: r.stdout + r.stderr, sha: pick ? ids[pick] : '' };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  it('GITHUB_SHA 在 origin/main 上：通过', () => {
    const r = onMain('a');
    expect(r.code, r.out).toBe(0);
  });
  it('不在 origin/main 上（main 之后另一条分支的提交）：失败并报出提交号', () => {
    const r = onMain('b');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::提交 ${r.sha} 不在 main 上`);
  });
  it('没设 GITHUB_SHA：失败（不放行）', () => {
    expect(onMain(null).code).not.toBe(0);
  });
  it('git 出错（没有 origin/main：checkout 没带 fetch-depth: 0 那种）：退出 2，报的是 git 出错，不说“不在 main 上”', () => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-ci-guard-'));
    try {
      const { a } = repo(d);
      spawnSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: d, env: { ...process.env, ...gitEnv(d) } });
      const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', join(CI, 'tag-on-main.sh')], { cwd: d, encoding: 'utf8', env: { PATH: process.env.PATH, ...gitEnv(d), GITHUB_SHA: a } });
      expect(r.status).toBe(2);
      expect(r.stdout + r.stderr).toContain('git 出错');
      expect(r.stdout + r.stderr).not.toContain('不在 main 上：');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('release-build.yml、desktop.yml 调这几份脚本', () => {
  for (const f of ['release-build.yml', 'desktop.yml']) {
    const t = readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8');
    const all = workflowSteps(t);
    /** run 正好是 cmd（或 run 块里有一行是 cmd）的步骤下标 */
    const idx = (cmd: string) => all.flatMap((s, i) => (runOf(s).split('\n').some((l) => l.trim().startsWith(cmd)) ? [i] : []));
    it(`${f}：tag 在 main 上（checkout 带 fetch-depth: 0，排在构建之前）、构建之后查 source map，各正好一处、不带 continue-on-error`, () => {
      const [tag, map, build, checkout] = [idx('bash build/ci/tag-on-main.sh'), idx('bash build/ci/no-source-map.sh dist/web'), idx('npm run build -- --mode'), all.flatMap((s, i) => (s.text.includes('fetch-depth: 0') ? [i] : []))];
      expect(tag).toHaveLength(1);
      expect(map).toHaveLength(1);
      expect(checkout.length).toBeGreaterThan(0);
      const [ti, mi, bi] = [tag[0] ?? -1, map[0] ?? -1, build[0] ?? -1];
      expect(all[ti]?.job).toBe(all[checkout[0] ?? -1]?.job);
      expect(checkout[0]).toBeLessThan(ti);
      expect(bi).toBeGreaterThanOrEqual(0);
      expect(ti).toBeLessThan(bi);
      expect(mi).toBeGreaterThan(bi);
      expect(t).not.toContain('continue-on-error');
      // 不再留 shell 副本
      expect(t).not.toContain('merge-base --is-ancestor');
      expect(t).not.toContain('sourceMappingURL');
      expect(t).not.toContain("find -L");
    });
  }
});

// 11-14 整块评审：unit.yml、release-build.yml 构建前跑全量 check_arch，构建后那次只跑 A14（扫 dist/web），别的规则不重跑
describe('unit.yml、release-build.yml：check_arch 构建前全量、构建后 --only A14', () => {
  for (const f of ['unit.yml', 'release-build.yml']) {
    it(f, () => {
      const all = workflowSteps(readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8'));
      const lines = all.flatMap((s, i) => runOf(s).split('\n').map((l) => ({ i, l: l.trim() })));
      const arch = lines.filter((x) => /^python3? -I build\/check_arch\.py/.test(x.l));
      const build = lines.find((x) => x.l.startsWith('npm run build -- --mode'));
      expect(build).toBeDefined();
      const before = arch.filter((x) => x.i < (build?.i ?? 0) || (x.i === build?.i && lines.indexOf(x) < lines.indexOf(build)));
      const after = arch.filter((x) => !before.includes(x));
      expect(before.map((x) => x.l.split(' ').slice(2).join(' '))).toEqual(['build/check_arch.py']);
      expect(after.map((x) => x.l.split(' ').slice(2).join(' '))).toEqual(['build/check_arch.py --only A14']);
    });
  }
});
