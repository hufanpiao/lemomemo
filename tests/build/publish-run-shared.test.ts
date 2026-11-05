// tools/release/publish.ps1 的 PUBLISH-shared-rewrite（11-05，账号信代码审查顺带发现）：
// 正式发布原来用 Copy-Item 原样复制 shared\* 到 supabase\functions\_shared\gen，裸包名 zod、aws4fetch 没改写成 npm:包@版本；
// functions deploy --use-api 不读 supabase\functions\deno.json，account、account-purge、invite-admin 部署时解析不了这两个包。
// 改成改库之前跑 build\copy_shared.mjs（和 CI、deploy-preview 一样）并核对生成结果，部署函数前再核一次。
// B2 安全审查 P1（11-05）：生成前先删 gen（copy_shared 静默不生成就停在改库前）；生成后记指纹、部署函数前再比（中途改内容、文件头还在也停）。
// 建议 P-S1：gen 里引的 npm:包@版本 必须和 supabase\functions\deno.json 的 imports 一致。
// 演练台见 publish-run-harness.ts：假仓库、假工具、假令牌；假 node 跑 copy_shared 时转给真的 node（只在假仓库里生成文件）。
// 不连 Cloudflare、Supabase、GitHub，不真的部署。只在 Windows 上跑。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyShared } from '../../build/copy_shared.mjs';
import { ctx, has, noSecrets, PS, REF, runScript, SB_TOKEN, CF_TOKEN, DB_PW, ACCT, setup, teardown, type Run } from './publish-run-harness.ts';

