// store-it 和 npm run test:db 不许在本机打仓库根目录的 Supabase（project_id 是 lemomemo；11-05 主持人定，安全红线）：
// 放行规则在 supabase/tests/store-it/guard.mjs（CI=true、没有 SUPABASE_* 变量和 .env*、config 顶层恰好一行 project_id = "lemo-ci"），
// test:db 的第一步是 guard-cli.mjs（被调就查，不做入口判断；审查 M1），本机要加 --e2e-sb 改打 lemo-e2e。
// 另钉 tools/e2e/real-backend.mjs 的 pickDbUrl（--e2e-sb 的 DB_URL 取 status 实际给的，必须本机、55322，审查 M1 上一轮）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectIdProblem, repoSupabaseProblem } from '../../supabase/tests/store-it/guard.mjs';
import { pickDbUrl } from '../../tools/e2e/real-backend.mjs';

const root = join(import.meta.dirname, '..', '..');
const HEAD = '# 注释\n#\n\n';
const CI_CFG = `${HEAD}project_id = "lemo-ci"\n\n[api]\nport = 54321\n`;
const OK_DIRS = { './': ['package.json', 'supabase'], 'supabase/': ['config.toml', 'migrations'] };
const CI = { CI: 'true' };

/** 本机环境：去掉 CI 和所有 SUPABASE_* */
function localEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CI' || /^supabase_/i.test(k)) delete env[k];
  return { ...env, ...extra };
}

describe('guard.mjs：CI 环境变量', () => {
  it('CI=true、没有 SUPABASE_*、没有 .env、config 合格：放行', () => {
    expect(repoSupabaseProblem(CI, CI_CFG, OK_DIRS)).toBe(null);
  });
  it('本机（CI 没设、或不是 true）：拒绝，提示加 --e2e-sb', () => {
    for (const env of [{}, { CI: '1' }, { CI: 'false' }, { CI: 'TRUE' }, { GITHUB_ACTIONS: 'true' }]) {
      expect(repoSupabaseProblem(env, CI_CFG, OK_DIRS)).toMatch(/--e2e-sb/);
    }
  });
});

describe('guard.mjs：SUPABASE_* 变量和 .env 文件（审查 M2）', () => {
  it('有任何 SUPABASE_* 变量（不分大小写）：拒绝', () => {
    for (const k of ['SUPABASE_PROJECT_ID', 'SUPABASE_API_PORT', 'SUPABASE_WORKDIR', 'supabase_env', 'Supabase_DB_URL']) {
      expect(repoSupabaseProblem({ ...CI, [k]: 'lemomemo' }, CI_CFG, OK_DIRS)).toMatch(/环境变量里有/);
    }
  });
  it('仓库根目录或 supabase/ 下有 .env*：拒绝；别处（supabase/functions/.env.example）不算', () => {
    for (const d of [{ ...OK_DIRS, './': ['.env'] }, { ...OK_DIRS, './': ['.ENV.local'] }, { ...OK_DIRS, 'supabase/': ['.env.ci'] }]) {
      expect(repoSupabaseProblem(CI, CI_CFG, d)).toMatch(/\.env/i);
    }
    expect(repoSupabaseProblem(CI, CI_CFG, { ...OK_DIRS, 'supabase/': ['functions', 'env.md'] })).toBe(null);
  });
});

describe('guard.mjs：project_id 只认顶层恰好一行（审查 M3）', () => {
  const bad: [string, string][] = [
    ['顶层 lemomemo、小节里 lemo-ci', `project_id = "lemomemo"\n[remotes.ci]\nproject_id = "lemo-ci"\n`],
    ['顶层带行尾注释', `project_id = "lemo-ci" # main\n[api]\n`],
    ['顶层 lemomemo 带注释、remotes 里 lemo-ci', `project_id = "lemomemo" # main\n[remotes.ci]\nproject_id = "lemo-ci"\n`],
    ['顶层缩进', `  project_id = "lemo-ci"\n[api]\n`],
    ['顶层缩进的 lemomemo 加小节里 lemo-ci', `  project_id = "lemomemo"\n[api]\nproject_id = "lemo-ci"\n`],
    ['单引号', `project_id = 'lemo-ci'\n[api]\n`],
    ['引号键', `"project_id" = "lemo-ci"\n[api]\n`],
    ['引号键 lemomemo 加一行合格的', `project_id = "lemo-ci"\n"project_id" = "lemomemo"\n[api]\n`],
    ['只在 [api] 下有 lemo-ci', `[api]\nproject_id = "lemo-ci"\n`],
    ['两行合格的', `project_id = "lemo-ci"\nproject_id = "lemo-ci"\n[api]\n`],
    ['没有', `[api]\nport = 1\n`],
    ['空文件', ''],
    ['lemomemo', `project_id = "lemomemo"\n`],
    ['lemo-purgeit', `project_id = "lemo-purgeit"\n`],
    ['小节里有含 project 的键', `project_id = "lemo-ci"\n[api]\nproject = "x"\n`],
    ['\\u 转义的引号键', `project_id = "lemo-ci"\n[api]\n"\\u0070roject_id" = "lemomemo"\n`],
    ['[remotes] 小节', `project_id = "lemo-ci"\n[remotes.prod]\nport = 1\n`],
    ['顶层还有别的键', `project_id = "lemo-ci"\nfoo = 1\n[api]\n`],
    ['注释里写着合格的，真正那行是 lemomemo', `# project_id = "lemo-ci"\nproject_id = "lemomemo"\n`],
  ];
  for (const [name, cfg] of bad) {
    it(`拒绝：${name}`, () => {
      expect(projectIdProblem(cfg) === null).toBe(false);
      expect(repoSupabaseProblem(CI, cfg, OK_DIRS)).toMatch(/project_id|project|remotes|\\u/);
    });
  }
  it('放行：注释、空行之后恰好一行；CRLF 也认；没有小节也认', () => {
    expect(projectIdProblem(CI_CFG)).toBe(null);
    expect(projectIdProblem(CI_CFG.replace(/\n/g, '\r\n'))).toBe(null);
    expect(projectIdProblem('project_id = "lemo-ci"\n')).toBe(null);
  });
  it('仓库现在的 config 是 lemomemo：设了 CI 也拒绝；ci.yml 的 sed 改出来的那份放行', () => {
    const cfg = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
    expect(/^project_id = "lemomemo"$/m.test(cfg)).toBe(true);
    expect(repoSupabaseProblem(CI, cfg, OK_DIRS)).toMatch(/project_id/);
    expect(projectIdProblem(cfg.replace(/^project_id = "lemomemo"$/m, 'project_id = "lemo-ci"'))).toBe(null);
  });
});

