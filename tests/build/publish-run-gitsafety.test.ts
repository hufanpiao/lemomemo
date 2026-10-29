// tools/release/publish.ps1 第八批（演练台见 publish-run-harness.ts，git 小工具见 publish-run-gitguard.ts）：
// R266-sugg ③ 签名边界：log.showSignature=true、gpg.program=<任意程序> 时 git show 会执行那个程序；脚本用 GIT_CONFIG_KEY_2 注入
//   log.showSignature=false（子进程继承），pages deploy 显式传 --commit-message（wrangler 不再跑 git show -s --format=%B）；
// R-268 复审：第 5 步的替换对象检查真跑一次（假 wrangler 在 --dry-run 时执行 git replace）；
// R-269 复审：第 6 步部署服务器函数之前、部署 lemo-ops 之前各逐个比一次内容（真跑：中途改一个被跟踪的文件），另有静态核对。
// 不连 Cloudflare、Supabase、GitHub，不真的部署。只在 Windows 上跑。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCT, CF_TOKEN, ctx, DB_PW, git, has, PS, REF, root, runScript, SB_TOKEN, setup, teardown } from './publish-run-harness.ts';
import { gitIn, guardRepoConfig } from './publish-run-gitguard.ts';

const FULL = ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'];
const CONTENT_OK = '被跟踪的文件逐个比过内容（不靠大小和修改时间），和检出的提交一致';
const count = (s: string, sub: string) => s.split(sub).length - 1;
const psText = () => readFileSync(join(root, 'tools', 'release', 'publish.ps1'), 'utf8');
const body = (ps: string, name: string) => ps.slice(ps.indexOf(`function ${name}`), ps.indexOf('\n}', ps.indexOf(`function ${name}`)));

