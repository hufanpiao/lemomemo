// tools/release/publish.ps1 的 B1 接手清单 OPS-deploy ②③⑤⑥⑦⑧（演练台见 publish-run-harness.ts：假仓库、假工具、假令牌、每次运行私有的 TEMP）：
// ② 装好的 wrangler 依赖树和 tools/release/wrangler-tree.lock 对不上就停（第 4 步装完一次、第 5 步输令牌前一次）；
// ③ 每个子进程只拿它要的那把令牌（只核对“哪个子进程拿到了哪些环境变量名”，假令牌的值不进日志）；本进程自己的环境变量里平时没有令牌；
// ⑤ 改库前 wrangler secret list 只读核对 lemo-ops 的六个密钥（假工具打印名单，不调真的）；
// ⑥ 第 3 步之后 node_modules\aws4fetch 记哈希，改库前、部署网页前各比一次；
// ⑦ dist\web 复制到临时目录，核对后从那里部署；
// ⑧ git 各级配置（全局、system、worktree）、系统属性文件、git var、属性来源（GIT_ATTR_SOURCE、attr.tree）的检查拆到了 publish-run-worktree.test.ts；
// OPS-deploy-sugg ② 令牌太短时那个 SecureString 已 Dispose；⑤ 手册第三节“设六个密钥”、第四节 2b 两段命令（假 npm、假 node、假令牌）；
// R-266 2b 核对所填 tag 就是副本检出的提交。
// 不连 Cloudflare、Supabase、GitHub，不真的部署。只在 Windows 上跑。
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCT, CF_TOKEN, ctx, DB_PW, git, has, noSecrets, OPS_SECRETS, PS, REF, root, runScript, SB_TOKEN, setup, teardown, WRANGLER_QUIET, wranglerSafe, type Run,
} from './publish-run-harness.ts';
import { manualBlock, runManualBlock } from './publish-run-manual.ts';
import { EVIL_FILE, gitTry, guardRepoConfig, plantSameLength } from './publish-run-gitguard.ts';

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

  // R-269：同样长度改文件、再把修改时间改回去，git status 看不出来；脚本用临时索引逐个比内容，第 1 步就停
  const CONTENT_OK = '被跟踪的文件逐个比过内容（不靠大小和修改时间），和检出的提交一致';
  it('R-269 前提：同长度改 package.json 并还原修改时间，git status 为空（旧做法被骗过）', () => {
    const restore = guardRepoConfig([EVIL_FILE]);
    try {
      const evil = plantSameLength();
      expect(readFileSync(join(ctx.repo, EVIL_FILE), 'utf8')).toBe(evil);
      expect(evil).not.toBe(git(['show', `HEAD:${EVIL_FILE}`]));
      expect(gitTry(['status', '--porcelain', '--untracked-files=all']).out).toBe('');
    } finally {
      restore();
    }
  });
  it('R-269 同长度改过、修改时间还原：第 1 步就停，只列文件名，临时索引删掉了，GIT_INDEX_FILE 没留下', async () => {
    const restore = guardRepoConfig([EVIL_FILE]);
    try {
      plantSameLength();
      const r = await runScript('-CheckOnly -Ops', []);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('工作区干净');
      expect(r.out).toContain(`git status 却看不出来（大小、修改时间都没变）：${EVIL_FILE}。没输入任何令牌`);
      expect(r.out).not.toContain(CONTENT_OK);
      expect(r.calls).toEqual([]);
      expect(r.envLeft).toBe('');
      expect(readdirSync(r.temp).filter((f) => f.startsWith('lemo-index-'))).toEqual([]);
    } finally {
      restore();
    }
  }, 180_000);
  it('R-269 正常仓库：逐个比内容通过（CRLF、.gitattributes 转换不误报），临时索引删掉了', async () => {
    const r = await runScript('-CheckOnly -Ops', []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(CONTENT_OK);
    expect(r.envLeft).toBe('');
    expect(readdirSync(r.temp).filter((f) => f.startsWith('lemo-index-'))).toEqual([]);
  }, 180_000);
  it('R-269 第 1 步和第 5 步都在 git status 之后逐个比内容（静态核对）', () => {
    const ps = readFileSync(join(root, 'tools', 'release', 'publish.ps1'), 'utf8');
    const body = (name: string) => ps.slice(ps.indexOf(`function ${name}`), ps.indexOf('\n}', ps.indexOf(`function ${name}`)));
    for (const f of ['Invoke-Checks', 'Assert-StillClean']) expect(body(f), f).toMatch(/'status', '--porcelain'[\s\S]*\n\s*Assert-ContentMatchesHead\n/u);
    expect(body('Assert-ContentMatchesHead')).toMatch(/SetEnvironmentVariable\('GIT_INDEX_FILE', \$idx[\s\S]*'read-tree', 'HEAD'[\s\S]*'diff-files'[\s\S]*finally[\s\S]*SetEnvironmentVariable\('GIT_INDEX_FILE', \$old/u);
  });
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
