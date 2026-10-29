// tools/release/publish.ps1 的 B1 接手清单 OPS-deploy ②③⑤⑥⑦⑧（演练台见 publish-run-harness.ts：假仓库、假工具、假令牌、每次运行私有的 TEMP）：
// ② 装好的 wrangler 依赖树和 tools/release/wrangler-tree.lock 对不上就停（第 4 步装完一次、第 5 步输令牌前一次）；
// ③ 每个子进程只拿它要的那把令牌（只核对“哪个子进程拿到了哪些环境变量名”，假令牌的值不进日志）；本进程自己的环境变量里平时没有令牌；
// ⑤ 改库前 wrangler secret list 只读核对 lemo-ops 的六个密钥（假工具打印名单，不调真的）；
// ⑥ 第 3 步之后 node_modules\aws4fetch 记哈希，改库前、部署网页前各比一次；
// ⑦ dist\web 复制到临时目录，核对后从那里部署；
// ⑧ git 全局配置里的 filter.*、core.attributesfile、全局属性文件（演练用私有的 HOME、XDG_CONFIG_HOME，不碰本机的全局配置）。
// 不连 Cloudflare、Supabase、GitHub，不真的部署。只在 Windows 上跑。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCT, CF_TOKEN, ctx, DB_PW, has, noSecrets, OPS_SECRETS, PS, REF, root, runScript, SB_TOKEN, setup, teardown, wranglerSafe, type Run,
} from './publish-run-harness.ts';

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
});

// 用例改过的那份 aws4fetch\package.json 复原成本仓库的（演练台复制来的）
function restoreAws4() {
  const p = join(ctx.repo, 'node_modules', 'aws4fetch', 'package.json');
  if (ctx.repo && existsSync(p)) copyFileSync(join(root, 'node_modules', 'aws4fetch', 'package.json'), p);
}
