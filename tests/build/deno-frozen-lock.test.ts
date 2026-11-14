// 服务器函数依赖锁的脚本 build/ci/deno-frozen-lock.sh 真的拦得住锁外依赖（接手清单 REVIEW-1030-be-sugg ③；架构 0.33 第 7 条、B0 安全审查低 10）：
// 把 supabase/functions 复制到系统临时目录（不带本机的 _shared/gen/，按 CI 的顺序用 build/copy_shared.mjs 重新生成），对副本直接跑脚本。
// 第一组（不需要 deno）钉住 ci.yml、deploy-preview.yml 都调这一份脚本（第三方审查 CI-8：原来两份 shell 副本，这里只逐字核 ci.yml 那份）。
// 正例：往源码里塞一个锁里没有的 zod 版本——从 Deno 缓存的 zod registry.json（路径由 deno info --json 的 npmCache 给），
//   缓存里没有就联网取 registry.npmjs.org/zod 的版本列表（10-31：已有 tarball 时预热不落 registry.json，CI 第二十九批踩到），从中挑一个
//   已发布的正式版，不等于锁定版本、锁里也没有：优先同一大版本里比锁定版本小的最大那个（现在锁 4.6.7 → 挑 4.6.6），没有就取其余最大的
//   → 脚本退出码不是 0、输出里有 “lockfile is out of date”；只跑 deno install --frozen 一行查不出来（它只核 deno.json 和 deno.lock），所以脚本里第二行不能省。
// 反例：换成锁里有的版本（deno.json 里 zod 那一项）→ 脚本通过。两种情况跑完 deno.json、deno.lock 一个字节都不变。
// 没有 deno 时跳过第二组——除非设了 LEMO_REQUIRE_DENO=1（unit.yml 的单元测试那一步设了，并用 setup-deno 装好和 ci.yml 同一版）：
//   开关打开却没有 deno 就失败，不再悄悄跳过（接手清单 DENO-lock-ci）。另一组核对 unit.yml 的这两处没被删、版本和 ci.yml 一致。
// 会起子进程（node、bash、deno），在 vitest.config.ts 的 SLOW_NODE_TESTS 里登记。
// 联网：用 Deno 默认的全局缓存（不另设 DENO_DIR）。判“锁过期”不用联网的前提是缓存里已有 zod 的注册表元数据——beforeAll 先在临时目录
//   跑一遍 deno install --frozen（空缓存时联网取锁里的包，通常顺带存下 zod 的 registry.json；不一定存，所以挑版本时缓存没有就联网取）。正例特意选同一个包的锁外版本：
//   换成 left-pad 这类缓存里没有的包，Deno 要先去 npm 注册表取元数据，断网时报的是网络错误，到不了“锁过期”那一步。
//   审查员在断网加隔离缓存（只预热过 zod）的条件下实测过 zod@4.6.6，报 “The lockfile is out of date”。用完删掉临时目录。
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const FN = join(ROOT, 'supabase', 'functions');
const SCRIPT = join(ROOT, 'build', 'ci', 'deno-frozen-lock.sh');
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';
const HAS_DENO = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0;
/** 设成 1 时没有 deno 就失败（unit.yml 单元测试那一步设）；本机不设，没有 deno 照旧跳过 */
const REQUIRE_VAR = 'LEMO_REQUIRE_DENO';
const REQUIRE_DENO = process.env[REQUIRE_VAR] === '1';
const PROBE = join('_shared', 'lemo-frozen-probe.ts');
const ENV = { ...process.env, NO_COLOR: '1' };
const CI_STEP = '服务器函数的依赖锁';
const RUN_LINE = 'run: bash build/ci/deno-frozen-lock.sh';

const indent = (l: string) => l.length - l.trimStart().length;

