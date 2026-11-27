// D1 和 login-probe 不许在本机连仓库那套库（54322、lemomemo；11-05 安全红线，后端误连过一次）：
// ① build/d1/db-target.mjs 的 d1Target：本机必须设 D1_DB_URL 指 55322；没设只有 CI（config 已改成 lemo-ci、没有 .env*）才用默认 54322；
// ② build/check_data_manifest.ts、build/ci/d1_negative.mjs 连库之前先过 d1Target，源码里不再写默认连接串；deno.json 的 d1 任务给了 CI 变量；
// ③ supabase/tests/auth/login-probe.mjs 先过 store-it 护栏（checkRepoSupabase），本机退出码 2、不调 supabase status；
// ④ 扫一遍 build/、tools/、supabase/tests/ 的脚本：除 db-target.mjs 外没有写死 127.0.0.1:54322 的连接串。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_DEFAULT_URL, d1Target } from '../../build/d1/db-target.mjs';

const root = join(import.meta.dirname, '..', '..');
const E2E = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';
const CI_REPO = () => ({ configText: '# x\nproject_id = "lemo-ci"\n[api]\nport = 54321\n', dirListing: { './': ['package.json'], 'supabase/': ['config.toml'] } });
const never = () => { throw new Error('不该读仓库'); };
const problem = (r: { url?: string; problem?: string }) => r.problem ?? '';

/** 本机环境：去掉 CI 和 D1_DB_URL */
function localEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CI' || k === 'D1_DB_URL' || /^supabase_/i.test(k)) delete env[k];
  return { ...env, ...extra };
}

