// tools/release/publish.ps1 第 3 步（B7a）：本机不构建，下载 CI 在这个 tag 上构建好的发布包，按 SHA256SUMS 逐个核对后部署；
// 另有 -Env preview 预览演练、改库前触发 backup-daily、-SiteOrigin https://lemomemo.pages.dev 首发。
// 原 publish-run-shared.test.ts（本机跑 copy_shared 生成 _shared\gen）换成这里：_shared\gen 由 CI 生成进发布包，脚本按同样的规则核。
// 演练台见 publish-run-harness.ts（假仓库、假工具、假令牌），假发布包见 publish-run-pack.ts，假 GitHub、假 SQL 接口见 publish-run-fakes.ts。
// 不连 Cloudflare、Supabase、GitHub，不真的部署。只在 Windows 上跑。
import { readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCT, CF_TOKEN, ctx, DB_PW, DRY, FULL, GH_TOKEN, has, noSecrets, PREVIEW_REF, PREVIEW_RUN, PS, REF, runScript, SB_TOKEN, setup, teardown,
  type Run, type RunOpts,
} from './publish-run-harness.ts';

const PREVIEW = [GH_TOKEN, '一致', PREVIEW_REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'];
const GEN_HEAD = '// 生成文件：由 build/copy_shared.mjs';

/** 停在第 3 步（下载核对）：没装部署工具、没问部署令牌、没调 supabase / wrangler，GitHub 下载令牌已 Dispose */
function stoppedAtDownload(r: Run, want: string) {
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain(want);
  expect(r.calls, r.calls.join('\n')).toEqual([]);
  expect(r.log.some((l) => l.startsWith('download\thttps://github.com/supabase/cli/')), '核对没过就去装 Supabase CLI 了').toBe(false);
  expect(r.prompts.filter((p) => p.includes('粘贴到这里'))).toHaveLength(1);
  expect(r.secDisposed).toBe('yes');
  expect(r.envLeft).toBe('');
  noSecrets(r);
}

/** 发布包暂存目录里 _shared\gen 的第一个 .ts */
function firstGen(stage: string): string {
  const dir = join(stage, 'supabase', 'functions', '_shared', 'gen');
  const f = readdirSync(dir, { recursive: true, withFileTypes: true }).find((e) => e.isFile() && e.name.endsWith('.ts'));
  if (!f) throw new Error('假发布包里没有 _shared/gen/*.ts');
  return join(f.parentPath, f.name);
}
function firstMigration(stage: string): string {
  const dir = join(stage, 'supabase', 'migrations');
  return join(dir, readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()[0] ?? '');
}

describe.skipIf(!PS)('publish.ps1 第 3 步下载核对 CI 发布包、预览演练、backup-daily、pages.dev 首发（假仓库、假工具、假令牌）', () => {
  beforeAll(setup, 300_000);
  afterAll(teardown);

  // ---------------------------------------------------------------- 发布包本身不对：第 3 步就停
  const packCases: { name: string; pack: RunOpts['pack']; want: string }[] = [
    { name: '下载后网页文件被换（SHA256SUMS 写完以后改）', pack: { after: (s) => writeFileSync(join(s, 'dist', 'web', 'index.html'), 'evil\n', 'utf8') }, want: '发布包里的文件和 SHA256SUMS 对不上：内容不同 dist/web/index.html' },
    { name: '多一个清单里没有的文件', pack: { after: (s) => writeFileSync(join(s, 'dist', 'web', 'extra.js'), 'x\n', 'utf8') }, want: '发布包里的文件和 SHA256SUMS 对不上：多了 dist/web/extra.js' },
    { name: '清单里有、包里少了一个', pack: { after: (s) => rmSync(join(s, 'dist', 'web', 'index.html')) }, want: '发布包里的文件和 SHA256SUMS 对不上：少了 dist/web/index.html' },
    { name: '点开头的文件（.env）', pack: { before: (s) => writeFileSync(join(s, 'supabase', 'functions', '.env'), 'X=1\n', 'utf8') }, want: '发布包 zip 里有不允许的路径：supabase/functions/.env' },
    { name: 'version.json 不是这次的版本', pack: { before: (s) => writeFileSync(join(s, 'dist', 'web', 'app', 'version.json'), '{"version":"0.0.1"}', 'utf8') }, want: '发布包里 version.json 的版本是「0.0.1」' },
    { name: '没有打包好的 _worker.js', pack: { before: (s) => rmSync(join(s, 'dist', 'web', '_worker.js'), { recursive: true }) }, want: '发布包里没有打包好的 Pages Functions' },
    { name: '带 source map', pack: { before: (s) => writeFileSync(join(s, 'dist', 'web', 'a.js.map'), '{}', 'utf8') }, want: '发布包的 dist\\web 里有 source map' },
    { name: '迁移和 tag 的源码不一样', pack: { before: (s) => writeFileSync(firstMigration(s), 'drop table x;\n', 'utf8') }, want: '（和仓库里的不一样）' },
    { name: '少了一个被跟踪的迁移', pack: { before: (s) => rmSync(firstMigration(s)) }, want: '（发布包里缺）' },
    { name: '正式包里混进预览专用函数的入口', pack: { before: (s) => { mkdirSync(join(s, 'supabase', 'functions', 'voice-probe'), { recursive: true }); writeFileSync(join(s, 'supabase', 'functions', 'voice-probe', 'index.ts'), "import '../_preview/voice-probe/index.ts';\n", 'utf8'); } }, want: 'supabase/functions/voice-probe/index.ts（仓库这个 tag 里没有）' },
    { name: '_shared\\gen 是原样复制的（没有 copy_shared 的文件头）', pack: { before: (s) => writeFileSync(firstGen(s), "export const x = 1;\n", 'utf8') }, want: '不是 copy_shared 生成的' },
    { name: '_shared\\gen 裸引 zod', pack: { before: (s) => writeFileSync(firstGen(s), `${GEN_HEAD} 生成\nimport { z } from 'zod';\nexport const x = z;\n`, 'utf8') }, want: '（裸引 zod）' },
    { name: '_shared\\gen 引的版本不是 deno.json 锁的', pack: { before: (s) => writeFileSync(firstGen(s), `${GEN_HEAD} 生成\nimport { z } from 'npm:zod@0.0.1';\nexport const x = z;\n`, 'utf8') }, want: '引的 npm:zod@0.0.1 不是 supabase\\functions\\deno.json 锁的版本' },
    { name: '_shared\\gen 整个没有', pack: { before: (s) => rmSync(join(s, 'supabase', 'functions', '_shared', 'gen'), { recursive: true }) }, want: '_shared\\gen 里没有生成的文件' },
  ];
  for (const c of packCases) {
    it(`发布包${c.name}：第 3 步就停，不装工具、不问部署令牌`, async () => {
      const r = await runScript('-DryRun -Ops', DRY, { pack: c.pack });
      stoppedAtDownload(r, c.want);
    }, 180_000);
  }

  // ---------------------------------------------------------------- GitHub 那边不对：第 3 步就停
  const ghCases: { name: string; o: RunOpts; want: string }[] = [
    { name: '下载令牌 401', o: { gh: 'list' }, want: 'GitHub 接口读不了（HTTP' },
    { name: '没有这个产物', o: { gh: 'none' }, want: `GitHub 上找不到 release-build 在 v` },
    { name: '产物来自 fork 的运行', o: { gh: 'fork' }, want: 'GitHub 上找不到' },
    { name: '产物是别的提交构建的', o: { headSha: '0'.repeat(40) }, want: 'GitHub 上找不到' },
    { name: '下载那一步回 401', o: { gh: 'zip' }, want: '下载产物时 GitHub 没有给出下载地址' },
  ];
  for (const c of ghCases) {
    it(`${c.name}：第 3 步就停`, async () => {
      const r = await runScript('-DryRun -Ops', DRY, c.o);
      stoppedAtDownload(r, c.want);
      expect(r.out).toContain('没改任何东西');
    }, 180_000);
  }

  it('下载令牌是经典令牌（ghp_）：不发任何请求就停', async () => {
    const r = await runScript('-DryRun -Ops', ['ghp_' + 'TEST_ONLY_classic_token_'.padEnd(36, 'z'), '一致']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('这不像 GitHub 的细粒度令牌');
    expect(r.log.some((l) => l.startsWith('gh\t') || l.startsWith('ghzip\t'))).toBe(false);
    expect(r.secDisposed).toBe('yes');
    expect(r.calls).toEqual([]);
  }, 180_000);

  it('核对 Summary 页以后没输入“一致”：停下，不装工具', async () => {
    const r = await runScript('-DryRun -Ops', [GH_TOKEN, '不一致']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('请在 iPhone 上打开这一次运行的 Summary 页：https://github.com/hufanpiao/lemomemo/actions/runs/555');
    expect(r.out).toContain('找标题是“发布包指纹”的那一段');
    expect(r.out).toContain('没有输入「一致」，已取消');
    expect(r.log.some((l) => l.startsWith('download\thttps://github.com/supabase/cli/'))).toBe(false);
    expect(r.calls).toEqual([]);
  }, 180_000);

  // ---------------------------------------------------------------- 预览演练
  it('-Env preview 完整演练：找 preview-bundle、部署到 lemomemo-preview、函数含预览专用的、核对预览站点的版本', async () => {
    const r = await runScript('-Env preview', PREVIEW);
    expect(r.code, r.out).toBe(0);
    expect(r.left).toBe(0);
    expect(r.out).toContain('柠檬记预览演练');
    expect(r.out).toContain('预览演练不做版本前源码备份');
    expect(r.out).toContain('找标题是“预览产物清单”的那一段');
    expect(r.log.find((l) => l.startsWith('gh\t'))).toContain('/actions/artifacts?name=preview-bundle&');
    const fn = r.calls.find((c) => c.startsWith('supabase\tfunctions deploy')) ?? '';
    expect(fn).toContain(' voice-probe ');
    expect(fn).toContain(`--project-ref ${PREVIEW_REF} `);
    expect(r.calls.find((c) => c.startsWith('wrangler\tpages deploy'))).toContain('--project-name lemomemo-preview ');
    expect(has(r, /^wrangler\tdeploy --config \S+ --tag/u)).toBe(false);
    expect(r.log.find((l) => l.startsWith('version\t'))).toBe('version\thttps://preview.lemomemo.com/app/version.json');
    expect(r.out).toContain(`线上已是 ${ctx.ver}-preview.${PREVIEW_RUN}`);
    expect(r.out).toContain('预览演练完成');
    expect(r.envLeft).toBe('');
    noSecrets(r);
  }, 180_000);

  it('-Env preview 加 -Ops：第 1 步就停（预览环境没有 lemo-ops）', async () => {
    const r = await runScript('-Env preview -Ops', []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('预览演练不部署 lemo-ops');
    expect(r.calls).toEqual([]);
  }, 180_000);

  it('-Env preview 的 tag 运行号和 GitHub 上的运行号对不上：找不到产物', async () => {
    const r = await runScript('-Env preview -DryRun', DRY, { runNo: PREVIEW_RUN + 1 });
    stoppedAtDownload(r, `GitHub 上找不到 deploy-preview 第 ${PREVIEW_RUN} 次运行`);
  }, 180_000);

  it('-Env preview 贴了别的项目的 ref：停在改库之前', async () => {
    const r = await runScript('-Env preview', [GH_TOKEN, '一致', REF]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('预览演练只能发到预览项目');
    expect(has(r, /^supabase\t/u)).toBe(false);
  }, 180_000);

  it('正式发布贴了预览项目的 ref：停在改库之前', async () => {
    const r = await runScript('-Ops', [GH_TOKEN, '一致', PREVIEW_REF]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('这是预览项目的 ref，正式发布不能发到预览项目');
    expect(has(r, /^supabase\t/u)).toBe(false);
  }, 180_000);

  // ---------------------------------------------------------------- 改库前触发 backup-daily
  it('backup-daily：正式环境触发后交给 tools\\backup\\pull.ps1 等、下载、做发布前快照（不给它令牌），退出码 0 才 link、db push', async () => {
    const r = await runScript('-Ops', FULL, { backup: 'ok' });
    expect(r.code, r.out).toBe(0);
    const dbq = r.log.filter((l) => l.startsWith('dbq\t'));
    expect(dbq.every((l) => l.split('\t')[1] === 'Post' && l.split('\t')[2] === 'True' && l.split('\t')[3] === '0'), dbq.join('\n')).toBe(true);
    // B7a 评审第 5、7 条：经 private.backup_dispatch('publish') 触发（单独计次数），等的人数是它的回值（2），不是可用账号数（3）
    expect(dbq.some((l) => l.includes("select private.backup_dispatch('publish') as n"))).toBe(true);
    expect(dbq.some((l) => l.includes('cron.job'))).toBe(false);
    // 正式环境不在 SQL 里数 _manifest（那是预览演练的做法），由 pull.ps1 经 backup-manifest 等
    expect(dbq.some((l) => l.includes('storage.objects'))).toBe(false);
    const pull = r.log.filter((l) => l.startsWith('pull\t'));
    expect(pull).toHaveLength(1);
    const [, args = '', envLeft = 'x'] = (pull[0] ?? '').split('\t');
    // B7a 评审第 8 条：发版时跳过图片附件同步和清理（三道保险的退出码 3 不挡发版）；复审第 7 条：-Today 是数据库给的首尔日期，不用本机时钟
    expect(args).toMatch(/^-NoProfile -ExecutionPolicy Bypass -File \S+\\tools\\backup\\pull\.ps1 -Today 2026-11-26 -WaitForToday -ExpectCount 2 -Since 2026-11-26T01:02:03Z -Snapshot v\d+\.\d+\.\d+ -SkipFiles -SkipCleanup$/u);
    expect(envLeft).toBe('');
    expect(r.out).toContain('改库前的备份已下载核对到本机');
    expect(r.log.indexOf(pull[0] ?? '')).toBeLessThan(r.log.findIndex((l) => l.startsWith('supabase\tlink')));
    noSecrets(r);
  }, 180_000);

  it('backup-daily：预览演练不调 pull.ps1（它只认正式站），在 SQL 里等到每人当天的 _manifest.json.gz 都写完', async () => {
    const r = await runScript('-Env preview', PREVIEW, { backup: 'ok' });
    expect(r.code, r.out).toBe(0);
    expect(r.log.some((l) => l.startsWith('pull\t'))).toBe(false);
    expect(r.out).toContain('改库前的备份做完了（2 个账号，backups/2026-11-26/）');
  }, 180_000);

  it.each([
    ['pull.ps1 退出码 1（本机配置或凭据）', 1, '本机问题'],
    ['pull.ps1 退出码 2（等不完或网络）', 2, '服务器或网络失败'],
    ['pull.ps1 退出码 3（带了 -SkipCleanup 不该出现）', 3, '退出码 3'],
  ])('backup-daily %s：停在改库之前', async (_n, pull, want) => {
    const r = await runScript('-Ops', FULL, { backup: 'ok', pull });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`pull.ps1 没有做完改库前的备份：${want}`);
    expect(r.out).toContain('还没改库');
    expect(has(r, /^supabase\t/u)).toBe(false);
    noSecrets(r);
  }, 180_000);

  it.each([
    ['有账号没有 backup_dispatch', '-Ops', 'nojob' as const, '却没有 private.backup_dispatch'],
    ['预览演练一直做不完', '-Env preview', 'slow' as const, 'backup-daily 等了 80 秒只做完 1 / 2 个账号'],
    ['令牌没有 Database 读写（403）', '-Ops', 'deny' as const, 'Supabase 的 SQL 接口执行不了（HTTP'],
  ])('backup-daily %s：停在改库之前', async (_n, extra, backup, want) => {
    const r = await runScript(extra, extra === '-Ops' ? FULL : PREVIEW, { backup });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(want);
    expect(r.out).toContain('还没改库');
    expect(has(r, /^supabase\t/u)).toBe(false);
    expect(has(r, /^wrangler\t(pages|deploy --config \S+ --tag)/u)).toBe(false);
    expect(r.envLeft).toBe('');
    noSecrets(r);
  }, 180_000);

  it('-Only functions 不改库，不触发 backup-daily', async () => {
    const r = await runScript('-Only functions -Ops', [GH_TOKEN, '一致', REF, SB_TOKEN, CF_TOKEN, ACCT, 'lemomemo'], { backup: 'ok' });
    expect(r.code, r.out).toBe(0);
    expect(r.log.some((l) => l.startsWith('dbq\t'))).toBe(false);
  }, 180_000);

  // ---------------------------------------------------------------- 先发到 pages.dev，再绑域名
  it('-SiteOrigin https://lemomemo.pages.dev：核对 pages.dev 上的版本，收尾提示首发顺序', async () => {
    const r = await runScript('-Ops -SiteOrigin https://lemomemo.pages.dev', FULL);
    expect(r.code, r.out).toBe(0);
    expect(r.log.find((l) => l.startsWith('version\t'))).toBe('version\thttps://lemomemo.pages.dev/app/version.json');
    expect(r.out).toContain('set-fn-role-passwords.ps1 -Target production（必须在第一次 db push 之后）');
    expect(r.out).toContain('绑定 lemomemo.com');
  }, 180_000);

  it.each([
    ['正式发布填了别的地址', '-Ops -SiteOrigin https://evil.example.test', '正式环境的 -SiteOrigin 只能是 https://lemomemo.com 或 https://lemomemo.pages.dev'],
    ['正式发布填了预览的 Pages 项目', '-Ops -PagesProject lemomemo-preview', '正式环境的 Pages 项目是 lemomemo'],
    ['预览演练填了正式站点', '-Env preview -SiteOrigin https://lemomemo.com', '预览环境的 -SiteOrigin 只能是'],
  ])('%s：第 1 步就停', async (_n, extra, want) => {
    const r = await runScript(extra, []);
    expect(r.code).toBe(1);
    expect(r.out).toContain(want);
    expect(r.calls).toEqual([]);
    expect(r.log.some((l) => l.startsWith('gh\t'))).toBe(false);
  }, 180_000);
});