/** 纯函数：工作流文本里名字含 name 的步骤有几个；第一个的起始行号、各行（开头的 “- ” 换成两个空格）和这一步的顶层键 */
function findStep(yml: string, name: string) {
  const lines = yml.split(/\r?\n/);
  const named = lines.flatMap((l, i) => (/^\s*(?:-\s*)?name:/.test(l) && l.includes(name) ? [i] : []));
  let start = named[0] ?? 0;
  while (start > 0 && !/^\s*-\s/.test(lines[start] ?? '')) start--;   // name 不是第一个键时，往回找到这一步的 “- ”
  const stepIndent = indent(lines[start] ?? '');
  let end = start + 1;
  while (end < lines.length && !(lines[end]?.trim() && indent(lines[end] ?? '') <= stepIndent)) end++;
  const step = [(lines[start] ?? '').replace(/^(\s*)-\s/, '$1  '), ...lines.slice(start + 1, end)];
  const keys = step.filter((l) => l.trim() && indent(l) === stepIndent + 2).map((l) => l.trim());
  return { count: named.length, start, step, keys };
}

/** 纯函数：工作流里“服务器函数的依赖锁”那一步正好一个、只调脚本、不带 if 和 continue-on-error（空数组 = 全对） */
function lockStepProblems(yml: string): string[] {
  const { count, keys } = findStep(yml, CI_STEP);
  if (count !== 1) return [`名字含“${CI_STEP}”的步骤有 ${count} 个，应该正好 1 个`];
  const out: string[] = [];
  for (const k of ['continue-on-error', 'if']) {
    if (keys.some((l) => l.startsWith(`${k}:`))) out.push(`这一步带了 ${k}:，失败可能被放过或整步被跳过`);
  }
  if (!keys.includes(RUN_LINE)) out.push(`这一步不是 ${RUN_LINE}`);
  return out;
}

const CI_YML = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const UNIT_YML = readFileSync(join(ROOT, '.github', 'workflows', 'unit.yml'), 'utf8');
const UNIT_STEP = '单元和组件测试';
const REQUIRE_LINE = `${REQUIRE_VAR}: '1'`;

