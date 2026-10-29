// tools/release/publish.ps1 的 B1 接手清单 OPS-deploy ②③⑤⑥⑦⑧（演练台见 publish-run-harness.ts：假仓库、假工具、假令牌、每次运行私有的 TEMP）：
// ② 装好的 wrangler 依赖树和 tools/release/wrangler-tree.lock 对不上就停（第 4 步装完一次、第 5 步输令牌前一次）；
// ③ 每个子进程只拿它要的那把令牌（只核对“哪个子进程拿到了哪些环境变量名”，假令牌的值不进日志）；本进程自己的环境变量里平时没有令牌；
// ⑤ 改库前 wrangler secret list 只读核对 lemo-ops 的六个密钥（假工具打印名单，不调真的）；
// ⑥ 第 3 步之后 node_modules\aws4fetch 记哈希，改库前、部署网页前各比一次；
// ⑦ dist\web 复制到临时目录，核对后从那里部署；
// ⑧ git 全局配置里的 filter.*、core.attributesfile、全局属性文件（演练用私有的 HOME、XDG_CONFIG_HOME，不碰本机的全局配置）；
// R-264 system 一级：只放行 Git for Windows 自带的四项 filter.lfs.*（值也核对，演练用私有的 GIT_CONFIG_SYSTEM，不碰本机的系统配置）；
// R-266 worktree 一级（.git\config.worktree）：有 filter.*、core.attributesfile 就停；.git\config 开 extensions.worktreeConfig 也停；
// R-265 脚本设 GIT_ATTR_NOSYSTEM=1、git 不读系统属性文件，没生效就停（演练台的 git 包装模拟没生效）；
// OPS-deploy-sugg ① git var 失败就停；② 令牌太短时那个 SecureString 已 Dispose；⑤ 手册第三节“设六个密钥”、第四节 2b 两段命令（假 npm、假 node、假令牌）。
// 不连 Cloudflare、Supabase、GitHub，不真的部署。只在 Windows 上跑。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCT, CF_TOKEN, ctx, DB_PW, git, has, LFS_SYSTEM_CONFIG, noSecrets, OPS_SECRETS, PS, REF, root, runScript, SB_TOKEN, setup, teardown, WRANGLER_QUIET, wranglerSafe, type Run,
} from './publish-run-harness.ts';
import { manualBlock, realSystemIsLfsOnly, runManualBlock } from './publish-run-manual.ts';

const FULL = ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'];
const SB_DB = 'SUPABASE_ACCESS_TOKEN,SUPABASE_DB_PASSWORD';
const CF = 'CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID';
const envOf = (c: string) => c.split('\t')[2] ?? '?';
const head = (c: string) => c.split('\t')[0] + ' ' + (c.split('\t')[1] ?? '').split(' ').slice(0, 2).join(' ');

// 本进程（脚本自己）读令牌、发请求时环境变量里都没有令牌；临时目录用完删掉
function processClean(r: Run) {
  expect(r.penv.length).toBeGreaterThan(0);
  for (const l of r.penv) expect(l.split('\t')[2] ?? '', l).toBe('');
  expect(r.envLeft).toBe('');
  expect(readdirSync(r.temp), '私有 TEMP 里留下了东西').toEqual([]);
}
// 停在改库之前：没调 supabase，令牌之后的输入（项目名、确认推送）都没用上
function stoppedBeforeDb(r: Run, want: string) {
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain(want);
  expect(has(r, /^supabase\t/u)).toBe(false);
  expect(has(r, /^wrangler\t(pages|deploy --config \S+ --tag)/u)).toBe(false);
  expect(r.envLeft).toBe('');
  noSecrets(r);
}

