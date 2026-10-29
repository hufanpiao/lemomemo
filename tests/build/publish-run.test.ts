// tools/release/publish.ps1 从头跑到尾（B1 接手清单 OPS-deploy：-Ops 部署 lemo-ops、-Only functions 只部署或回滚服务器函数）。
// 演练台（假仓库、假工具、假令牌、每次运行私有的 TEMP）在 publish-run-harness.ts；不连 Cloudflare、Supabase、GitHub，不真的部署。
// 核对：-DryRun 不读令牌、不调部署工具，-Ops 时只做 wrangler deploy --dry-run；正式路径的部署顺序（函数 → lemo-ops → 网页）、
// -Only functions 不 link、不 db push、不部署 Pages、不要数据库密码；usage-report 和 lemo-ops 必须同一次部署；KV id 是占位值就停；
// 屏幕输出和工具参数里没有任何令牌。（解析和中文弯引号的静态检查在 ps1-static.test.ts，覆盖 tools/ 下全部 .ps1。）
// OPS-deploy ②③⑤⑥⑦⑧（依赖树哈希、每个子进程只拿要的令牌、secret list、aws4fetch、从临时目录部署、全局 git 配置）在 publish-run-deploy.test.ts。
// core.hookspath 放行与否的一组用例（R266-sugg ⑧ 改成 guardRepoConfig 写法时）挪到了 publish-run-gitsafety.test.ts。
// 只在 Windows 上跑。会清一次本机剪贴板历史（脚本收尾的 Clear-Clip，同 set-fn-role-passwords-run.test.ts）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardRepoConfig } from './publish-run-gitguard.ts';
import {
  ACCT, CF_TOKEN, ctx, DB_PW, functionNames, git, has, KV_ID, noSecrets, PS, REF, runScript, SB_TOKEN, setup, tagHere, teardown, wranglerSafe, writeBackupManifest,
  type Run,
} from './publish-run-harness.ts';