describe('ci.yml、deploy-preview.yml 的“服务器函数的依赖锁”都调 build/ci/deno-frozen-lock.sh（不需要 deno）', () => {
  for (const f of ['ci.yml', 'deploy-preview.yml']) {
    it(`真实的 ${f}：正好一步、只调脚本、不带 if 和 continue-on-error`, () => {
      expect(lockStepProblems(readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8'))).toEqual([]);
    });
  }

  it('反向验证：删掉整步、改成别的命令、加了 continue-on-error 或 if（写在 name 前后都算）、同名步骤出现两个 → 核对报出来', () => {
    const run = `        ${RUN_LINE}`;
    expect(CI_YML.split(/\r?\n/).filter((l) => l === run), '前提：调脚本的那一行缩进 8 格且只有一处').toHaveLength(1);
    expect(lockStepProblems(CI_YML.replace(CI_STEP, '别的步骤'))).toEqual([expect.stringContaining('有 0 个')]);
    expect(lockStepProblems(CI_YML.replace(run, '        run: deno install --frozen'))).toEqual([expect.stringContaining(RUN_LINE)]);
    expect(lockStepProblems(CI_YML.replace(run, `${run}\n        continue-on-error: true`))).toEqual([expect.stringContaining('continue-on-error:')]);
    expect(lockStepProblems(CI_YML.replace(run, `${run}\n        if: github.event_name == 'push'`))).toEqual([expect.stringContaining('if:')]);
    const nameLine = CI_YML.split(/\r?\n/).find((l) => l.includes(CI_STEP)) ?? '';
    expect(lockStepProblems(CI_YML.replace(nameLine, `      - if: false\n${nameLine.replace('- name:', '  name:')}`))).toEqual([expect.stringContaining('if:')]);
    expect(lockStepProblems(CI_YML.replace('- name: 找旧版契约测试的基线', `- name: ${CI_STEP}（第二个）`))).toEqual([expect.stringContaining('有 2 个')]);
  });
});

/** 纯函数：unit.yml 装了和 ci.yml 同一个 setup-deno（同一 SHA、同一 deno-version），装在单元测试那一步之前，且那一步设了 LEMO_REQUIRE_DENO=1 */
function unitDenoProblems(unit: string, ci: string): string[] {
  const grab = (y: string, re: RegExp) => y.split(/\r?\n/).flatMap((l, i) => (re.test(l.trim().replace(/^-\s+/, '')) ? [{ i, t: l.trim().replace(/^-\s+/, '') }] : []));
  const USES = /^uses:\s*denoland\/setup-deno@/;
  const VER = /^deno-version:/;
  const [cu, cv, uu, uv] = [grab(ci, USES), grab(ci, VER), grab(unit, USES), grab(unit, VER)];
  if (cu.length !== 1 || cv.length !== 1) return ['前提不成立：ci.yml 里 setup-deno、deno-version 应各正好 1 处'];
  const out: string[] = [];
  if (uu.length !== 1 || uu[0]?.t !== cu[0]?.t) out.push(`unit.yml 的 setup-deno 应正好 1 处且和 ci.yml 逐字相同：${cu[0]?.t}`);
  if (uv.length !== 1 || uv[0]?.t !== cv[0]?.t) out.push(`unit.yml 的 deno-version 应正好 1 处且和 ci.yml 相同：${cv[0]?.t}`);
  const { count, start, step, keys } = findStep(unit, UNIT_STEP);
  if (count !== 1) return [...out, `unit.yml 里名字含“${UNIT_STEP}”的步骤应正好 1 个，现在 ${count} 个`];
  if (uu[0] && uu[0].i > start) out.push(`unit.yml 的 setup-deno 要装在“${UNIT_STEP}”那一步之前`);
  if (!keys.includes('env:') || !step.some((l) => l.trim() === REQUIRE_LINE)) out.push(`“${UNIT_STEP}”那一步的 env 里没有 ${REQUIRE_LINE}`);
  // 11-10 单元测试拆成三时区矩阵作业：setup-deno 必须和单元测试在同一个作业里（装在别的作业，这个作业里照样没有 deno）
  const lines = unit.split(/\r?\n/);
  const jobAt = (i: number) => {
    for (let k = i; k >= 0; k--) if (/^ {2}[\w-]+:\s*$/.test(lines[k] ?? '')) return k;
    return -1;
  };
  const jobStart = jobAt(start);
  if (uu[0] && jobAt(uu[0].i) !== jobStart) out.push(`unit.yml 的 setup-deno 要和“${UNIT_STEP}”在同一个作业里`);
  // 三个时区一个不少（架构第 9 节 H2）：那一步的 env 写 TZ: ${{ matrix.tz }}，所在作业的矩阵正好是这三个
  if (!step.some((l) => l.trim() === 'TZ: ${{ matrix.tz }}')) out.push(`“${UNIT_STEP}”那一步的 env 里没有 TZ: \${{ matrix.tz }}`);
  const tzLine = lines.slice(Math.max(jobStart, 0), start).find((l) => /^\s*tz:\s*\[/.test(l))?.trim() ?? '';
  if (tzLine !== 'tz: [UTC, Asia/Seoul, America/Los_Angeles]') out.push(`“${UNIT_STEP}”所在作业的矩阵应正好是 tz: [UTC, Asia/Seoul, America/Los_Angeles]，现在：${tzLine || '没有'}`);
  return out;
}

describe('unit.yml 真的跑第二组：装了 deno、开关打开时没有 deno 就失败（DENO-lock-ci，不需要 deno）', () => {
  it(`${REQUIRE_VAR}=1 时必须有 deno（否则第二组会被 skipIf 悄悄跳过）`, () => {
    expect(!REQUIRE_DENO || HAS_DENO, `设了 ${REQUIRE_VAR}=1，但 deno --version 跑不起来：CI 里检查 unit.yml 的 setup-deno 那一步`).toBe(true);
  });

  it('真实的 unit.yml：setup-deno 和 ci.yml 同 SHA、同版本，装在单元测试之前；单元测试那一步设了开关', () => {
    expect(unitDenoProblems(UNIT_YML, CI_YML)).toEqual([]);
  });

  it('反向验证：删掉 setup-deno、改了版本、删掉开关、把 setup-deno 挪到单元测试之后 → 核对报出来', () => {
    const lines = UNIT_YML.split(/\r?\n/);
    const without = (pred: (l: string) => boolean) => {
      const i = lines.findIndex(pred);
      expect(i, '前提：真实 unit.yml 里有这一行').toBeGreaterThanOrEqual(0);
      return [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n');
    };
    expect(unitDenoProblems(without((l) => l.includes('denoland/setup-deno@')), CI_YML)).toEqual([expect.stringContaining('setup-deno 应正好 1 处')]);
    expect(unitDenoProblems(UNIT_YML.replace(/deno-version: \S+/, 'deno-version: 2.0.0'), CI_YML)).toEqual([expect.stringContaining('deno-version')]);
    expect(unitDenoProblems(without((l) => l.trim() === REQUIRE_LINE), CI_YML)).toEqual([expect.stringContaining(REQUIRE_LINE)]);
    const usesAt = lines.findIndex((l) => l.includes('denoland/setup-deno@'));
    const block = lines.slice(usesAt, usesAt + 4);   // - uses、with、注释、deno-version
    expect(block.at(-1)?.trim(), '前提：setup-deno 这一步正好 4 行').toMatch(/^deno-version:/);
    const rest = [...lines.slice(0, usesAt), ...lines.slice(usesAt + 4)];
    // 挪到同一作业里单元测试那一步之后（11-10 起单元测试是 unit-tz 作业的最后一步，紧跟着是 secrets-scan 作业）
    const at = rest.findIndex((l) => /^ {2}secrets-scan:/.test(l));
    expect(at, '前提：unit-tz 作业之后是 secrets-scan').toBeGreaterThan(0);
    expect(unitDenoProblems([...rest.slice(0, at - 1), ...block, ...rest.slice(at - 1)].join('\n'), CI_YML)).toEqual([expect.stringContaining('之前')]);
    // 挪到别的作业（check）里，哪怕仍在单元测试那一行之前，也报“同一个作业”
    const checkAt = rest.findIndex((l) => l.includes('name: wrangler 两处版本一致'));
    expect(checkAt, '前提：check 作业里有“wrangler 两处版本一致”那一步').toBeGreaterThan(0);
    expect(unitDenoProblems([...rest.slice(0, checkAt), ...block, ...rest.slice(checkAt)].join('\n'), CI_YML)).toEqual([expect.stringContaining('同一个作业')]);
  });

  it('反向验证：矩阵少一个时区、单元测试那一步不读矩阵的 TZ → 核对报出来', () => {
    const tz = 'tz: [UTC, Asia/Seoul, America/Los_Angeles]';
    expect(UNIT_YML.split(/\r?\n/).filter((l) => l.trim() === tz), '前提：矩阵这一行只有一处').toHaveLength(1);
    expect(unitDenoProblems(UNIT_YML.replace(tz, 'tz: [UTC, Asia/Seoul]'), CI_YML)).toEqual([expect.stringContaining('矩阵')]);
    expect(unitDenoProblems(UNIT_YML.replace('TZ: ${{ matrix.tz }}', "TZ: 'UTC'"), CI_YML)).toEqual([expect.stringContaining('matrix.tz')]);
  });
});

let dir = '';
let fn = '';

const deno = (args: string[]): SpawnSyncReturns<string> => spawnSync('deno', args, { cwd: fn, encoding: 'utf8', env: ENV, timeout: 120_000 });
const text = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
/** 对临时副本跑 CI 用的同一份脚本 */
const runScript = (): SpawnSyncReturns<string> =>
  spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', SCRIPT, fn], { cwd: ROOT, encoding: 'utf8', env: ENV, timeout: 240_000 });

const lockFiles = () => [readFileSync(join(fn, 'deno.json'), 'utf8'), readFileSync(join(fn, 'deno.lock'), 'utf8')];
/** 锁里有没有这个 zod 版本（npm:zod@x.y.z 的映射或 zod@x.y.z 的包条目；4.6.1 不会误中 4.6.10） */
const lockHasZod = (lock: string, v: string) => new RegExp(`zod@${v.replace(/\./g, '\\.')}(?![\\d.])`).test(lock);

type Versions = Record<string, { deprecated?: string }>;
const ZOD_REGISTRY = 'https://registry.npmjs.org/zod';

/** zod 的已发布版本：先读 Deno 缓存（路径取 deno info --json 的 npmCache，不推算）里的 registry.json；
 *  没有就联网取 npm 注册表的版本列表（缩略元数据，含 deprecated）。10-31 Linux 实测：缓存里已有 tarball 时
 *  deno install --frozen 会重下元数据却不落 registry.json，CI 第二十九批就是这样读不到的，所以缓存只当捷径 */
async function zodVersions(): Promise<{ versions: Versions; from: string }> {
  const info = spawnSync('deno', ['info', '--json'], { encoding: 'utf8', env: ENV });
  const npmCache = info.status === 0 ? (JSON.parse(info.stdout) as { npmCache?: string }).npmCache : undefined;
  if (!npmCache) throw new Error(`deno info --json 没给出 npmCache（退出码 ${info.status}）：${text(info)}`);
  const file = join(npmCache, 'registry.npmjs.org', 'zod', 'registry.json');
  let cacheNote = '';
  try {
    const versions = (JSON.parse(readFileSync(file, 'utf8')) as { versions?: Versions }).versions ?? {};
    if (Object.keys(versions).length > 0) return { versions, from: file };
    cacheNote = `${file} 里没有 versions`;
  } catch (e) {
    cacheNote = `${file} 读不到（${String(e)}）`;
  }
  try {
    const res = await fetch(ZOD_REGISTRY, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const versions = ((await res.json()) as { versions?: Versions }).versions ?? {};
    if (Object.keys(versions).length === 0) throw new Error('返回里没有 versions');
    return { versions, from: ZOD_REGISTRY };
  } catch (e) {
    throw new Error(`联网取 zod 版本列表失败：${ZOD_REGISTRY}（${String(e)}）；缓存也用不上：${cacheNote}。处理：联网后重跑本测试`);
  }
}

/** 从 zod 的已发布版本里挑一个不等于锁定版本、锁里也没有的正式版；挑不到就抛出带处理办法的错误 */
async function pickOutsideZod(locked: string, lock: string): Promise<string> {
  const { versions, from } = await zodVersions();
  const pick = chooseOutside(versions, locked, lock);
  if (!pick) throw new Error(`${from} 里除了锁定的 ${locked} 没有别的可用正式版（共 ${Object.keys(versions).length} 个版本）。zod 只发过这一个正式版时，改用别的包做探针`);
  return pick;
}

/** 纯函数：已发布的正式版（x.y.z、没标 deprecated）里去掉锁定版本和锁里有的，优先同一大版本里比锁定版本小的最大那个，没有就取其余最大的；一个都没有返回 undefined */
function chooseOutside(versions: Record<string, { deprecated?: string }>, locked: string, lock: string): string | undefined {
  const num = (v: string) => v.split('.').map(Number);
  const cmp = (a: string, b: string) => {
    const [x, y] = [num(a), num(b)];
    return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
  };
  const ok = Object.keys(versions)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v !== locked && !versions[v]?.deprecated && !lockHasZod(lock, v))
    .sort((a, b) => cmp(b, a));
  return ok.find((v) => num(v)[0] === num(locked)[0] && cmp(v, locked) < 0) ?? ok[0];
}

describe('锁外 zod 版本怎么挑（chooseOutside，不需要 deno）', () => {
  const lock = '"npm:zod@5.0.0": "5.0.0"\n"zod@5.0.0": {}';
  it('补丁号是 0 也挑得到：同大版本没有更小的就取其余最大的；跳过预发布、deprecated、锁里有的', () => {
    expect(chooseOutside({ '4.9.9': {}, '4.3.1': {}, '5.0.0': {}, '5.0.1-beta.1': {} }, '5.0.0', lock)).toBe('4.9.9');
    expect(chooseOutside({ '4.6.5': {}, '4.6.6': {}, '4.6.7': {}, '4.6.10': {} }, '4.6.7', '"zod@4.6.7": {}')).toBe('4.6.6');
    expect(chooseOutside({ '4.6.6': { deprecated: 'x' }, '4.6.5': {}, '4.6.7': {} }, '4.6.7', '')).toBe('4.6.5');
    expect(chooseOutside({ '4.6.6': {}, '4.6.5': {}, '4.6.7': {} }, '4.6.7', '"zod@4.6.6": {}')).toBe('4.6.5');
  });
  it('只有锁定版本、或只剩预发布 → undefined（调用处据此报出处理办法）', () => {
    expect(chooseOutside({ '5.0.0': {} }, '5.0.0', lock)).toBeUndefined();
    expect(chooseOutside({ '5.0.0': {}, '5.1.0-rc.1': {} }, '5.0.0', lock)).toBeUndefined();
  });
});

const zodSpec = () => (JSON.parse(readFileSync(join(fn, 'deno.json'), 'utf8')) as { imports: Record<string, string> }).imports['zod'] ?? '';

/** 正例/反例共用：写探针、跑脚本、核对锁文件不变，最后删探针 */
function withProbe(src: string, check: (r: SpawnSyncReturns<string>) => void) {
  const before = lockFiles();
  writeFileSync(join(fn, PROBE), src);
  try {
    // 只跑第一行查不出锁外依赖（它只核 deno.json 和 deno.lock）：所以脚本里还有第二行
    const first = deno(['install', '--frozen']);
    expect(first.status, text(first)).toBe(0);
    check(runScript());
    expect(lockFiles()).toEqual(before);
  } finally {
    rmSync(join(fn, PROBE), { force: true });
  }
}

describe.skipIf(!HAS_DENO || !BASH)('build/ci/deno-frozen-lock.sh 拦得住锁外依赖（REVIEW-1030-be-sugg ③）', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-deno-frozen-'));
    fn = join(dir, 'functions');
    const gen = join(FN, '_shared', 'gen');
    cpSync(FN, fn, { recursive: true, filter: (src) => src !== gen && !src.startsWith(gen + sep) && !src.split(sep).includes('node_modules') });
    const cp = spawnSync(process.execPath, [join(ROOT, 'build', 'copy_shared.mjs'), join(fn, '_shared', 'gen')], { cwd: ROOT, encoding: 'utf8', env: ENV });
    expect(cp.status, text(cp)).toBe(0);
    // 预热缓存：空缓存（CI 的新机器）时联网取锁里的包和 zod 的 registry.json，后面挑锁外版本要读它；已有缓存时不联网
    //   单独给 240 秒（deno() 只给 120 秒）；超时被杀时 status 是 null，所以报错带上 error、signal
    const warm = spawnSync('deno', ['install', '--frozen'], { cwd: fn, encoding: 'utf8', env: ENV, timeout: 240_000 });
    expect(warm.status, `预热（联网取锁里的包）失败：status=${warm.status} signal=${warm.signal} error=${String(warm.error)}\n${text(warm)}`).toBe(0);
  }, 260_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('锁外的 zod（从缓存的 registry.json、没有就联网取的版本列表里挑一个已发布的别的版本）：脚本退出码不是 0，报 lockfile is out of date；只跑第一行查不出；锁文件不变', async () => {
    const locked = /^npm:zod@(\d+\.\d+\.\d+)$/.exec(zodSpec())?.[1];
    expect(locked, `deno.json 的 zod 不是 npm:zod@x.y.z：${zodSpec()}`).toBeTruthy();
    const outside = await pickOutsideZod(locked ?? '', lockFiles()[1] ?? '');
    expect(outside).not.toBe(locked);
    // 前提：锁里确实没有这个版本（npm:zod@x.y.z 的映射、zod@x.y.z 的包条目都没有）
    expect(lockHasZod(lockFiles()[1] ?? '', outside), `锁里不该有 zod@${outside}`).toBe(false);
    expect(lockHasZod(lockFiles()[1] ?? '', locked ?? ''), '对照：锁定版本在锁里查得到（证明上一条的查法有效）').toBe(true);
    withProbe(`import { z } from 'npm:zod@${outside}';\nexport const name = z.string();\n`, (r) => {
      expect(r.status, text(r)).not.toBe(0);
      expect(text(r).toLowerCase()).toContain('lockfile is out of date');
    });
  }, 240_000);

  it('反例：换成锁里有的版本（deno.json 的 zod）→ 脚本通过；锁文件不变', () => {
    expect(zodSpec()).toMatch(/^npm:zod@\d+\.\d+\.\d+$/);
    withProbe(`import { z } from '${zodSpec()}';\nexport const name = z.string();\n`, (r) => {
      expect(r.status, text(r)).toBe(0);
    });
  }, 240_000);
});
