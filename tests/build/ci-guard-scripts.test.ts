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

const ROOT = join(import.meta.dirname, '..', '..');
const CI = join(ROOT, 'build', 'ci');
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';

/** 在新的临时目录里先 make(目录)，再在那里跑 build/ci/<script> args；返回退出码和全部输出 */
function run(script: string, args: string[], make: (d: string) => void = () => {}) {
  const d = mkdtempSync(join(tmpdir(), 'lemo-ci-guard-'));
  try {
    make(d);
    const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', join(CI, script), ...args], { cwd: d, encoding: 'utf8', env: { PATH: process.env.PATH } });
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
});

describe('release-build.yml、desktop.yml 调这几份脚本', () => {
  for (const f of ['release-build.yml', 'desktop.yml']) {
    const t = readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8');
    const at = (s: string) => t.indexOf(s);
    it(`${f}：tag 在 main 上（checkout 带 fetch-depth: 0，排在构建之前）、构建之后查 source map，各正好一处、不带 continue-on-error`, () => {
      const tag = '        run: bash build/ci/tag-on-main.sh\n';
      const map = '        run: bash build/ci/no-source-map.sh dist/web\n';
      expect(t.split(tag)).toHaveLength(2);
      expect(t.split(map)).toHaveLength(2);
      expect(at('fetch-depth: 0')).toBeGreaterThan(0);
      expect(at('fetch-depth: 0')).toBeLessThan(at(tag));
      expect(at(tag)).toBeLessThan(at('npm run build -- --mode'));
      expect(at(map)).toBeGreaterThan(at('npm run build -- --mode'));
      expect(t).not.toContain('continue-on-error');
      // 不再留 shell 副本
      expect(t).not.toContain('merge-base --is-ancestor');
      expect(t).not.toContain('sourceMappingURL');
      expect(t).not.toContain("find -L");
    });
  }
});