const FULL = ['一致', REF, SB_TOKEN, DB_PW, CF_TOKEN, ACCT, 'lemomemo', '确认推送'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 停在改库之前：没调 supabase（连 link 都没有），没部署任何东西 */
function stoppedBeforeSupabase(r: Run, want: string) {
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain(want);
  expect(r.out).toContain('还没改库、没部署任何代码');
  expect(has(r, /^supabase\t/u)).toBe(false);
  expect(has(r, /^wrangler\t(pages|deploy --config \S+ --tag)/u)).toBe(false);
  expect(r.envLeft).toBe('');
  noSecrets(r);
}

describe.skipIf(!PS)('publish.ps1 PUBLISH-shared-rewrite：部署函数前用 copy_shared 生成 _shared\\gen（假仓库、假工具、假令牌）', () => {
  beforeAll(setup, 300_000);
  afterAll(teardown);

  it('正式路径：改库前跑 node build\\copy_shared.mjs；生成的 _shared\\gen 里 zod、aws4fetch 都改写成 npm:包@版本，没有裸引', async () => {
    const r = await runScript('-Ops', FULL);
    expect(r.code, r.out).toBe(0);
    const node = r.log.findIndex((l) => l === 'node\tbuild\\copy_shared.mjs');
    expect(node, '没跑 copy_shared').toBeGreaterThanOrEqual(0);
    expect(node).toBeLessThan(r.log.findIndex((l) => l.startsWith('supabase\tlink ')));
    expect(r.out.split('_shared\\gen 由 build\\copy_shared.mjs 生成').length - 1, '改库前、部署函数前各核一次').toBe(2);
    const gen = join(ctx.repo, 'supabase', 'functions', '_shared', 'gen');
    const files = walk(gen);
    expect(files.length).toBeGreaterThan(10);
    const pkg = JSON.parse(readFileSync(join(ctx.repo, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    let zod = 0;
    let aws = 0;
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect(t.startsWith('// 生成文件：由 build/copy_shared.mjs'), f).toBe(true);
      expect(t, f).not.toMatch(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](zod|aws4fetch)['"]/u);
      if (t.includes(`'npm:zod@${pkg.dependencies['zod']}'`)) zod++;
      if (t.includes(`'npm:aws4fetch@${pkg.dependencies['aws4fetch']}'`)) aws++;
    }
    expect(zod).toBeGreaterThan(0);
    expect(aws).toBeGreaterThan(0);
    noSecrets(r);
  }, 240_000);

  it('回滚 -Only functions：同样先跑 copy_shared 再部署函数', async () => {
    const r = await runScript('-Only functions -Ops', [REF, SB_TOKEN, CF_TOKEN, ACCT, 'lemomemo']);
    expect(r.code, r.out).toBe(0);
    const node = r.log.findIndex((l) => l === 'node\tbuild\\copy_shared.mjs');
    expect(node).toBeGreaterThanOrEqual(0);
    expect(node).toBeLessThan(r.log.findIndex((l) => l.startsWith('supabase\tfunctions deploy ')));
    expect(r.out.split('_shared\\gen 由 build\\copy_shared.mjs 生成').length - 1).toBe(2);
  }, 240_000);

  it('copy_shared 失败（例如 shared 引了不许的包）：停在改库之前', async () => {
    const r = await runScript('-Ops', FULL, { copyShared: 'fail' });
    stoppedBeforeSupabase(r, 'node build\\copy_shared.mjs 退出码 1');
  }, 240_000);

  it('_shared\\gen 里混进一个原样复制的文件（原来的 Copy-Item 做法）：核对不过，停在改库之前', async () => {
    const r = await runScript('-Ops', FULL, { copyShared: 'raw' });
    stoppedBeforeSupabase(r, 'schema\\kinds.ts（不是 copy_shared 生成的）');
  }, 240_000);

  it('_shared\\gen 里有一处裸引 aws4fetch：核对不过，停在改库之前', async () => {
    const r = await runScript('-Ops', FULL, { copyShared: 'bare' });
    stoppedBeforeSupabase(r, 'schema\\kinds.ts（裸引 aws4fetch）');
  }, 240_000);

  it('B2 安全审查 P1：copy_shared 静默不生成（退出码 0、一个文件都没写），仓库里留着旧 gen 也不沿用：先删掉旧的，核对因“没有生成的文件”停在改库之前', async () => {
    const gen = join(ctx.repo, 'supabase', 'functions', '_shared', 'gen');
    copyShared(gen);   // 旧 gen：带文件头、没有裸引，原来的两次核对都会放行
    expect(existsSync(join(gen, 'schema', 'rows.ts'))).toBe(true);
    const r = await runScript('-Ops', FULL, { copyShared: 'noop' });
    stoppedBeforeSupabase(r, 'supabase\\functions\\_shared\\gen 里没有生成的文件（build\\copy_shared.mjs 没跑成）');
    expect(existsSync(gen), '旧 gen 应该在跑 copy_shared 之前被删掉').toBe(false);
  }, 240_000);

  it('B2 安全审查 P1：生成以后、部署函数之前 gen 里一个文件被改（文件头还在、没有裸引）：比指纹停下，迁移已推、函数没部署', async () => {
    const kinds = join(ctx.repo, 'supabase', 'functions', '_shared', 'gen', 'schema', 'kinds.ts');
    const r = await runScript('-Ops', FULL, { tamperAt: 'db push --linked --dry-run', tamper: kinds });
    expect(r.code, r.out).toBe(1);
    expect(readFileSync(kinds, 'utf8').endsWith('tampered'), '假工具应该改了 kinds.ts').toBe(true);
    expect(r.out).toContain('supabase\\functions\\_shared\\gen 和生成后记下的指纹不一样了（生成以后被改过）。数据库迁移已推，服务器函数、lemo-ops、网页都还是旧版，没部署任何代码');
    expect(r.out.split('_shared\\gen 由 build\\copy_shared.mjs 生成').length - 1, '只核了改库前那一次').toBe(1);
    expect(has(r, /^supabase\tdb push --linked --yes/u), r.calls.join('\n')).toBe(true);
    expect(has(r, /^supabase\tfunctions deploy/u)).toBe(false);
    expect(has(r, /^wrangler\t(pages|deploy --config \S+ --tag)/u)).toBe(false);
    expect(r.envLeft).toBe('');
    noSecrets(r);
  }, 240_000);

  it('B2 安全审查 P1：正常发布时两次都比指纹一致才部署函数', async () => {
    const r = await runScript('-Only functions -Ops', [REF, SB_TOKEN, CF_TOKEN, ACCT, 'lemomemo']);
    expect(r.code, r.out).toBe(0);
    expect(r.out.split('_shared\\gen 和生成后记下的指纹一致').length - 1).toBe(1);
  }, 240_000);

  it('建议 P-S1：gen 里引的 npm:zod@版本 和 supabase\\functions\\deno.json 锁的不一样：停在改库之前', async () => {
    const r = await runScript('-Ops', FULL, { copyShared: 'ver' });
    stoppedBeforeSupabase(r, 'schema\\kinds.ts（引的 npm:zod@0.0.1 不是 supabase\\functions\\deno.json 锁的版本）');
  }, 240_000);

  it('B2 安全审查 P1 静态核对：删旧 gen 在跑 copy_shared 之前；第一次核对之后记指纹；部署函数之前先比指纹', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'tools', 'release', 'publish.ps1'), 'utf8');
    const del = src.indexOf('if (Test-Path -LiteralPath $genDir) { Remove-Item -LiteralPath $genDir -Recurse -Force }');
    const run = src.indexOf("& node 'build\\copy_shared.mjs'");
    const first = src.indexOf("Assert-SharedRewritten '还没改库、没部署任何代码'");
    const hash = src.indexOf('$script:GenHash = Get-DistHash $genDir');
    const cmp = src.indexOf('        Assert-GenUnchanged "');
    const fn = src.indexOf("@('functions', 'deploy')");
    expect(del).toBeGreaterThan(0);
    expect(del).toBeLessThan(run);
    expect(run).toBeLessThan(first);
    expect(first).toBeLessThan(hash);
    expect(hash).toBeLessThan(cmp);
    expect(cmp).toBeLessThan(fn);
  });

  it('脚本里不再有 Copy-Item 复制 shared\\* 的写法', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'tools', 'release', 'publish.ps1'), 'utf8');
    expect(src).not.toMatch(/Copy-Item[^\n]*'shared\\\*'/u);
    expect(src).toContain("& node 'build\\copy_shared.mjs'");
    expect(src).toContain('if ($LASTEXITCODE -ne 0) { Fail "node build\\copy_shared.mjs 退出码 $LASTEXITCODE');
  });
});