describe.skipIf(!PS)('publish.ps1 从头跑到尾（假仓库、假工具、假令牌）', () => {
  beforeAll(setup, 300_000);
  afterAll(teardown);

  it('-DryRun -Ops：构建、装工具、lemo-ops 只做 --dry-run；不读令牌、不调 supabase', async () => {
    const r = await runScript('-DryRun -Ops', ['一致']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('这次要部署：数据库迁移 → 服务器函数 → lemo-ops → 网页（Pages）');
    expect(r.out).toContain('lemo-ops 的配置可以部署');
    expect(r.out).toContain('lemo-ops 打包演练通过');
    expect(r.out).toContain('演练（-DryRun）到此结束');
    expect(r.log.some((l) => l.startsWith('npm\trun build'))).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^wrangler\tdeploy --config workers\\lemo-ops\\wrangler\.toml --dry-run --outdir \S+lemo-ops-dry --env-file \S+empty\.env\t\t/u);
    wranglerSafe(r);
    expect(r.envLeft).toBe('');
    expect(r.prompts).toHaveLength(1);
    expect(r.left).toBe(0);
    noSecrets(r);
  }, 180_000);

  it('-DryRun -Only functions（不加 -Ops）：这个 tag 有 usage-report 和 lemo-ops，第 1 步就停', async () => {
    const r = await runScript('-DryRun -Only functions', []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('usage-report 和 lemo-ops 必须同一次部署');
    expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.prompts).toEqual([]);
  }, 180_000);

  it('-DryRun -Only functions -Ops：不构建网页；装 Supabase CLI 和 wrangler，lemo-ops 只做 --dry-run', async () => {
    const r = await runScript('-DryRun -Only functions -Ops', []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('这次要部署：服务器函数 → lemo-ops（');
    expect(r.out).toContain('-Only functions：跳过（不部署网页）');
    // 项目本身的 npm ci、npm run build 都不跑；只在临时目录里装 tools\deploy 的 wrangler
    const npm = r.log.filter((l) => l.startsWith('npm\t'));
    expect(npm.some((l) => l.split('\t')[2] === ctx.repo), npm.join('\n')).toBe(false);
    expect(npm.some((l) => l.startsWith('npm\tci ') && l.endsWith('\\deploy'))).toBe(true);
    expect(r.log.some((l) => l.startsWith('download\thttps://github.com/supabase/cli/'))).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^wrangler\tdeploy --config workers\\lemo-ops\\wrangler\.toml --dry-run /u);
    wranglerSafe(r);
    expect(r.prompts).toEqual([]);
    noSecrets(r);
  }, 180_000);

  it('正式路径 -Ops（假令牌）：db push → 函数 → lemo-ops → 网页，顺序对；令牌不进参数、不上屏幕', async () => {
    const r = await runScript('-Ops', ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送']);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    const seq = r.calls.map((c) => c.split('\t')[0] + ' ' + (c.split('\t')[1] ?? '').split(' ').slice(0, 2).join(' '));
    expect(seq).toEqual([
      'wrangler deploy --config',  // 第 4 步打包演练（--dry-run）
      'wrangler secret list',  // 改库前只读核对 lemo-ops 的六个密钥（OPS-deploy ⑤）
      'supabase link --project-ref',
      'supabase db push',
      'supabase db push',
      'supabase functions deploy',
      'wrangler deploy --config',
      'wrangler pages deploy',
    ]);
    expect(r.calls[0]).toContain('--dry-run');
    // 打包演练时还没有任何令牌
    expect(r.calls[0]?.split('\t')[2]).toBe('');
    // 服务器函数逐个写出名字部署（M2），不是“不写名字＝全部部署”
    expect(functionNames().length).toBeGreaterThan(0);
    expect(r.calls[5]).toContain(`functions deploy ${functionNames().join(' ')} --project-ref ${REF} --use-api --yes\t`);
    expect(r.out).toContain('网页产物和第 3 步核对过的一致');
    const ops = r.calls[6] ?? '';
    expect(ops).toMatch(new RegExp(`^wrangler\\tdeploy --config workers\\\\lemo-ops\\\\wrangler\\.toml --tag v${ctx.ver.replace(/\./g, '\\.')} --message v${ctx.ver.replace(/\./g, '\\.')}@[0-9a-f]{12} --env-file \\S+empty\\.env\\t`, 'u'));
    wranglerSafe(r);
    // 改库之前做了 Workers 权限的只读预检（带令牌、不跟随重定向）
    const cfAt = r.log.findIndex((l) => l.startsWith('cf\t'));
    expect(cfAt).toBeGreaterThan(-1);
    expect(r.log[cfAt]).toMatch(/\tTrue\t0$/u);
    expect(cfAt).toBeLessThan(r.log.findIndex((l) => l.startsWith('supabase\tlink')));
    expect(r.envLeft, '跑完以后环境变量没清干净').toBe('');
    expect(ops.split('\t')[2]).toContain('CLOUDFLARE_API_TOKEN');
    expect(ops.split('\t')[2]).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(r.log.some((l) => l.startsWith('api\t') && l.endsWith('\tTrue'))).toBe(true);
    expect(r.out).toContain('lemo-ops 部署完成');
    expect(r.out).toContain(`线上已是 ${ctx.ver}`);
    expect(r.out).toContain('已清掉本窗口里的令牌');
    noSecrets(r);
  }, 180_000);

  it('回滚 -Only functions -Ops（假令牌）：不 link、不 db push、不部署 Pages、不要数据库密码；函数后紧接着 lemo-ops', async () => {
    const r = await runScript('-Only functions -Ops', [REF, SB_TOKEN, CF_TOKEN, ACCT, 'lemomemo']);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    expect(r.prompts.some((p) => p.includes('数据库密码'))).toBe(false);
    expect(has(r, /^supabase\t(link|db )/u)).toBe(false);
    expect(has(r, /^wrangler\tpages /u)).toBe(false);
    const seq = r.calls.map((c) => c.split('\t')[0] + ' ' + (c.split('\t')[1] ?? '').split(' ')[0]);
    expect(seq).toEqual(['wrangler deploy', 'wrangler secret', 'supabase functions', 'wrangler deploy']);
    const fn = r.calls[2] ?? '';
    expect(fn).toContain(`functions deploy ${functionNames().join(' ')} --project-ref ${REF} --use-api --yes\t`);
    expect(fn.split('\t')[2]).not.toContain('SUPABASE_DB_PASSWORD');
    expect(r.calls[3]).toContain('--message v');
    wranglerSafe(r);
    expect(r.envLeft).toBe('');
    expect(r.out).toContain('不核对 version.json');
    expect(r.log.some((l) => l.startsWith('version\t'))).toBe(false);
    noSecrets(r);
  }, 180_000);

  it('lemo-ops 部署失败：函数已部署，停下、不再部署网页，并说清现在的状态和怎么重跑', async () => {
    const r = await runScript('-Ops', ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'], { fail: '--message' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('发布停止：lemo-ops 部署失败');
    expect(r.out).toContain('数据库迁移已推、服务器函数已是新版，lemo-ops 和网页还是旧版');
    expect(r.out).toContain('同一个 tag、同样的参数原样重跑');
    expect(has(r, /^supabase\tfunctions deploy /u)).toBe(true);
    expect(has(r, /^wrangler\tdeploy --config \S+ --tag \S+ --message /u)).toBe(true);
    expect(r.envLeft).toBe('');
    expect(has(r, /^wrangler\tpages /u)).toBe(false);
    expect(r.out).toContain('已清掉本窗口里的令牌');
    noSecrets(r);
  }, 180_000);

  it('Cloudflare 令牌没有 Workers 权限：只读预检失败，停在改库之前', async () => {
    const r = await runScript('-Ops', ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'], { cfDeny: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain('读不了 Worker 列表');
    expect(has(r, /^supabase\t/u)).toBe(false);
    expect(r.left).toBe(1);
    expect(r.envLeft).toBe('');
    noSecrets(r);
  }, 180_000);

  // M1：wrangler pages deploy 从仓库根目录往上找配置和重定向文件；Supabase CLI 读 supabase\.env*；代理、global key 之类的环境变量
  const stopCases: { name: string; path?: () => string; env?: Record<string, string>; want: string }[] = [
    { name: '仓库根目录有 .wrangler\\deploy\\config.json（重定向文件）', path: () => join(ctx.repo, '.wrangler', 'deploy', 'config.json'), want: '会自动采用的配置文件' },
    { name: '上一级目录有 wrangler.toml', path: () => join(ctx.dir, 'wrangler.toml'), want: '会自动采用的配置文件' },
    { name: 'supabase\\.env.local（Supabase CLI 会读）', path: () => join(ctx.repo, 'supabase', '.env.local'), want: 'supabase\\.env.local' },
    { name: '根目录有 .env.production', path: () => join(ctx.repo, '.env.production'), want: '自动读的环境文件：.env.production' },
    { name: '窗口里有 HTTPS_PROXY', env: { HTTPS_PROXY: 'http://127.0.0.1:9' }, want: '不该有的环境变量：HTTPS_PROXY' },
    { name: '窗口里有 CLOUDFLARE_API_KEY ＋ CLOUDFLARE_EMAIL（global key 优先于令牌）', env: { CLOUDFLARE_API_KEY: 'x', CLOUDFLARE_EMAIL: 'a@example.test' }, want: 'CLOUDFLARE_API_KEY、CLOUDFLARE_EMAIL' },
    // M2：被 git 忽略的函数文件（git status 看不见）会跟着正式部署上线
    { name: 'functions\\tmp\\x.ts（被 git 忽略）', path: () => join(ctx.repo, 'functions', 'tmp', 'x.ts'), want: '会跟着正式部署上线：functions/tmp/x.ts' },
    { name: 'supabase\\functions\\tmp\\index.ts（被 git 忽略）', path: () => join(ctx.repo, 'supabase', 'functions', 'tmp', 'index.ts'), want: '会跟着正式部署上线：supabase/functions/tmp/index.ts' },
    { name: '窗口里有 GIT_EXEC_PATH、GIT_TEMPLATE_DIR', env: { GIT_EXEC_PATH: 'C:\\nowhere', GIT_TEMPLATE_DIR: 'C:\\nowhere' }, want: '会改 git 行为的环境变量：GIT_EXEC_PATH、GIT_TEMPLATE_DIR' },
    { name: '窗口里预先设了 SUPABASE_API_URL', env: { SUPABASE_API_URL: 'https://evil.example.test' }, want: '不该有的环境变量：SUPABASE_API_URL' },
  ];
  for (const c of stopCases) {
    it(`${c.name}：第 1 步就停`, async () => {
      const p = c.path?.();
      if (p) {
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, p.endsWith('.toml') ? 'name = "x"\npages_build_output_dir = "dist/web"\n' : 'X=1\n', 'utf8');
      }
      try {
        const r = await runScript('-DryRun -Ops', [], { env: c.env ?? {} });
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(c.want);
        expect(r.calls).toEqual([]);
        expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
      } finally {
        if (p) rmSync(p, { force: true });
        if (p?.includes(join('.wrangler', 'deploy'))) rmSync(join(ctx.repo, '.wrangler'), { recursive: true, force: true });
        if (p?.includes(join('functions', 'tmp'))) rmSync(join(p, '..'), { recursive: true, force: true });
      }
    }, 180_000);
  }

  it('仓库里有 .env.local（wrangler 会自动读）：第 1 步就停', async () => {
    const f = join(ctx.repo, '.env.local');
    writeFileSync(f, 'CLOUDFLARE_API_BASE_URL=https://evil.example.test/client/v4\n', 'utf8');
    try {
      const r = await runScript('-DryRun -Ops', []);
      expect(r.code).toBe(1);
      expect(r.out).toContain('会自动读的环境文件：.env.local');
      expect(r.calls).toEqual([]);
      expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  }, 180_000);

  // M3、M4：.git 里事先放好的东西。三个用例都在 .git\config 里挂一个会留记号的 core.fsmonitor 程序，
  // 先确认它在普通的 git status 里确实会被执行，再断言跑发布脚本时它一次都没被执行（脚本第一次调 git 之前就把 fsmonitor 关了）
  const gitStateCases: { name: string; setup: () => void; undo: () => void; want: string }[] = [
    {
      name: 'assume-unchanged 标记',
      setup: () => git(['update-index', '--assume-unchanged', 'VERSION']),
      undo: () => git(['update-index', '--no-assume-unchanged', 'VERSION']),
      want: '被标成 assume-unchanged 或 skip-worktree',
    },
    { name: '.git\\config 里有 core.fsmonitor', setup: () => undefined, undo: () => undefined, want: '不许有的设置：core.fsmonitor' },
    {
      name: '.git\\info\\attributes 不为空',
      setup: () => writeFileSync(join(ctx.repo, '.git', 'info', 'attributes'), '*.ts filter=x\n', 'utf8'),
      undo: () => rmSync(join(ctx.repo, '.git', 'info', 'attributes'), { force: true }),
      want: '.git\\info\\attributes 不是空的',
    },
  ];
  for (const c of gitStateCases) {
    it(`${c.name}：第 1 步就停，fsmonitor 程序没被执行`, async () => {
      const marker = join(ctx.dir, 'fsmonitor-ran.txt');
      const hook = join(ctx.dir, 'fsmonitor.sh');
      writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, '/')}'\n`, 'utf8');
      // R266-sugg ⑧：照 guardRepoConfig 的写法，设置写在 try 里，finally 里有就删，并核对 .git\config、引用、git status 和开始前一字不差
      const restore = guardRepoConfig([], ['core.fsmonitor']);
      try {
        git(['config', '--local', 'core.fsmonitor', hook.replace(/\\/g, '/')]);
        // 探针有效：普通的 git status 会执行它
        spawnSync('git', ['status', '--porcelain'], { cwd: ctx.repo, encoding: 'utf8' });
        expect(existsSync(marker), 'fsmonitor 探针没生效，这个用例测不出东西').toBe(true);
        c.setup();
        // setup 里的 git 命令也可能触发它，跑脚本之前再清一次记号
        rmSync(marker, { force: true });
        const r = await runScript('-DryRun -Ops', []);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(c.want);
        expect(existsSync(marker), '发布脚本运行时 fsmonitor 程序被执行了').toBe(false);
        expect(r.calls).toEqual([]);
        expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('download\t'))).toBe(false);
      } finally {
        c.undo();
        restore();
        rmSync(marker, { force: true });
      }
    }, 180_000);
  }

  // M5：git status 写回刷新后的索引会触发 post-index-change 钩子；脚本用 GIT_CONFIG_* 把 core.hooksPath 指到空目录，钩子一次都不执行
  it('.git\\hooks\\post-index-change 钩子：演练全程一次都没执行', async () => {
    const marker = join(ctx.dir, 'hook-ran.txt');
    const hook = join(ctx.repo, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, '/')}'\n`, 'utf8');
    const stale = () => { const t = new Date(Date.now() + 5_000); utimesSync(join(ctx.repo, 'VERSION'), t, t); };
    try {
      // 探针有效：让索引过期，普通的 git status 写回索引时会执行它
      stale();
      spawnSync('git', ['status', '--porcelain'], { cwd: ctx.repo, encoding: 'utf8' });
      expect(existsSync(marker), 'post-index-change 探针没生效，这个用例测不出东西').toBe(true);
      rmSync(marker, { force: true });
      stale();
      // PUBLISH-tmp：给脚本一个本次演练私有的 TEMP（publish.ps1 在 $env:TEMP 下建 lemo-nohooks-*），只查这个目录——
      //   不看系统临时目录，本机同时跑的另一份全量、别人的残留都碰不到这个断言。
      //   演练期间每 20 ms 看一眼这个目录，记下出现过的 lemo-nohooks-*：要真见过一次（脚本确实建在这里，不是空查），跑完又没有了
      const ownTemp = join(ctx.dir, `temp-${Math.random().toString(36).slice(2, 10)}`);
      mkdirSync(ownTemp);
      const seen = new Set<string>();
      const peek = () => { try { for (const n of readdirSync(ownTemp)) if (n.startsWith('lemo-nohooks-')) seen.add(n); } catch { /* 目录正在变动，下一次再看 */ } };
      const timer = setInterval(peek, 20);
      let r: Run;
      try {
        r = await runScript('-DryRun -Ops', ['一致'], { env: { TEMP: ownTemp, TMP: ownTemp } });
      } finally {
        clearInterval(timer);
      }
      expect(r.code, r.out).toBe(0);
      expect(existsSync(marker), '发布脚本运行时 post-index-change 钩子被执行了').toBe(false);
      expect(r.out).toContain('演练（-DryRun）到此结束');
      // 空的钩子目录用完就删，GIT_CONFIG_* 也清掉
      expect(seen.size, '演练期间没在本次的 TEMP 里见到 lemo-nohooks-*（脚本没用传进去的 TEMP，这条测不出东西）').toBe(1);
      expect(readdirSync(ownTemp).filter((n) => n.startsWith('lemo-nohooks-'))).toEqual([]);
      expect(r.envLeft).toBe('');
    } finally {
      rmSync(hook, { force: true });
      rmSync(marker, { force: true });
    }
  }, 180_000);

  it('-Ops 时 KV id 还是占位值：第 1 步就停', async () => {
    const tomlPath = join(ctx.repo, 'workers', 'lemo-ops', 'wrangler.toml');
    writeFileSync(tomlPath, readFileSync(tomlPath, 'utf8').replace(KV_ID, 'REPLACE_WITH_KV_NAMESPACE_ID'), 'utf8');
    git(['commit', '-q', '-am', 'publish-run 测试：KV id 改回占位值']);
    tagHere();
    const r = await runScript('-CheckOnly -Ops', []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('KV 的 id 还是占位值');
  }, 180_000);

  it('tag 里没有 lemo-ops 时，-Only functions 不加 -Ops 也能跑（不要求同一次部署）', async () => {
    git(['rm', '-q', '-r', 'workers/lemo-ops']);
    git(['commit', '-q', '-m', 'publish-run 测试：去掉 lemo-ops']);
    tagHere();
    expect(existsSync(join(ctx.repo, 'workers', 'lemo-ops', 'wrangler.toml'))).toBe(false);
    const r = await runScript('-CheckOnly -Only functions', []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('这次不部署 lemo-ops');
    expect(r.out).toContain('这次要部署：服务器函数（');
  }, 180_000);

  it('tag 里没有 lemo-ops 时，-Only functions 不加 -Ops 的正式路径：只要 Supabase 令牌，不问 Cloudflare 令牌、不装不调 wrangler', async () => {
    writeBackupManifest();
    const r = await runScript('-Only functions', [REF, SB_TOKEN, 'lemomemo']);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    expect(r.prompts.some((p) => p.includes('Cloudflare'))).toBe(false);
    expect(r.calls.map((c) => c.split('\t')[0])).toEqual(['supabase']);
    expect(r.calls[0]).toContain(`functions deploy ${functionNames().join(' ')} --project-ref`);
    expect(r.log.some((l) => l.startsWith('cf\t') || l.startsWith('npm\t'))).toBe(false);
    expect(r.envLeft).toBe('');
    noSecrets(r);
  }, 180_000);
});
