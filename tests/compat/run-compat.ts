// 旧版客户端契约测试（架构 0.27 第 1 点“测试”、开发计划 v4 三之二、TC-B0-57）。
//
// 做法：取“上一个发布 tag”那一版的契约测试子集，对当前分支的数据库（CI 先 supabase db reset）跑一遍。
// - 基线：最新的 4.x 以上正式发布 tag（vX.Y.Z，不含 -preview；v3 的不算）；还没有发布过时用内部 tag `compat-baseline`（B0 由运维打）；都没有就跳过。
// - 子集名单读**基线那一版**的 tests/compat/subset.json（旧版自己说哪些用例和结构无关、可以拿来打新库）。
// - 上线前（基线是 compat-baseline）只报告、不拦：上线前没有用户，不受“先加后删”约束；
//   从 4.0.0 的发布 tag 起必须通过（--mode 可以强制指定）。
// - 这个 PR 提高了 min_client_version 的，旧版写入应当收到 upgrade_required：由用例自己按环境变量
//   COMPAT_EXPECT_UPGRADE=1 改断言（4.0.0 起的契约用例按这个约定写）。
//
// 用法（CI，supabase start、db reset 之后）：
//   node tests/compat/run-compat.ts [--mode report|enforce] [--keep]
// 需要 Node 22.18 以上；基线那一版在临时 git worktree 里 `npm ci --ignore-scripts` 后用它自己的 vitest 跑。
// 打 compat-baseline tag、接进 ci.yml 由运维做；“只加列”的样例迁移由后端写。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_TAG = 'compat-baseline';
const RELEASE_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export type CompatMode = 'report' | 'enforce';

/** 从 tag 列表里挑基线：最高的 4.x 以上正式发布 tag（v3 的测试不是 4.x 的契约，不算），否则 compat-baseline，否则 null */
export function pickBaseline(tags: readonly string[]): string | null {
  const releases = tags
    .map((t) => ({ t, m: RELEASE_RE.exec(t) }))
    .filter((x): x is { t: string; m: RegExpExecArray } => x.m !== null)
    .map(({ t, m }) => ({ t, v: [Number(m[1]), Number(m[2]), Number(m[3])] as const }))
    .filter((x) => x.v[0] >= 4)
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  if (releases[0]) return releases[0].t;
  return tags.includes(BASELINE_TAG) ? BASELINE_TAG : null;
}

/** 基线是正式发布（≥ 4.0.0）就必须通过；compat-baseline 只报告 */
export function modeFor(baseline: string): CompatMode {
  const m = RELEASE_RE.exec(baseline);
  if (!m) return 'report';
  return Number(m[1]) >= 4 ? 'enforce' : 'report';
}

export interface Subset {
  version: 1;
  /** 相对仓库根目录的测试文件路径 */
  files: string[];
}

export function parseSubset(text: string): Subset {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object') throw new Error('subset.json 不是对象');
  const o = raw as { version?: unknown; files?: unknown };
  if (o.version !== 1) throw new Error('subset.json 的 version 必须是 1');
  if (!Array.isArray(o.files) || !o.files.every((f): f is string => typeof f === 'string')) throw new Error('subset.json 的 files 必须是字符串数组');
  for (const f of o.files) {
    if (f.startsWith('/') || f.includes('..') || !/^tests\/[\w./-]+\.test\.ts$/.test(f)) throw new Error(`subset.json 里的路径不合规：${f}`);
  }
  return { version: 1, files: o.files };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function main(): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const args = process.argv.slice(2);
  const mi = args.indexOf('--mode');
  const forced = mi >= 0 ? args[mi + 1] : undefined;
  if (forced && forced !== 'report' && forced !== 'enforce') throw new Error('--mode 只能是 report 或 enforce');

  const baseline = pickBaseline(git(['tag', '--list'], root).split('\n').filter(Boolean));
  if (!baseline) {
    console.log('compat：还没有发布 tag，也没有 compat-baseline，跳过（4.0.0 第一次没有上一个 tag）');
    return 0;
  }
  const mode: CompatMode = (forced as CompatMode | undefined) ?? modeFor(baseline);
  console.log(`compat：基线 ${baseline}，模式 ${mode === 'enforce' ? '必须通过' : '只报告'}`);

  const dir = mkdtempSync(join(tmpdir(), 'lemo-compat-'));
  git(['worktree', 'add', '--detach', dir, baseline], root);
  try {
    const subsetPath = join(dir, 'tests', 'compat', 'subset.json');
    if (!existsSync(subsetPath)) {
      console.log('compat：基线里没有 tests/compat/subset.json，跳过');
      return 0;
    }
    const subset = parseSubset(readFileSync(subsetPath, 'utf8'));
    if (subset.files.length === 0) {
      console.log('compat：基线的子集名单是空的，没有可跑的用例');
      return 0;
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const ci = spawnSync(npm, ['ci', '--ignore-scripts'], { cwd: dir, stdio: 'inherit' });
    if (ci.status !== 0) throw new Error('compat：基线那一版 npm ci 失败');
    // 当前数据库的地址和密钥由 CI 的环境变量传下去（supabase start 的本地值）
    const run = spawnSync(npx, ['vitest', 'run', ...subset.files], { cwd: dir, stdio: 'inherit', env: { ...process.env, COMPAT_RUN: '1' } });
    const ok = run.status === 0;
    console.log(`compat：旧版契约子集 ${ok ? '全部通过' : '有失败'}`);
    if (!ok && mode === 'report') {
      console.log('compat：上线前只报告、不拦（开发计划三之二）');
      return 0;
    }
    return ok ? 0 : 1;
  } finally {
    if (!args.includes('--keep')) {
      git(['worktree', 'remove', '--force', dir], root);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
