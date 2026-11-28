// 正式发布在 GitHub 上自动跑（R-499）：.github/workflows/release-publish.yml 和它调的三个脚本。
// ① 工作流静态守护：verify 任务不碰任何密钥；deploy 任务用 Environment；每把令牌只在用它的那一步、按环境取对名字；lemo-ops 六个密钥名单和 publish.ps1 一致；
// ② build/ci/release_preflight.py 在临时 git 仓库里真跑（正例 + tag、main、VERSION、git 状态、lemo-ops 配置的反例）；
// ③ build/ci/release_bundle_check.py 用现做的发布包真跑（正例 + 篡改、多文件、版本、source map、和源码不一致、裸引、预览函数、缺函数）；
// ④ build/ci/release-backup.sh 对着本机假 SQL 接口真跑（要 bash 和 jq；本机 Windows 没有 jq 时跳过，CI 的 unit 上会跑）。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const CI = join(ROOT, 'build', 'ci');
const WF = readFileSync(join(ROOT, '.github', 'workflows', 'release-publish.yml'), 'utf8');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';
const JQ = spawnSync(BASH ?? 'bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
// Windows 上的 python3 常是应用商店的空壳，真跑一下才算有
const PY3 = spawnSync(BASH ?? 'bash', ['-c', 'python3 -c 1'], { encoding: 'utf8' }).status === 0;

/** 去掉注释（整行和行尾的 #…），保留行号 */
const code = (text: string) => text.split('\n').map((raw, i) => ({ no: i + 1, line: raw.replace(/^\s*#.*$/, '').replace(/\s+#\s.*$/, '') }));
const jobText = (name: string) => {
  const lines = WF.split('\n');
  const at = lines.findIndex((l) => l === `  ${name}:`);
  const end = lines.findIndex((l, i) => i > at && /^ {2}[a-z]/.test(l));
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
};
/** 某个任务里的各个步骤（按“      - ”切开） */
const stepsOf = (name: string) => jobText(name).split(/\n(?= {6}- )/).slice(1);
const stepWith = (name: string, needle: string) => {
  const hit = stepsOf(name).filter((s) => s.includes(needle));
  expect(hit.length, needle).toBe(1);
  return hit[0] ?? '';
};

describe('release-publish.yml 静态守护', () => {
  it('触发：正式 tag、预览演练 tag、手动（only 只有 all / functions）', () => {
    expect(WF).toContain("- 'v[0-9]+.[0-9]+.[0-9]+'\n");
    expect(WF).toContain("- 'v[0-9]+.[0-9]+.[0-9]+-preview.[0-9]+'\n");
    expect(WF).toMatch(/options: \[all, functions\]/);
  });

  it('verify 任务不碰任何密钥、不用 Environment；deploy 任务用按 tag 定的 Environment', () => {
    const verify = jobText('verify');
    expect(verify).not.toMatch(/secrets\./);
    expect(verify).not.toMatch(/^\s+environment:/m);
    const deploy = jobText('deploy');
    expect(deploy).toMatch(/environment:\n\s+name: \$\{\{ needs\.verify\.outputs\.env \}\}/);
    expect(deploy).toMatch(/needs: verify/);
  });

  it('每把令牌按环境取对名字：正式只取 PROD_、预览只取 PREVIEW_，取不到就是空（不会串到另一个环境的令牌）', () => {
    const uses = [...WF.matchAll(/\$\{\{([^}]*secrets\.[^}]*)\}\}/g)].map((m) => m[1]?.trim() ?? '');
    expect(uses.length).toBeGreaterThanOrEqual(8);
    for (const u of uses) {
      const parts = u.split('||').map((s) => s.trim());
      expect(parts.at(-1), u).toBe("''");
      for (const p of parts.slice(0, -1)) {
        expect(p, u).toMatch(/^needs\.verify\.outputs\.env == '(production|preview)' && secrets\.(PROD|PREVIEW)_[A-Z_]+$/);
        const env = /'(production|preview)'/.exec(p)?.[1];
        expect(p, u).toContain(env === 'production' ? 'secrets.PROD_' : 'secrets.PREVIEW_');
      }
    }
  });

  it('令牌只在部署步骤的 step 级 env 里（不在任务级 env、不进 run: 文本）', () => {
    const lines = code(WF);
    for (const { no, line } of lines) {
      if (!/secrets\./.test(line)) continue;
      expect(line, `第 ${no} 行`).toMatch(/^ {10}(SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|CLOUDFLARE_API_TOKEN): \$\{\{/);
    }
  });

  it('lemo-ops 的六个密钥名单和 publish.ps1 的 OpsSecretNames 一字不差', () => {
    const ps = readFileSync(join(ROOT, 'tools', 'release', 'publish.ps1'), 'utf8');
    const want = /\$script:OpsSecretNames = @\(([^)]*)\)/.exec(ps)?.[1]?.match(/'([A-Z_]+)'/g)?.map((s) => s.slice(1, -1));
    const got = /for n in (SUPABASE_URL[A-Z_ ]+); do/.exec(WF)?.[1]?.trim().split(/\s+/);
    expect(want?.length).toBe(6);
    expect(got).toEqual(want);
  });

  it('发布包从构建那次运行下载（run-id），部署前和 verify 的总指纹比对', () => {
    expect([...WF.matchAll(/run-id: \$\{\{ (steps\.find|needs\.verify)\.outputs\.run_id \}\}/g)].length).toBe(2);
    expect(WF).toContain('pub-same.sh');
    expect(jobText('deploy').match(/bash "\$RUNNER_TEMP\/pub-same\.sh"/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('改库前备份在 db push 之前，只在完整发布时跑', () => {
    const d = jobText('deploy');
    const backup = d.indexOf('bash build/ci/release-backup.sh');
    const push = d.indexOf('supabase db push --linked --yes');
    expect(backup).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(backup);
  });

  it('only = functions 时只跑服务器函数（和 lemo-ops）：备份、迁移、网页、线上核对都带 only == all 的条件', () => {
    const ALL = "if: needs.verify.outputs.only == 'all'";
    for (const n of ['bash build/ci/release-backup.sh', 'supabase db push --linked --yes', 'pages deploy', 'check_live_headers.py']) {
      expect(stepWith('deploy', n), n).toContain(ALL);
    }
    expect(stepWith('deploy', 'supabase functions deploy')).not.toMatch(/^\s+if:/m);
  });

  it('lemo-ops 打包演练（--dry-run）在第一个带令牌的步骤之前、自己不带令牌；带令牌前再查一次运行环境', () => {
    const steps = stepsOf('deploy');
    const firstSecret = steps.findIndex((s) => /secrets\./.test(s));
    const dry = steps.findIndex((s) => s.includes('deploy --dry-run --outdir'));
    const recheck = steps.findIndex((s) => s.includes('bash "$RUNNER_TEMP/env-clean.sh"') && !s.includes('cat >'));
    expect(dry).toBeGreaterThan(0);
    expect(firstSecret).toBeGreaterThan(dry);
    expect(steps[dry]).toContain("if: needs.verify.outputs.ops == 'true'");
    expect(recheck).toBe(firstSecret - 1);
    // 第一步写下检查脚本并立刻跑；名单里有 BASH_ENV、LD_PRELOAD 这类能往后面步骤塞代码的变量
    expect(steps[0]).toContain('cat > "$RUNNER_TEMP/env-clean.sh"');
    for (const v of ['BASH_ENV', 'LD_PRELOAD', 'NODE_OPTIONS', 'GIT_TEMPLATE_DIR', 'GIT_COMMON_DIR']) expect(steps[0], v).toMatch(new RegExp(`\\b${v}\\b`));
  });

  it('正式只等 release-build 的 build 任务（不等 exe），任务名和 release-build.yml 里的一字不差', () => {
    const rb = readFileSync(join(ROOT, '.github', 'workflows', 'release-build.yml'), 'utf8');
    const name = /\n {2}build:\n {4}name: (.+)\n/.exec(rb)?.[1];
    expect(name).toBeTruthy();
    expect(stepWith('verify', '/jobs?filter=latest')).toContain(`job='${name}'`);
  });

  it('检查脚本失败时把它的输出打出来（命令替换不吞 ::error::）', () => {
    expect(WF).toMatch(/out="\$\(python3 -I build\/ci\/release_bundle_check\.py [^\n]*\)" \|\|\n\s+\{ printf '%s\\n' "\$out"; exit 1; \}/);
    expect(WF).toMatch(/plan="\$\(supabase db push --linked --dry-run [^\n]*\)" \|\| \{ printf '%s\\n' "\$plan";/);
  });
});

// ---------------------------------------------------------------- pub-same.sh（工作流里 heredoc 写出的那段）
describe.skipIf(!BASH || !PY3)('pub-same.sh：发布包没变才放行（supabase CLI 写的 .temp、.branches 不算）', () => {
  const script = () => {
    const m = /cat > "\$RUNNER_TEMP\/pub-same\.sh" <<'EOF'\n([\s\S]*?)\n\s*EOF\n/.exec(WF);
    expect(m).toBeTruthy();
    return (m?.[1] ?? '').split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n') + '\n';
  };
  const run = (tmp: string, total: string) =>
    spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', join(tmp, 'pub-same.sh'), '测试'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: tmp, GITHUB_WORKSPACE: ROOT, PUB_TOTAL: total },
    });
  const total = (pub: string) =>
    /总指纹：([0-9a-f]{64})/.exec(spawnSync(PY, ['-I', join(CI, 'dist_hash.py'), pub], { encoding: 'utf8' }).stdout)?.[1] ?? '';

  it('写了 supabase/.temp、.branches 仍放行；包里文件改了就停', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pub-same-'));
    try {
      writeFileSync(join(tmp, 'pub-same.sh'), script());
      const pub = join(tmp, 'pub');
      mkdirSync(join(pub, 'supabase', 'functions'), { recursive: true });
      writeFileSync(join(pub, 'supabase', 'functions', 'a.ts'), 'x\n');
      const t = total(pub);
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      mkdirSync(join(pub, 'supabase', '.temp'), { recursive: true });
      writeFileSync(join(pub, 'supabase', '.temp', 'cli-latest'), 'v9\n');
      mkdirSync(join(pub, 'supabase', '.branches'), { recursive: true });
      writeFileSync(join(pub, 'supabase', '.branches', '_current_branch'), 'main\n');
      const ok = run(tmp, t);
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      writeFileSync(join(pub, 'supabase', 'functions', 'a.ts'), 'y\n');
      const bad = run(tmp, t);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/不一样了（测试）/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 临时仓库
const gitEnv = (d: string) => ({
  GIT_CONFIG_GLOBAL: join(d, 'empty.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
});

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const KV = '0123456789abcdef0123456789abcdef';
/** 建一个像本仓库的最小仓库：VERSION、假 check_backend（只会打印预览函数名单）、服务器函数、lemo-ops 配置；main 上打带说明的 tag */
function makeRepo(opts: { version?: string; kv?: string; tag?: string } = {}) {
  const box = mkdtempSync(join(tmpdir(), 'lemo-release-'));
  const d = join(box, 'repo');
  mkdirSync(d);
  writeFileSync(join(box, 'empty.gitconfig'), '');
  const env = { ...process.env, ...gitEnv(box) };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: d, encoding: 'utf8', env });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  write(d, 'VERSION', `${opts.version ?? '4.0.2'}\n`);
  write(d, 'build/check_backend.py', "import sys\nif '--print-preview-funcs' in sys.argv:\n    print('voice-probe')\n");
  write(d, 'supabase/config.toml', 'project_id = "x"\n');
  write(d, 'supabase/migrations/20261128000000_a.sql', 'select 1;\n');
  write(d, 'supabase/templates/mail.html', '<p>hi</p>\n');
  write(d, 'supabase/functions/deno.json', JSON.stringify({ imports: { zod: 'npm:zod@4.1.0' } }) + '\n');
  write(d, 'supabase/functions/alpha/index.ts', "import '../_shared/gen/a.ts';\n");
  write(d, 'supabase/functions/usage-report/index.ts', 'export {};\n');
  write(d, 'supabase/functions/_shared/a.ts', "import { z } from 'zod';\nexport const s = z.string();\n");
  write(d, 'supabase/functions/_preview/voice-probe/index.ts', 'export {};\n');
  write(d, 'workers/lemo-ops/wrangler.toml', `name = "lemo-ops"\n[[kv_namespaces]]\nbinding = "OPS_STATE"\nid = "${opts.kv ?? KV}"\n`);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'a');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('tag', '-a', opts.tag ?? `v${opts.version ?? '4.0.2'}`, '-m', 'release');
  return { box, d, git, env, sha: git('rev-parse', 'HEAD') };
}

function preflight(r: ReturnType<typeof makeRepo>, ref: string, extra: Record<string, string> = {}) {
  const out = join(r.box, 'out.txt');
  writeFileSync(out, '');
  const p = spawnSync(PY, ['-I', join(CI, 'release_preflight.py')], {
    cwd: r.d,
    encoding: 'utf8',
    env: { ...r.env, GITHUB_REF: ref, GITHUB_SHA: r.sha, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: out, ...extra },
  });
  const kv = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { code: p.status, text: p.stdout + p.stderr, kv };
}

describe('build/ci/release_preflight.py（临时仓库里真跑）', () => {
  it('正式 tag：通过，写出环境、版本、函数名单（不含预览函数）、lemo-ops 要一起部署', () => {
    const r = makeRepo();
    try {
      const p = preflight(r, 'refs/tags/v4.0.2');
      expect(p.code, p.text).toBe(0);
      expect(p.kv).toMatchObject({
        env: 'production', tag: 'v4.0.2', expect: '4.0.2', only: 'all', ops: 'true', functions: 'alpha,usage-report', preview_funcs: 'voice-probe',
        pages_project: 'lemomemo', site_origin: 'https://lemomemo.com', artifact_name: 'release-publish-v4.0.2',
        build_workflow: '.github/workflows/release-build.yml',
      });
    } finally {
      rmSync(r.box, { recursive: true, force: true });
    }
  });

  it('预览演练 tag：预览环境，期望版本带运行号，函数名单加上预览函数，不部署 lemo-ops', () => {
    const r = makeRepo({ tag: 'v4.0.2-preview.15' });
    try {
      const p = preflight(r, 'refs/tags/v4.0.2-preview.15', { ONLY: 'functions' });
      expect(p.code, p.text).toBe(0);
      expect(p.kv).toMatchObject({ env: 'preview', expect: '4.0.2-preview.15', run_no: '15', only: 'functions', ops: 'false', functions: 'alpha,usage-report,voice-probe', artifact_name: 'preview-bundle' });
    } finally {
      rmSync(r.box, { recursive: true, force: true });
    }
  });

  const bad: [string, (r: ReturnType<typeof makeRepo>) => string, RegExp][] = [
    ['不是 tag', () => 'refs/heads/main', /只能在 tag 上发布/],
    ['大写 V', () => 'refs/tags/V4.0.2', /格式不对/],
    ['不带说明的 tag', (r) => (r.git('tag', '-d', 'v4.0.2'), r.git('tag', 'v4.0.2'), 'refs/tags/v4.0.2'), /带说明/],
    ['不在 main 上', (r) => (r.git('update-ref', 'refs/remotes/origin/main', r.git('commit-tree', '-m', 'other', `${r.sha}^{tree}`)), 'refs/tags/v4.0.2'), /不在 main 上/],
    ['已有更高版本（push 触发）', (r) => (r.git('tag', '-a', 'v4.0.10', '-m', 'x'), 'refs/tags/v4.0.2'), /更高版本/],
    ['工作区不干净', (r) => (writeFileSync(join(r.d, 'x.txt'), 'x'), 'refs/tags/v4.0.2'), /不干净/],
    ['assume-unchanged', (r) => (r.git('update-index', '--assume-unchanged', 'VERSION'), 'refs/tags/v4.0.2'), /assume-unchanged/],
    ['.git/config 里有过滤程序', (r) => (r.git('config', 'filter.x.clean', 'cat'), 'refs/tags/v4.0.2'), /local:filter\.x\.clean/],
    ['有替换对象', (r) => (r.git('update-ref', 'refs/replace/abc', r.sha), 'refs/tags/v4.0.2'), /替换对象/],
  ];
  for (const [what, setup, re] of bad) {
    it(`反例：${what} → 停`, () => {
      const r = makeRepo();
      try {
        const ref = setup(r);
        const p = preflight(r, ref);
        expect(p.code, p.text).toBe(1);
        expect(p.text).toMatch(re);
        expect(p.kv.env).toBeUndefined();
      } finally {
        rmSync(r.box, { recursive: true, force: true });
      }
    });
  }

  it('反例：VERSION 和 tag 对不上 → 停', () => {
    const r = makeRepo({ version: '4.0.3', tag: 'v4.0.2' });
    try {
      const p = preflight(r, 'refs/tags/v4.0.2');
      expect(p.code).toBe(1);
      expect(p.text).toMatch(/VERSION 是 4\.0\.3/);
    } finally {
      rmSync(r.box, { recursive: true, force: true });
    }
  });

  it('反例：lemo-ops 的 KV id 还是占位值 → 停', () => {
    const r = makeRepo({ kv: 'REPLACE_ME' });
    try {
      const p = preflight(r, 'refs/tags/v4.0.2');
      expect(p.code).toBe(1);
      expect(p.text).toMatch(/占位值/);
    } finally {
      rmSync(r.box, { recursive: true, force: true });
    }
  });

  it('已有更高版本时手动触发：放行，摘要里写警告', () => {
    const r = makeRepo();
    try {
      r.git('tag', '-a', 'v4.0.10', '-m', 'x');
      const p = preflight(r, 'refs/tags/v4.0.2', { GITHUB_EVENT_NAME: 'workflow_dispatch' });
      expect(p.code, p.text).toBe(0);
      expect(p.text).toMatch(/::warning::已有更高版本的 tag：v4\.0\.10/);
    } finally {
      rmSync(r.box, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 发布包
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** 照 release-build.yml 的发布包做一份：dist/web（version.json、_worker.js）＋ supabase（配置、迁移、函数、模板，_shared/gen 换成生成的） */
function makePub(r: ReturnType<typeof makeRepo>, opts: { version?: string; preview?: boolean } = {}) {
  const pub = join(r.box, 'pub');
  write(pub, 'dist/web/app/version.json', JSON.stringify({ version: opts.version ?? '4.0.2' }));
  write(pub, 'dist/web/index.html', '<!doctype html>');
  write(pub, 'dist/web/_worker.js/index.js', 'export default {};\n');
  for (const sub of ['config.toml', 'migrations', 'functions', 'templates']) cpSync(join(r.d, 'supabase', sub), join(pub, 'supabase', sub), { recursive: true });
  write(pub, 'supabase/functions/_shared/gen/a.ts', "// 生成文件：由 build/copy_shared.mjs 从 shared/a.ts 复制\nimport { z } from 'npm:zod@4.1.0';\nexport const s = z.string();\n");
  if (opts.preview) {
    write(pub, 'supabase/functions/voice-probe/index.ts', "// 由 deploy-preview.yml 在预览产物里生成，不进仓库。源码在 ../_preview/voice-probe/\nimport '../_preview/voice-probe/index.ts';\n");
    writeFileSync(join(pub, 'supabase/config.toml'), readFileSync(join(r.d, 'supabase/config.toml'), 'utf8') + '\n[functions.voice-probe]\nverify_jwt = false\n');
  }
  return pub;
}
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
function sums(pub: string) {
  const rows = walk(pub).map((f) => relative(pub, f).split('\\').join('/')).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return rows.map((rel) => `${sha(readFileSync(join(pub, rel)))}  ${rel}\n`).join('');
}
function bundleCheck(r: ReturnType<typeof makeRepo>, pub: string, text: string, args: string[] = []) {
  const file = join(r.box, 'SHA256SUMS');
  writeFileSync(file, text);
  const p = spawnSync(PY, ['-I', join(CI, 'release_bundle_check.py'), pub, file, '--env', 'production', '--expect', '4.0.2', '--functions', 'alpha,usage-report', '--preview-funcs', 'voice-probe', ...args], { cwd: r.d, encoding: 'utf8', env: r.env });
  return { code: p.status, text: p.stdout + p.stderr };
}

describe('build/ci/release_bundle_check.py（现做的发布包真跑）', () => {
  it('正例：逐个对上，总指纹 = SHA256SUMS 整段文本的 SHA-256（和 dist_hash.py 同一个算法）', () => {
    const r = makeRepo();
    try {
      const pub = makePub(r);
      const text = sums(pub);
      const p = bundleCheck(r, pub, text);
      expect(p.code, p.text).toBe(0);
      expect(p.text).toContain(`总指纹：${sha(text)}`);
      const py = spawnSync(PY, ['-I', join(CI, 'dist_hash.py'), pub], { encoding: 'utf8' });
      expect(py.stdout).toContain(`总指纹：${sha(text)}`);
    } finally {
      rmSync(r.box, { recursive: true, force: true });
    }
  });

  it('预览包：预览函数的两行入口和 config.toml 末尾追加的配置放行', () => {
    const r = makeRepo({ tag: 'v4.0.2-preview.15' });
    try {
      const pub = makePub(r, { version: '4.0.2-preview.15', preview: true });
      const p = bundleCheck(r, pub, sums(pub), ['--env', 'preview', '--expect', '4.0.2-preview.15', '--functions', 'alpha,usage-report,voice-probe']);
      expect(p.code, p.text).toBe(0);
    } finally {
      rmSync(r.box, { recursive: true, force: true });
    }
  });

  const bad: [string, (pub: string, r: ReturnType<typeof makeRepo>) => string | void, RegExp, string[]?][] = [
    ['包里的文件被改过（清单是改之前的）', (pub) => { const t = sums(pub); writeFileSync(join(pub, 'dist/web/index.html'), 'evil'); return t; }, /内容不同 dist\/web\/index\.html/],
    ['多了一个清单里没有的文件', (pub) => { const t = sums(pub); write(pub, 'dist/web/extra.js', 'x'); return t; }, /多了 dist\/web\/extra\.js/],
    ['清单里有不允许的路径', (pub) => `${sums(pub)}${'0'.repeat(64)}  functions/x.js\n`, /不允许的路径/],
    ['version.json 不是这次的版本', (pub) => void write(pub, 'dist/web/app/version.json', '{"version":"4.0.1"}'), /不是 4\.0\.2/],
    ['有 source map', (pub) => void write(pub, 'dist/web/a.js', '//# sourceMappingURL=a.js.map'), /source map/],
    ['迁移和源码不一样', (pub) => void write(pub, 'supabase/migrations/20261128000000_a.sql', 'drop table x;\n'), /和源码不一样/],
    ['源码里有的函数发布包里缺', (pub) => void rmSync(join(pub, 'supabase/functions/usage-report'), { recursive: true }), /发布包里缺/],
    ['_shared/gen 裸引 zod', (pub) => void write(pub, 'supabase/functions/_shared/gen/a.ts', "// 生成文件：由 build/copy_shared.mjs\nimport { z } from 'zod';\n"), /裸引 zod/],
    ['_shared/gen 引的版本不是 deno.json 锁的', (pub) => void write(pub, 'supabase/functions/_shared/gen/a.ts', "// 生成文件：由 build/copy_shared.mjs\nimport { z } from 'npm:zod@9.9.9';\n"), /不是 deno\.json 锁的版本/],
    ['_shared/gen 里有不是 .ts 的文件', (pub) => void write(pub, 'supabase/functions/_shared/gen/b.js', 'export {};\n'), /不是 \.ts 的文件：b\.js/],
    ['正式包里混进预览函数', (pub) => void write(pub, 'supabase/functions/voice-probe/index.ts', 'x'), /这个 tag 的源码里没有|预览专用函数/],
    ['要部署的函数不在包里', () => undefined, /没有要部署的服务器函数：beta/, ['--functions', 'alpha,usage-report,beta']],
  ];
  for (const [what, tamper, re, args] of bad) {
    it(`反例：${what} → 停`, () => {
      const r = makeRepo();
      try {
        const pub = makePub(r);
        const t = tamper(pub, r);
        const p = bundleCheck(r, pub, typeof t === 'string' ? t : sums(pub), args);
        expect(p.code, p.text).toBe(1);
        expect(p.text).toMatch(re);
        expect(p.text).not.toContain('总指纹');
      } finally {
        rmSync(r.box, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------- 改库前备份
type Db = { hasDispatch: number; users: number; dispatched: number; doneAfter: number[]; status?: number };
async function runBackup(db: Db, extra: Record<string, string> = {}) {
  const seen: string[] = [];
  const queries: string[] = [];
  let polls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(String(req.headers.authorization));
      const q = String(JSON.parse(body).query);
      const send = (rows: unknown[]) => res.writeHead(db.status ?? 201, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
      if (q.includes('has_dispatch')) return send([{ has_dispatch: db.hasDispatch, has_users: 1 }]);
      if (q.includes('account_usable(p.user_id)')) return send([{ n: db.users }]);
      if (q.includes('to_char(now()')) return send([{ t: '2026-11-28T01:00:00Z', d: '2026-11-28', d2: '2026-11-29' }]);
      if (q.includes("backup_dispatch('publish')")) return send([{ n: db.dispatched }]);
      if (q.includes('storage.objects')) {
        queries.push(q);
        return send([{ n: db.doneAfter[Math.min(polls++, db.doneAfter.length - 1)] }]);
      }
      res.writeHead(400).end('[]');
      return undefined;
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  const token = 'sbp_test_' + 'x'.repeat(30);
  try {
    const out = await new Promise<{ code: number | null; text: string }>((ok) => {
      const p = spawn(BASH ?? 'bash', ['--noprofile', '--norc', join(CI, 'release-backup.sh')], {
        env: { PATH: process.env.PATH, SUPABASE_ACCESS_TOKEN: token, PROJECT_REF: 'abcdefghijklmnopqrst', BACKUP_API: `http://127.0.0.1:${port}`, BACKUP_POLL_SECONDS: '1', ...extra },
      });
      let text = '';
      p.stdout.on('data', (c) => (text += c));
      p.stderr.on('data', (c) => (text += c));
      p.on('close', (c) => ok({ code: c, text }));
    });
    return { ...out, token, seen, queries };
  } finally {
    server.close();
  }
}

describe.skipIf(!BASH || !JQ)('build/ci/release-backup.sh（本机假 SQL 接口）', () => {
  it('触发后等到每个人的备份都写完才通过；令牌只在请求头里、不进输出', async () => {
    const r = await runBackup({ hasDispatch: 1, users: 2, dispatched: 2, doneAfter: [0, 1, 2] });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/已做完 2 \/ 2/);
    expect(r.text).toMatch(/改库前的备份做完了/);
    expect(r.seen.every((h) => h === `Bearer ${r.token}`)).toBe(true);
    expect(r.text).not.toContain(r.token);
    // 跨零点：当天和第二天的日期都算，按 user_id 去重
    expect(r.queries[0]).toContain("in ('2026-11-28', '2026-11-29')");
    expect(r.queries[0]).toContain("count(distinct split_part(name, '/', 2))");
  });

  it('backup_dispatch 发的请求比可用账号少 → 停', async () => {
    const r = await runBackup({ hasDispatch: 1, users: 3, dispatched: 2, doneAfter: [2] });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/有 3 个可用账号，backup_dispatch 只发了 2 个请求/);
  });

  it('有可用账号、backup_dispatch 却一个都没发 → 停（不当成首发跳过）', async () => {
    const r = await runBackup({ hasDispatch: 1, users: 2, dispatched: 0, doneAfter: [0] });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/只发了 0 个请求/);
  });

  it('GitHub Actions 上设了 BACKUP_API → 停，一个请求都不发', async () => {
    const r = await runBackup({ hasDispatch: 1, users: 1, dispatched: 1, doneAfter: [1] }, { GITHUB_ACTIONS: 'true' });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/CI 上不许设 BACKUP_API/);
    expect(r.seen.length).toBe(0);
  });

  it('首发：库里还没有 backup_dispatch、也没有可用账号 → 跳过', async () => {
    const r = await runBackup({ hasDispatch: 0, users: 0, dispatched: 0, doneAfter: [0] });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/跳过改库前的备份/);
  });

  it('有可用账号却没有 backup_dispatch → 停', async () => {
    const r = await runBackup({ hasDispatch: 0, users: 3, dispatched: 0, doneAfter: [0] });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/有 3 个可用账号，却没有 private\.backup_dispatch/);
  });

  it('等到上限还没做完 → 停在改库之前', async () => {
    const r = await runBackup({ hasDispatch: 1, users: 2, dispatched: 2, doneAfter: [1] }, { BACKUP_MAX_SECONDS: '2' });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/只做完 1 \/ 2/);
    expect(r.text).toMatch(/还没改库/);
  });

  it('令牌没有 Database 权限（403）→ 停，只报状态码', async () => {
    const r = await runBackup({ hasDispatch: 1, users: 1, dispatched: 1, doneAfter: [1], status: 403 });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/HTTP 403/);
  });
});