describe('命令行：本机一律退出码 2，不起 supabase', () => {
  const cli = (args: string[], cwd: string, env = localEnv()) => spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  it('run.mjs 不带 --e2e-sb：退出码 2', () => {
    const r = cli([join(root, 'supabase', 'tests', 'store-it', 'run.mjs')], root);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--e2e-sb/);
  });
  it('guard-cli.mjs（test:db 的第一步）：本机退出码 2；设了 CI 也是 2（仓库 config 是 lemomemo）', () => {
    expect(cli([join(root, 'supabase', 'tests', 'store-it', 'guard-cli.mjs')], root).status).toBe(2);
    expect(cli([join(root, 'supabase', 'tests', 'store-it', 'guard-cli.mjs')], root, localEnv({ CI: 'true' })).status).toBe(2);
  });
  it('审查 M1：经目录联接调用（绝对路径走联接、cwd 在联接里用相对路径，即 npm run test:db 的写法）：照样退出码 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lemo-guard-link-'));
    const link = join(dir, 'repo');
    symlinkSync(root, link, 'junction');
    try {
      expect(cli([join(link, 'supabase', 'tests', 'store-it', 'guard-cli.mjs')], dir).status).toBe(2);
      expect(cli(['supabase/tests/store-it/guard-cli.mjs'], link).status).toBe(2);
      expect(cli(['supabase/tests/store-it/guard-cli.mjs'], link, localEnv({ CI: 'true' })).status).toBe(2);
      expect(cli([join(link, 'supabase', 'tests', 'store-it', 'run.mjs')], dir).status).toBe(2);
    } finally {
      unlinkSync(link);   // 只删联接本身，不碰仓库
      rmdirSync(dir);
    }
  });
  it('guard-cli.mjs 没有“是不是被直接运行”的判断（被调就查）', () => {
    const src = readFileSync(join(root, 'supabase', 'tests', 'store-it', 'guard-cli.mjs'), 'utf8').replace(/^\s*\/\/.*$/gmu, '');
    expect(/process\.argv|import\.meta\.url|fileURLToPath/.test(src)).toBe(false);
  });
  it('package.json 的 test:db 第一步是 guard-cli.mjs；ci.yml 先把 project_id 改成 lemo-ci、再跑 test:db', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:db']?.startsWith('node supabase/tests/store-it/guard-cli.mjs && ')).toBe(true);
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const rename = ci.indexOf(`sed -i 's/^project_id = "lemomemo"$/project_id = "lemo-ci"/' supabase/config.toml`);
    const run = ci.indexOf('run: npm run test:db');
    expect(rename > 0 && run > rename).toBe(true);
  });
});

describe('pickDbUrl：status 实际给的 DB_URL，本机、55322', () => {
  it('放行 lemo-e2e 的地址', () => {
    const v = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';
    expect(pickDbUrl({ DB_URL: v })).toBe(v);
  });
  it('端口不是 55322、不是本机、缺、坏：抛错，消息里没有口令', () => {
    for (const v of ['postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'postgresql://postgres:postgres@127.0.0.1:55332/postgres',
      'postgresql://postgres:postgres@db.example.com:55322/postgres', '', 'not a url', undefined]) {
      let msg = '';
      try {
        pickDbUrl({ DB_URL: v });
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg === '').toBe(false);
      expect(msg.includes('postgres:postgres')).toBe(false);
    }
  });
});