describe.skipIf(!PS)('publish.ps1 OPS-deploy ②③⑤⑥⑦⑧（假仓库、假工具、假令牌）', () => {
  beforeAll(setup, 300_000);
  afterAll(teardown);

  it('③⑤⑦ 正式路径 -Ops：每个子进程只拿它要的令牌；改库前 secret list；网页从临时目录里的副本部署', async () => {
    const r = await runScript('-Ops', FULL);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    expect(r.calls.map((c) => [head(c), envOf(c)])).toEqual([
      ['wrangler deploy --config', ''], // 第 4 步打包演练：什么令牌都不给
      ['wrangler secret list', CF],
      ['supabase link --project-ref', SB_DB],
      ['supabase db push', SB_DB],
      ['supabase db push', SB_DB],
      ['supabase functions deploy', 'SUPABASE_ACCESS_TOKEN'], // 部署函数不连数据库，不给数据库密码
      ['wrangler deploy --config', CF],
      ['wrangler pages deploy', CF],
    ]);
    expect(r.calls[1]).toMatch(/^wrangler\tsecret list --config workers\\lemo-ops\\wrangler\.toml --format json --env-file /u);
    expect(r.out).toContain('lemo-ops 的六个密钥都在');
    // secret list 在 Workers 权限预检之后、supabase link 之前
    expect(r.log.findIndex((l) => l.startsWith('cf\t'))).toBeLessThan(r.log.findIndex((l) => l.startsWith('wrangler\tsecret list')));
    // ⑦ pages deploy 的目录是本次私有 TEMP 下 lemo-publish-<guid>\web，不是仓库里的 dist\web
    const dirArg = (r.calls[7] ?? '').split('\t')[1]?.split(' ')[2] ?? '';
    expect(dirArg).toMatch(/\\lemo-publish-[0-9a-f]{32}\\web$/u);
    expect(dirArg.startsWith(r.temp + '\\')).toBe(true);
    // ② 依赖树核对过（假 npm 放的 .bin、.package-lock.json 删掉后才和锁一致），第 5 步又核了一次
    expect(r.out).toContain('wrangler 依赖树和 tools\\release\\wrangler-tree.lock 一致（2 个文件）');
    expect(r.out).toContain('supabase.exe 和 wrangler 依赖树都还是第 4 步核对过的');
    // ⑥ aws4fetch：第 3 步之后记一次，改库前、部署网页前各比一次
    expect(r.out).toContain('记下 node_modules\\aws4fetch 的哈希');
    expect(r.out.split('node_modules\\aws4fetch 和第 3 步之后记下的一致').length - 1).toBe(2);
    wranglerSafe(r);
    processClean(r);
    noSecrets(r);
    // 读进来的令牌收尾时都 Dispose 了（Clear-Secrets；最后一个读的是 Cloudflare 令牌）
    expect(r.secDisposed).toBe('yes');
  }, 180_000);

  it('③ 回滚 -Only functions -Ops：supabase 只拿 Supabase 令牌，wrangler 只拿 Cloudflare 令牌', async () => {
    const r = await runScript('-Only functions -Ops', [REF, SB_TOKEN, CF_TOKEN, ACCT, 'lemomemo']);
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => [head(c), envOf(c)])).toEqual([
      ['wrangler deploy --config', ''],
      ['wrangler secret list', CF],
      ['supabase functions deploy', 'SUPABASE_ACCESS_TOKEN'],
      ['wrangler deploy --config', CF],
    ]);
    // 不部署网页：不记 aws4fetch、不复制 dist\web
    expect(r.out).not.toContain('aws4fetch');
    processClean(r);
    noSecrets(r);
  }, 180_000);

  it('③ 窗口里预先有 SUPABASE_ACCESS_TOKEN（会被每个子进程继承）：第 1 步就停', async () => {
    const r = await runScript('-DryRun -Ops', [], { env: { SUPABASE_ACCESS_TOKEN: 'TEST_ONLY_preexisting' } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('不该有的环境变量：SUPABASE_ACCESS_TOKEN');
    expect(r.calls).toEqual([]);
  }, 180_000);

  it('⑤ 六个密钥名和 workers/lemo-ops/wrangler.toml 末尾注释里列的一致', () => {
    const toml = readFileSync(join(root, 'workers', 'lemo-ops', 'wrangler.toml'), 'utf8');
    const listed = [...toml.matchAll(/^#\s{3}([A-Z][A-Z0-9_]+)\s/gmu)].map((m) => m[1]);
    expect(listed).toEqual(OPS_SECRETS);
    const ps = readFileSync(join(root, 'tools', 'release', 'publish.ps1'), 'utf8');
    expect(ps).toContain(`$script:OpsSecretNames = @(${OPS_SECRETS.map((n) => `'${n}'`).join(', ')})`);
  });

  it('⑤ lemo-ops 少设了 ALERT_FROM：secret list 只读核对后停在改库之前', async () => {
    const r = await runScript('-Ops', FULL, { secrets: OPS_SECRETS.filter((n) => n !== 'ALERT_FROM') });
    stoppedBeforeDb(r, 'lemo-ops 还缺这些密钥：ALERT_FROM');
    expect(has(r, /^wrangler\tsecret list /u)).toBe(true);
    expect(r.left).toBe(1); // 只剩“确认推送”
  }, 180_000);

  it('⑤ wrangler secret list 失败：停在改库之前', async () => {
    const r = await runScript('-Ops', FULL, { fail: 'secret list' });
    stoppedBeforeDb(r, 'wrangler secret list 退出码 1');
  }, 180_000);

  it('② 装好的依赖树多了一个文件：第 4 步就停，不跑 wrangler、不问令牌', async () => {
    const r = await runScript('-DryRun -Ops', ['一致'], { treeExtra: true });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('装好的 wrangler 依赖树和 tools\\release\\wrangler-tree.lock 对不上：实际文件数 3');
    expect(r.calls).toEqual([]);
    expect(readdirSync(r.temp)).toEqual([]);
  }, 180_000);

  // 第 4 步打包演练（--dry-run）时改一处：第 5 步输令牌之前就停
  const step5: { name: string; tamper: () => string; want: string }[] = [
    { name: '② wrangler 依赖树', tamper: () => 'tree', want: 'wrangler 的依赖树在第 4 步核对之后被改过' },
    { name: '⑦ 临时目录里的网页', tamper: () => 'web', want: '临时目录里的网页和第 3 步核对过的指纹不一样了' },
    { name: '⑥ node_modules\\aws4fetch', tamper: () => join(ctx.repo, 'node_modules', 'aws4fetch', 'package.json'), want: 'node_modules\\aws4fetch 和第 3 步之后记下的不一样了' },
  ];
  for (const c of step5) {
    it(`${c.name}在第 4 步之后被改：第 5 步输令牌之前就停`, async () => {
      try {
        const r = await runScript('-Ops', FULL, { tamperAt: '--dry-run', tamper: c.tamper() });
        stoppedBeforeDb(r, c.want);
        expect(r.out).toContain('还没输入令牌');
        expect(r.prompts).toHaveLength(1);
        expect(r.left).toBe(FULL.length - 1);
      } finally {
        restoreAws4();
      }
    }, 180_000);
  }

  // 部署服务器函数时改一处：部署网页前那次核对拦下，不部署 Pages
  const beforePages: { name: string; tamper: () => string; want: string }[] = [
    { name: '⑦ 临时目录里的网页', tamper: () => 'web', want: '临时目录里的网页和第 3 步核对过的指纹不一样了' },
    { name: '⑥ node_modules\\aws4fetch', tamper: () => join(ctx.repo, 'node_modules', 'aws4fetch', 'package.json'), want: 'node_modules\\aws4fetch 和第 3 步之后记下的不一样了' },
  ];
  for (const c of beforePages) {
    it(`${c.name}在部署函数之后被改：部署网页前停下，不部署 Pages`, async () => {
      try {
        const r = await runScript('-Ops', FULL, { tamperAt: 'functions deploy', tamper: c.tamper() });
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(c.want);
        expect(r.out).toContain('网页还是旧版');
        expect(has(r, /^supabase\tfunctions deploy /u)).toBe(true);
        expect(has(r, /^wrangler\tpages /u)).toBe(false);
        expect(r.envLeft).toBe('');
        noSecrets(r);
      } finally {
        restoreAws4();
      }
    }, 180_000);
  }

  // ⑧ 全局配置：私有的 HOME（~\.gitconfig）和 XDG_CONFIG_HOME（默认的全局属性文件 <XDG>\git\attributes）
  const globalCases: { name: string; gitconfig?: string; attributes?: string; ok: boolean; want: string }[] = [
    { name: '干净的全局配置', ok: true, want: 'git 的全局配置里没有 filter.*、core.attributesfile' },
    { name: '全局 ~\\.gitconfig 里有 filter.x', gitconfig: '[filter "x"]\n\tclean = cat\n', ok: false, want: 'git 的全局配置里有发布时不许有的设置：filter.x.clean' },
    { name: '全局 ~\\.gitconfig 里有 core.attributesfile', gitconfig: '[core]\n\tattributesfile = C:/nowhere/attrs\n', ok: false, want: '不许有的设置：core.attributesfile' },
    { name: '全局 include 进来的文件里有 filter.y', gitconfig: '[include]\n\tpath = more.gitconfig\n', ok: false, want: '不许有的设置：filter.y.smudge' },
    { name: '默认的全局属性文件不为空', attributes: '*.ts filter=x\n', ok: false, want: 'git 的全局属性文件' },
  ];
  for (const c of globalCases) {
    it(`⑧ ${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      const home = join(ctx.dir, `home-${Math.random().toString(36).slice(2, 10)}`);
      const xdg = join(home, 'xdg');
      mkdirSync(join(xdg, 'git'), { recursive: true });
      if (c.gitconfig) writeFileSync(join(home, '.gitconfig'), c.gitconfig, 'utf8');
      writeFileSync(join(home, 'more.gitconfig'), '[filter "y"]\n\tsmudge = cat\n', 'utf8');
      if (c.attributes) writeFileSync(join(xdg, 'git', 'attributes'), c.attributes, 'utf8');
      const r = await runScript('-CheckOnly -Ops', [], { env: { HOME: home, XDG_CONFIG_HOME: xdg } });
      expect(r.code, r.out).toBe(c.ok ? 0 : 1);
      expect(r.out).toContain(c.want);
      expect(r.calls).toEqual([]);
    }, 180_000);
  }

  // R-266 worktree 一级：.git\config 开 extensions.worktreeConfig 后 git 还读 .git\config.worktree（--local 读不到）。
  // 双保险：按级查时 worktree 一级有 filter.*、core.attributesfile 就停（报出是 worktree 一级、哪个文件）；只开 extensions.worktreeConfig 也停
  const WT_OK = 'git 的 worktree 一级配置里没有 filter.*、core.attributesfile';
  const WT_BAD = 'git 的 worktree 一级配置（.git\\config.worktree 之类）里有发布时不许有的设置：';
  const wtCases: { name: string; ext: boolean; worktree: [string, string][]; ok: boolean; want: string[]; not?: string[] }[] = [
    { name: '写了 filter.x.clean', ext: true, worktree: [['filter.x.clean', 'cat']], ok: false, want: [WT_BAD + 'filter.x.clean（', 'config.worktree）'], not: [WT_OK] },
    { name: '写了 core.attributesfile', ext: true, worktree: [['core.attributesFile', 'C:/nowhere/attrs']], ok: false, want: [WT_BAD + 'core.attributesfile（', 'config.worktree）'], not: [WT_OK] },
    { name: '只开 extensions.worktreeConfig（config.worktree 里没有危险项）', ext: true, worktree: [], ok: false, want: [WT_OK, '不许有的设置：extensions.worktreeconfig'], not: [WT_BAD] },
    { name: '正常仓库（没开 extensions.worktreeConfig）', ext: false, worktree: [], ok: true, want: [WT_OK, '.git\\config 里没有过滤程序、include、hooksPath、fsmonitor、extensions.worktreeConfig 之类的设置'] },
  ];
  for (const c of wtCases) {
    it(`R-266 worktree 一级${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      const wtFile = join(ctx.repo, '.git', 'config.worktree');
      try {
        if (c.ext) git(['config', '--local', 'extensions.worktreeConfig', 'true']);
        for (const [k, v] of c.worktree) git(['config', '--worktree', k, v]);
        // 前提成立：git 确实把这些项按 worktree 一级读到了
        if (c.worktree.length > 0) expect(git(['config', '--show-scope', '--list'])).toContain(`worktree\t${c.worktree[0]![0].toLowerCase()}=`);
        const r = await runScript('-CheckOnly -Ops', []);
        expect(r.code, r.out).toBe(c.ok ? 0 : 1);
        for (const w of c.want) expect(r.out).toContain(w);
        for (const w of c.not ?? []) expect(r.out).not.toContain(w);
        expect(r.calls).toEqual([]);
        expect(r.envLeft).toBe('');
      } finally {
        rmSync(wtFile, { force: true });
        if (c.ext) git(['config', '--local', '--unset', 'extensions.worktreeConfig']);
      }
    }, 180_000);
  }

  // R-264 system 一级配置：私有的 GIT_CONFIG_SYSTEM（{dir} 换成这个用例自己的目录，include 用）
  const SYS_OK = 'git 的 system 一级配置里只有 Git for Windows 自带的 git-lfs 设置（4 项，值都对），没有 core.attributesfile';
  const SYS_BAD = 'git 的 system 一级配置里有发布时不许有的设置：';
  const sysCases: { name: string; config: string; ok: boolean; want: string[] }[] = [
    { name: '只有 Git for Windows 自带的四项 filter.lfs.*', config: LFS_SYSTEM_CONFIG, ok: true, want: [SYS_OK] },
    { name: '多一项 filter.x.clean', config: LFS_SYSTEM_CONFIG + '[filter "x"]\n\tclean = cat\n', ok: false, want: [SYS_BAD + 'filter.x.clean（', 'system.gitconfig）'] },
    { name: 'filter.lfs.clean 的值被改', config: LFS_SYSTEM_CONFIG.replace('git-lfs clean -- %f', 'git-lfs clean -- %f & calc'), ok: false, want: [SYS_BAD + 'filter.lfs.clean 的值不是 Git for Windows 默认的「git-lfs clean -- %f」（'] },
    { name: 'filter.lfs.required 改成 false', config: LFS_SYSTEM_CONFIG.replace('required = true', 'required = false'), ok: false, want: ['filter.lfs.required 的值不是 Git for Windows 默认的「true」'] },
    { name: '有 core.attributesfile', config: LFS_SYSTEM_CONFIG + '[core]\n\tattributesfile = C:/nowhere/attrs\n', ok: false, want: [SYS_BAD + 'core.attributesfile（'] },
    { name: 'include 进来的文件里有 filter.y', config: LFS_SYSTEM_CONFIG + '[include]\n\tpath = more.gitconfig\n', ok: false, want: [SYS_BAD + 'filter.y.smudge（', 'more.gitconfig）'] },
    { name: '子节大小写不同的 filter.LFS.clean', config: '[filter "LFS"]\n\tclean = git-lfs clean -- %f\n', ok: false, want: [SYS_BAD + 'filter.LFS.clean（'] },
  ];
  for (const c of sysCases) {
    it(`R-264 system 一级${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      const d = join(ctx.dir, `sys-${Math.random().toString(36).slice(2, 10)}`);
      mkdirSync(d);
      writeFileSync(join(d, 'system.gitconfig'), c.config, 'utf8');
      writeFileSync(join(d, 'more.gitconfig'), '[filter "y"]\n\tsmudge = cat\n', 'utf8');
      const r = await runScript('-CheckOnly -Ops', [], { env: { GIT_CONFIG_SYSTEM: join(d, 'system.gitconfig') } });
      expect(r.code, r.out).toBe(c.ok ? 0 : 1);
      for (const w of c.want) expect(r.out).toContain(w);
      if (!c.ok) expect(r.out).not.toContain(SYS_OK);
      expect(r.calls).toEqual([]);
    }, 180_000);
  }

  // R-265 系统属性文件：脚本第一次调 git 之前设 GIT_ATTR_NOSYSTEM=1，git 不读它；真的 git var GIT_ATTR_SYSTEM 应退出码 1、没有输出
  const NOSYS_OK = 'git 不读系统属性文件（GIT_ATTR_NOSYSTEM=1 已生效）';
  it('R-265 本机真的系统属性文件（Git for Windows 自带的 etc\\gitattributes，不为空也一样）：脚本设了 GIT_ATTR_NOSYSTEM，能过', async () => {
    // 10-30 本机：git var GIT_ATTR_SYSTEM 是 C:/Program Files/Git/etc/gitattributes，515 字节（diff=astextplain 22 行）
    const r = await runScript('-CheckOnly -Ops', [], {});
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(NOSYS_OK);
    expect(r.envLeft).toBe('');
  }, 180_000);

  // 窗口里预先有 GIT_ATTR_NOSYSTEM：一律按脚本设的 1 办
  for (const v of ['0', 'false', 'not-a-bool']) {
    it(`R-265 窗口里预先有 GIT_ATTR_NOSYSTEM=${v}：脚本设成 1，照常能过，结束时清掉`, async () => {
      const r = await runScript('-CheckOnly -Ops', [], { env: { GIT_ATTR_NOSYSTEM: v } });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(NOSYS_OK);
      expect(r.envLeft).toBe('');
    }, 180_000);
  }

  it('R-265 GIT_ATTR_NOSYSTEM 没生效（git var GIT_ATTR_SYSTEM 仍答出路径）：第 1 步就停', async () => {
    const f = join(ctx.dir, `sysattr-${Math.random().toString(36).slice(2, 10)}`);
    writeFileSync(f, '*.ts filter=x\n', 'utf8');
    const r = await runScript('-CheckOnly -Ops', [], { env: { LEMO_FAKE_ATTR_SYSTEM: f } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`本脚本设了 GIT_ATTR_NOSYSTEM=1，git 却仍答出系统属性文件 ${f}`);
    expect(r.out).not.toContain(NOSYS_OK);
    expect(r.calls).toEqual([]);
  }, 180_000);

  // 本机真的 system 一级配置（GIT_CONFIG_SYSTEM 不设）：这台电脑只有 Git for Windows 自带的四项时应放行（不是这样的电脑跳过）
  it.skipIf(!realSystemIsLfsOnly())('R-264 本机真的 system 一级配置（Git for Windows 默认）：不拦', async () => {
    const r = await runScript('-CheckOnly -Ops', [], { env: { GIT_CONFIG_SYSTEM: '' } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(SYS_OK);
  }, 180_000);

  // OPS-deploy-sugg ①：git var 失败（2.42 以前的 git 不认识这两个变量）不再跳过
  for (const v of ['GIT_ATTR_GLOBAL', 'GIT_ATTR_SYSTEM']) {
    it(`① git var ${v} 失败：第 1 步就停，提示要 git 2.42 以上`, async () => {
      const r = await runScript('-CheckOnly -Ops', [], { gitVarFail: v });
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`git var ${v} 失败（退出码 129，本机是 git version `);
      expect(r.out).toContain('要 2.42 以上');
      expect(r.log).toContain(`gitvar-fail\t${v}`);
      expect(r.calls).toEqual([]);
    }, 180_000);
  }

  it('② 令牌太短：停在部署之前，那个 SecureString 已 Dispose', async () => {
    const r = await runScript('-Ops', ['一致', REF, 'short12']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('太短，像是没粘贴上');
    expect(r.secDisposed).toBe('yes');
    expect(has(r, /^supabase\t/u)).toBe(false);
    expect(r.envLeft).toBe('');
  }, 180_000);

  // OPS-deploy-sugg ⑤：手册第三节“第一次部署前设六个密钥”那段命令，原样取出来跑（假 npm 装演练台的假依赖树、假 node、假令牌）
  it('⑤ 手册“设六个密钥”的命令：用 node 跑 wrangler\\bin\\wrangler.js，不再用 .bin\\wrangler.cmd，核对 wrangler-tree.lock', () => {
    const b = manualBlock();
    expect(b).toContain(`Join-Path $nm 'wrangler\\bin\\wrangler.js'`);
    expect(b).toContain(`'tools\\release\\wrangler-tree.lock'`);
    expect(b).not.toMatch(/Join-Path \S+ 'node_modules\\\.bin\\wrangler\.cmd'/u);
    expect(b).not.toMatch(/^\s*& \$w /mu);
  });
  for (const c of [{ name: '依赖树和锁一致：核对后才问令牌，七次 wrangler 都带令牌和关统计的变量，最后全清掉', extra: false }, { name: '依赖树多一个文件：不问令牌、不跑 wrangler', extra: true }]) {
    it(`⑤ 手册“设六个密钥”的命令，${c.name}`, async () => {
      const r = await runManualBlock(c.extra);
      expect(r.left, r.log.join('\n')).toBe(c.extra ? 2 : 0);
      expect(r.log.filter((l) => l.startsWith('envleft\t'))).toEqual(['envleft\t']);
      expect(r.log.some((l) => l.startsWith('templeft\t'))).toBe(false);
      expect(r.log.join('\n').includes(CF_TOKEN)).toBe(false);
      const nodes = r.log.filter((l) => l.startsWith('node\t'));
      if (c.extra) {
        expect(r.log.find((l) => l.startsWith('error\t'))).toContain('装好的 wrangler 依赖树和 wrangler-tree.lock 对不上（实际 3 个文件');
        expect(r.log.some((l) => l.startsWith('prompt\t'))).toBe(false);
        expect(nodes).toEqual([]);
        return;
      }
      expect(r.log.some((l) => l.startsWith('error\t')), r.log.join('\n')).toBe(false);
      clipRightAfterToken(r.log);
      expect(r.log, r.log.join('\n')).toContain('out\twrangler 依赖树和 tools\\release\\wrangler-tree.lock 一致（2 个文件）');
      expect(nodes).toHaveLength(7);
      for (const [i, n] of OPS_SECRETS.entries()) {
        expect(nodes[i]).toMatch(new RegExp(`^node\\t\\S+\\\\node_modules\\\\wrangler\\\\bin\\\\wrangler\\.js secret put ${n} --config workers\\\\lemo-ops\\\\wrangler\\.toml --env-file \\S+empty\\.env\\t`, 'u'));
      }
      expect(nodes[6]).toMatch(/ secret list --config workers\\lemo-ops\\wrangler\.toml --env-file \S+empty\.env\t/u);
      for (const n of nodes) {
        expect(n.split('\t')[2], n).toBe('CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID');
        expect(n.split('\t')[3], n).toBe(`CLOUDFLARE_API_BASE_URL=https://api.cloudflare.com/client/v4;${WRANGLER_QUIET}`);
      }
    }, 60_000);
  }

  // 手册第四节 2b“lemo-ops 跟着回滚到同一个 tag”那段命令：同样删 .bin、核对依赖树、node wrangler.js、设 5 个变量；先不带令牌 --dry-run
  it('⑤ 手册第四节 2b 的命令：用 node 跑 wrangler\\bin\\wrangler.js，不再用 .bin\\wrangler.cmd，核对 wrangler-tree.lock', () => {
    const b = manualBlock('rollback');
    expect(b).toContain(`Join-Path $nm 'wrangler\\bin\\wrangler.js'`);
    expect(b).toContain(`'tools\\release\\wrangler-tree.lock'`);
    expect(b).not.toMatch(/Join-Path \S+ 'node_modules\\\.bin\\wrangler\.cmd'/u);
    expect(b).not.toMatch(/^\s*& \$w /mu);
  });
  for (const c of [{ name: '依赖树和锁一致：先不带令牌 --dry-run，确认后才问令牌部署，最后全清掉', extra: false }, { name: '依赖树多一个文件：不问令牌、不跑 wrangler', extra: true }]) {
    it(`⑤ 手册第四节 2b 的命令，${c.name}`, async () => {
      const tag = `v${ctx.ver}`;
      const r = await runManualBlock(c.extra, 'rollback', [tag, '继续', ACCT, CF_TOKEN]);
      expect(r.left, r.log.join('\n')).toBe(c.extra ? 3 : 0);
      expect(r.log.filter((l) => l.startsWith('envleft\t'))).toEqual(['envleft\t']);
      expect(r.log.some((l) => l.startsWith('templeft\t'))).toBe(false);
      expect(r.log.join('\n').includes(CF_TOKEN)).toBe(false);
      const nodes = r.log.filter((l) => l.startsWith('node\t'));
      if (c.extra) {
        expect(r.log.find((l) => l.startsWith('error\t'))).toContain('装好的 wrangler 依赖树和 wrangler-tree.lock 对不上（实际 3 个文件');
        expect(nodes).toEqual([]);
        return;
      }
      expect(r.log.some((l) => l.startsWith('error\t')), r.log.join('\n')).toBe(false);
      clipRightAfterToken(r.log);
      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toMatch(/^node\t\S+\\node_modules\\wrangler\\bin\\wrangler\.js deploy --config workers\\lemo-ops\\wrangler\.toml --env-file \S+empty\.env --dry-run --outdir \S+\t\t/u);
      expect(nodes[1]).toMatch(new RegExp(`^node\\t\\S+\\\\wrangler\\.js deploy --config workers\\\\lemo-ops\\\\wrangler\\.toml --env-file \\S+empty\\.env --tag ${tag.replace(/\./g, '\\.')}\\tCLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID\\t`, 'u'));
      for (const n of nodes) expect(n.split('\t')[3], n).toBe(`CLOUDFLARE_API_BASE_URL=https://api.cloudflare.com/client/v4;${WRANGLER_QUIET}`);
    }, 60_000);
  }

  // R-266：2b 读 tag 后核对 HEAD 就是这个 tag 的提交。临时给上一个提交打 tag v0.0.1（真 git），副本 HEAD 不是它：不装依赖、不问令牌、不跑 wrangler
  it('R-266 手册第四节 2b 的命令，所填 tag 不是副本检出的提交：停下，不装依赖、不问令牌', async () => {
    const bad = 'v0.0.1';
    git(['tag', '-f', bad, 'HEAD~1']);
    try {
      const r = await runManualBlock(false, 'rollback', [bad, '继续', ACCT, CF_TOKEN]);
      expect(r.left, r.log.join('\n')).toBe(3);
      expect(r.log.find((l) => l.startsWith('error\t'))).toContain(`这个副本检出的不是 ${bad}（HEAD 是 ${git(['rev-parse', 'HEAD'])}，${bad} 指向 ${git(['rev-parse', 'HEAD~1'])}）`);
      expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('node\t'))).toBe(false);
      expect(r.log.filter((l) => l.startsWith('prompt\t'))).toHaveLength(1);
      expect(r.log.filter((l) => l.startsWith('envleft\t'))).toEqual(['envleft\t']);
    } finally {
      git(['tag', '-d', bad]);
    }
  }, 60_000);
  it('R-266 手册第四节 2b 的命令，副本里没有所填的 tag：停下，不问令牌', async () => {
    const r = await runManualBlock(false, 'rollback', ['v99.99.99', '继续', ACCT, CF_TOKEN]);
    expect(r.left, r.log.join('\n')).toBe(3);
    expect(r.log.find((l) => l.startsWith('error\t'))).toContain('这个副本里没有 tag v99.99.99');
    expect(r.log.some((l) => l.startsWith('npm\t') || l.startsWith('node\t'))).toBe(false);
  }, 60_000);
});

// 手册命令里 Read-Host -AsSecureString 读完令牌，紧接着的下一件事就是清剪贴板（演练台的 Set-Clipboard 记一行 clip）
function clipRightAfterToken(log: string[]) {
  const i = log.indexOf('prompt\t粘贴正式 Cloudflare 令牌');
  expect(i, log.join('\n')).toBeGreaterThanOrEqual(0);
  expect(log[i + 1], log.join('\n')).toBe('clip');
}

// 用例改过的那份 aws4fetch\package.json 复原成本仓库的（演练台复制来的）
function restoreAws4() {
  const p = join(ctx.repo, 'node_modules', 'aws4fetch', 'package.json');
  if (ctx.repo && existsSync(p)) copyFileSync(join(root, 'node_modules', 'aws4fetch', 'package.json'), p);
}