describe.skipIf(!PS)('publish.ps1 签名边界、第 5 步替换对象、第 6 步逐个比内容（假仓库、假工具、假令牌）', () => {
  beforeAll(setup, 300_000);
  afterAll(teardown);

  // R266-sugg ⑧（从 publish-run.test.ts 挪来，那个文件到了 300 行）：
  // core.hookspath 只放行指向本仓库被跟踪的 .githooks（项目的密钥检查钩子），其他都在第 1 步停
  const hooksCases: { name: string; value: () => string; extra?: () => string; ok: boolean; want: string }[] = [
    { name: '指向仓库外的目录', value: () => join(ctx.dir, 'hooks-outside'), ok: false, want: '不许有的设置：core.hookspath' },
    { name: '指向 .githooks，但里面有被忽略的文件', value: () => join(ctx.repo, '.githooks'), extra: () => join(ctx.repo, '.githooks', 'x.tmp'), ok: false, want: '.githooks 下有没被 git 跟踪的文件（含被忽略的）：.githooks/x.tmp' },
    { name: '指向 <RepoPath>\\.githooks（项目规定的写法）', value: () => join(ctx.repo, '.githooks'), ok: true, want: 'core.hookspath 指向本仓库被跟踪的 .githooks' },
    { name: '相对路径 .githooks', value: () => '.githooks', ok: true, want: 'core.hookspath 指向本仓库被跟踪的 .githooks' },
  ];
  for (const c of hooksCases) {
    it(`core.hookspath ${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      mkdirSync(join(ctx.dir, 'hooks-outside'), { recursive: true });
      const restore = guardRepoConfig([], ['core.hookspath']);
      const extra = c.extra?.();
      try {
        git(['config', '--local', 'core.hookspath', c.value()]);
        if (extra) writeFileSync(extra, 'x\n', 'utf8');
        // 被忽略的文件不进 git status：确认工作区仍算干净，拦下它的是 .githooks 的检查
        if (extra) expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
        const r = await runScript('-CheckOnly -Ops', []);
        expect(r.code, r.out).toBe(c.ok ? 0 : 1);
        expect(r.out).toContain(c.want);
        expect(r.calls).toEqual([]);
      } finally {
        if (extra) rmSync(extra, { force: true });
        restore();
      }
    }, 180_000);
  }

  // ③ 前提：.git\config 设 log.showSignature=true、gpg.program=<留记号的程序>，带签名头的提交 git show 时会执行它；
  // 用脚本注入的那三项命令行级配置（GIT_CONFIG_COUNT=3，第三项 log.showSignature=false）就不执行
  it('R266-sugg ③ 前提：log.showSignature + gpg.program 让 git show 执行外部程序；脚本注入的 log.showSignature=false 能挡住', () => {
    const marker = join(ctx.dir, 'gpg-ran.txt');
    const prog = join(ctx.dir, 'fake-gpg.sh');
    writeFileSync(prog, `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, '/')}'\nexit 1\n`, 'utf8');
    const restore = guardRepoConfig([], ['log.showSignature', 'gpg.program']);
    try {
      git(['config', '--local', 'log.showSignature', 'true']);
      git(['config', '--local', 'gpg.program', prog.replace(/\\/g, '/')]);
      const head = git(['rev-parse', 'HEAD']);
      const who = 'publish-test <publish-test@example.test> 1700000000 +0000';
      const sig = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n';
      const signed = gitIn(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: `tree ${git(['rev-parse', 'HEAD^{tree}'])}\nparent ${head}\nauthor ${who}\ncommitter ${who}\n${sig}\nsigned msg\n` });
      const show = ['show', '-s', '--format=%B', signed];
      expect(gitIn(show)).toBe('signed msg');
      expect(existsSync(marker), '探针没生效：git show 没执行 gpg.program，这个用例测不出东西').toBe(true);
      rmSync(marker, { force: true });
      const env = { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(ctx.dir, 'no-hooks'), GIT_CONFIG_KEY_2: 'log.showSignature', GIT_CONFIG_VALUE_2: 'false' };
      expect(gitIn(show, { env })).toBe('signed msg');
      expect(existsSync(marker), '注入 log.showSignature=false 以后 gpg.program 仍被执行了').toBe(false);
    } finally {
      restore();
      rmSync(marker, { force: true });
    }
  });

  it('R266-sugg ③ 脚本在第一次调 git 之前注入 log.showSignature=false（GIT_CONFIG_COUNT=3），结束时清掉', () => {
    const ps = psText();
    const main = ps.slice(ps.indexOf('# ---------------------------------------------------------------- 主流程'));
    const inject = main.indexOf("SetEnvironmentVariable('GIT_CONFIG_KEY_2', 'log.showSignature', 'Process')");
    expect(inject).toBeGreaterThan(0);
    expect(main).toContain("SetEnvironmentVariable('GIT_CONFIG_COUNT', '3', 'Process')");
    expect(main).toContain("SetEnvironmentVariable('GIT_CONFIG_VALUE_2', 'false', 'Process')");
    expect(inject).toBeLessThan(main.indexOf('$info = Invoke-Checks'));
    expect(main.slice(main.indexOf('} finally {'))).toMatch(/'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2'/u);
  });

  it('R266-sugg ③ / R-269 复审 完整发布：pages deploy 带 --commit-message <tag>@<提交前 12 位>；内容逐个比了 4 次（第 1、5 步，函数、lemo-ops 之前）', async () => {
    const r = await runScript('-Ops', FULL);
    expect(r.code, r.out).toBe(0);
    const pages = r.calls.find((c) => c.startsWith('wrangler\tpages deploy'));
    expect(pages, r.calls.join('\n')).toContain(`--commit-message v${ctx.ver}@${git(['rev-parse', 'HEAD']).slice(0, 12)} --commit-dirty=true`);
    expect(count(r.out, CONTENT_OK)).toBe(4);
    expect(r.envLeft).toBe('');
  }, 180_000);

  // R-268 复审：第 4 步 lemo-ops 打包演练（--dry-run）时假 wrangler 真跑一次 git replace（第 1 步时还没有），第 5 步输令牌之前就停
  it('R-268 第 1 步之后才加的替换对象：第 5 步查 refs/replace/ 停下，还没输令牌', async () => {
    const restore = guardRepoConfig();
    try {
      const head = git(['rev-parse', 'HEAD']);
      const r = await runScript('-Ops', FULL, { tamperAt: '--dry-run', tamper: `git:-C "${ctx.repo}" replace ${head} ${git(['rev-parse', 'HEAD~1'])}` });
      expect(r.code, r.out).toBe(1);
      expect(count(r.out, '没有替换对象（refs/replace/）'), '第 1 步应该过了').toBe(1);
      expect(r.out).toContain(`仓库里有替换对象（git replace，能让改过的文件在 git status 里看起来是干净的）：refs/replace/${head}。`);
      expect(r.prompts).toHaveLength(1);
      expect(has(r, /^supabase\t/u)).toBe(false);
      expect(r.envLeft).toBe('');
    } finally {
      restore();
    }
  }, 180_000);

  // R-269 复审：第 6 步中途改一个被跟踪的文件（假工具追加 tampered），部署服务器函数之前 / 部署 lemo-ops 之前逐个比内容停下
  const step6: { name: string; at: string; want: string; stopBefore: RegExp; ran: RegExp }[] = [
    { name: '迁移演练时改：部署服务器函数之前', at: 'db push --linked --dry-run', want: '数据库迁移已推，服务器函数、lemo-ops、网页都还是旧版，没部署任何代码', stopBefore: /^supabase\tfunctions deploy/u, ran: /^supabase\tdb push --linked --yes/u },
    { name: '部署服务器函数时改：部署 lemo-ops 之前', at: '--use-api', want: '数据库迁移已推、服务器函数已是新版，lemo-ops和网页还是旧版', stopBefore: /^wrangler\tdeploy --config \S+ --tag/u, ran: /^supabase\tfunctions deploy/u },
  ];
  for (const c of step6) {
    it(`R-269 复审 ${c.name}逐个比内容停下`, async () => {
      const restore = guardRepoConfig(['VERSION']);
      try {
        const r = await runScript('-Ops', FULL, { tamperAt: c.at, tamper: join(ctx.repo, 'VERSION') });
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(`git status 却看不出来（大小、修改时间都没变）：VERSION。${c.want}`);
        expect(has(r, c.ran), r.calls.join('\n')).toBe(true);
        expect(has(r, c.stopBefore), r.calls.join('\n')).toBe(false);
        expect(has(r, /^wrangler\tpages deploy/u)).toBe(false);
        expect(r.envLeft).toBe('');
      } finally {
        restore();
      }
    }, 180_000);
  }

  it('R-269 复审 静态核对：函数、lemo-ops 部署之前各调一次，注释写明临时索引按 TMP 优先', () => {
    const ps = psText();
    const deploy = body(ps, 'Invoke-Deploy');
    const fn = deploy.indexOf("@('functions', 'deploy')");
    const ops = deploy.indexOf("Run-Wrangler @('deploy', '--config'");
    const checks = [...deploy.matchAll(/\n\s*Assert-ContentMatchesHead /gu)].map((m) => m.index);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toBeLessThan(fn);
    expect(checks[1]).toBeGreaterThan(fn);
    expect(checks[1]).toBeLessThan(ops);
    expect(ps).toContain('Windows 上按 TMP 优先，其次 TEMP');
  });
});