describe('d1Target：连哪个库', () => {
  it('本机设了 D1_DB_URL 指 55322：放行，不读仓库', () => {
    expect(d1Target({ D1_DB_URL: E2E }, never)).toEqual({ url: E2E });
    expect(d1Target({ D1_DB_URL: E2E.replace('127.0.0.1', 'localhost') }, never).url).toBeTruthy();
  });
  it('本机设了别的端口（54322 是 lemomemo）、不是本机、写坏：拒绝，理由里没有口令', () => {
    for (const v of ['postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'postgresql://postgres:postgres@127.0.0.1/postgres',
      'postgresql://postgres:postgres@127.0.0.1:55332/postgres', 'postgresql://postgres:postgres@db.example.com:55322/postgres', 'not a url']) {
      const p = problem(d1Target({ D1_DB_URL: v }, never));
      expect(p, v).not.toBe('');
      expect(p.includes('postgres:postgres')).toBe(false);
    }
  });
  it('本机没设（或设成空串）：拒绝，提示 55322；CI 不是 true 的都算本机', () => {
    for (const env of [{}, { D1_DB_URL: '' }, { CI: '1' }, { CI: 'TRUE' }, { CI: 'false' }]) {
      expect(problem(d1Target(env, never))).toMatch(/55322/);
    }
  });
  it('CI 没设：config 顶层是 lemo-ci、没有 .env* 才用默认 54322', () => {
    expect(d1Target({ CI: 'true' }, CI_REPO)).toEqual({ url: CI_DEFAULT_URL });
    expect(CI_DEFAULT_URL).toMatch(/127\.0\.0\.1:54322\//);
  });
  it('CI 没设，但 config 是 lemomemo（本机 act）、有 .env、读不到仓库：拒绝', () => {
    const lemomemo = () => ({ ...CI_REPO(), configText: 'project_id = "lemomemo"\n[api]\n' });
    const withEnv = () => ({ ...CI_REPO(), dirListing: { './': ['.env.local'], 'supabase/': [] } });
    const broken = () => { throw new Error('ENOENT'); };
    for (const r of [lemomemo, withEnv, broken]) expect(problem(d1Target({ CI: 'true' }, r))).toMatch(/拒绝/);
  });
  it('复审 L1：设了 D1_DB_URL 就只许 55322，CI=true 也不例外（指 54322 拒绝，不看仓库）', () => {
    expect(problem(d1Target({ CI: 'true', D1_DB_URL: CI_DEFAULT_URL }, CI_REPO))).toMatch(/55322/);
    expect(d1Target({ CI: 'true', D1_DB_URL: E2E }, never)).toEqual({ url: E2E });
  });
  it('复审 L2：带查询参数或 # 的一律拒绝（postgres.js 认 ?host=、?port=），CI 里也一样', () => {
    for (const v of [`${E2E}?host=127.0.0.1&port=54322`, `${E2E}?sslmode=disable`, `${E2E}?`, `${E2E}#x`]) {
      for (const env of [{ D1_DB_URL: v }, { CI: 'true', D1_DB_URL: v }]) {
        const p = problem(d1Target(env, never));
        expect(p, v).toMatch(/查询参数/);
        expect(p.includes('postgres:postgres')).toBe(false);
      }
    }
  });
  it('ci.yml 的 d1_negative 那一步不设 D1_DB_URL（走 CI 默认）', () => {
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci.includes('run: node build/ci/d1_negative.mjs')).toBe(true);
    expect(/D1_DB_URL=/.test(ci.replace(/^\s*#.*$/gmu, ''))).toBe(false);
  });
  it('仓库现在的 config（lemomemo）：设了 CI 也拒绝', async () => {
    const { repoReader } = await import('../../build/d1/db-target.mjs');
    expect(problem(d1Target({ CI: 'true' }, repoReader(root)))).toMatch(/project_id/);
  });
});

describe('入口：连库之前先判，本机退出码 2', () => {
  const node = (file: string, env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(root, file)], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  it('d1_negative.mjs：本机没设、指 54322、设了 CI（config 是 lemomemo）都退出码 2', () => {
    for (const env of [localEnv(), localEnv({ D1_DB_URL: CI_DEFAULT_URL }), localEnv({ CI: 'true' })]) {
      const r = node('build/ci/d1_negative.mjs', env);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/d1_negative：/);
    }
  });
  it('login-probe.mjs：本机退出码 2，不调 supabase status', () => {
    for (const env of [localEnv(), localEnv({ CI: 'true' })]) {
      const r = node('supabase/tests/auth/login-probe.mjs', env);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/login-probe：/);
      expect(r.stderr).not.toMatch(/supabase status/);
    }
  });
  it('check_data_manifest.ts、d1_negative.mjs：先 d1Target 再 postgres(，源码里没有默认连接串', () => {
    for (const f of ['build/check_data_manifest.ts', 'build/ci/d1_negative.mjs']) {
      const src = readFileSync(join(root, f), 'utf8');
      const code = src.replace(/^\s*\/\/.*$/gmu, '');
      expect(code.includes('54322'), f).toBe(false);
      expect(code.includes('D1_DB_URL ??'), f).toBe(false);
      const t = code.indexOf('d1Target(');
      const p = code.indexOf('postgres(url');
      expect(t > 0 && p > t, f).toBe(true);
    }
  });
  it('login-probe.mjs：护栏在 readStatus() 之前', () => {
    const code = readFileSync(join(root, 'supabase/tests/auth/login-probe.mjs'), 'utf8');
    const g = code.indexOf('const guardProblem = checkRepoSupabase(');
    expect(g > 0 && g < code.indexOf('readStatus()')).toBe(true);
  });
  it('deno.json 的 d1 任务：给了 CI 变量，网络只许 54322（CI）和 55322（lemo-e2e）', () => {
    const deno = JSON.parse(readFileSync(join(root, 'deno.json'), 'utf8')) as { tasks: Record<string, string> };
    const t = deno.tasks.d1 ?? '';
    expect(/--allow-env=(?:[^ ]*,)?CI(?:,|\s)/.test(t)).toBe(true);
    expect(/--allow-net=127\.0\.0\.1:54322,127\.0\.0\.1:55322\s/.test(t)).toBe(true);
  });
});

describe('别的脚本没有写死 54322 的连接串', () => {
  it('build/、tools/、supabase/tests/ 的 .ts .mjs .js .py（测试文件除外）：只有 db-target.mjs 有', () => {
    const hits: string[] = [];
    for (const top of ['build', 'tools', join('supabase', 'tests')]) {
      for (const d of readdirSync(join(root, top), { recursive: true, withFileTypes: true })) {
        if (!d.isFile() || !/\.(ts|mjs|js|cjs|py)$/.test(d.name) || /\.test\.ts$/.test(d.name)) continue;
        const p = join(d.parentPath, d.name);
        const rel = relative(root, p).split(sep).join('/');
        const code = readFileSync(p, 'utf8').replace(/^\s*(\/\/|#).*$/gmu, '');
        if (/(127\.0\.0\.1|localhost):54322\b/.test(code) && rel !== 'build/d1/db-target.mjs') hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });
});
