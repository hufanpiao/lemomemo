// 服务器函数依赖锁的 CI 步骤真的拦得住锁外依赖（接手清单 REVIEW-1030-be-sugg ③；架构 0.33 第 7 条、B0 安全审查低 10）：
// 把 supabase/functions 复制到系统临时目录（不带本机的 _shared/gen/，按 CI 的顺序用 build/copy_shared.mjs 重新生成），
// 照 .github/workflows/ci.yml“服务器函数的依赖锁”那一步原样跑两行：
//   deno install --frozen
//   deno install --frozen --no-check --entrypoint <全部源码>
// 这两行和 find 的扩展名清单是从 ci.yml 抄的：第一组测试直接读 ci.yml 逐字核对（不需要 deno），ci.yml 改了这里就报，
//   再把读到的内容去掉一行，证明核对真的会失败。runCi()、entries() 用的就是这里核对过的命令和扩展名。
// 正例：往源码里塞一个锁里没有的 zod 版本——从 Deno 缓存的 zod registry.json（路径由 deno info --json 的 npmCache 给）里挑一个
//   已发布的正式版，不等于锁定版本、锁里也没有：优先同一大版本里比锁定版本小的最大那个（现在锁 4.6.7 → 挑 4.6.6），没有就取其余最大的
//   → 第二行退出码不是 0、输出里有 “lockfile is out of date”；只跑第一行查不出来（它只核 deno.json 和 deno.lock），所以第二行不能省。
// 反例：换成锁里有的版本（deno.json 里 zod 那一项）→ 两行都通过。两种情况跑完 deno.json、deno.lock 一个字节都不变。
// 没有 deno 时跳过第二组——除非设了 LEMO_REQUIRE_DENO=1（unit.yml 的单元测试那一步设了，并用 setup-deno 装好和 ci.yml 同一版）：
//   开关打开却没有 deno 就失败，不再悄悄跳过（接手清单 DENO-lock-ci）。第一组另外核对 unit.yml 的这两处没被删、版本和 ci.yml 一致。
// 会起子进程（node、deno），在 vitest.config.ts 的 SLOW_NODE_TESTS 里登记。
// 联网：用 Deno 默认的全局缓存（不另设 DENO_DIR）。判“锁过期”不用联网的前提是缓存里已有 zod 的注册表元数据——beforeAll 先在临时目录
//   跑一遍第一行（空缓存时联网取锁里的包，顺带取下 zod 整个包的元数据，即上面那份 registry.json，列着全部已发布版本；CI 的新机器靠这一步）。正例特意选同一个包的锁外版本：
//   换成 left-pad 这类缓存里没有的包，Deno 要先去 npm 注册表取元数据，断网时报的是网络错误，到不了“锁过期”那一步。
//   审查员在断网加隔离缓存（只预热过 zod）的条件下实测过 zod@4.6.6，报 “The lockfile is out of date”。用完删掉临时目录。
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const FN = join(ROOT, 'supabase', 'functions');
const HAS_DENO = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0;
/** 设成 1 时没有 deno 就失败（unit.yml 单元测试那一步设）；本机不设，没有 deno 照旧跳过 */
const REQUIRE_VAR = 'LEMO_REQUIRE_DENO';
const REQUIRE_DENO = process.env[REQUIRE_VAR] === '1';
const PROBE = join('_shared', 'lemo-frozen-probe.ts');
const ENV = { ...process.env, NO_COLOR: '1' };

/** ci.yml 里 find 的扩展名清单（顺序也照抄）；entries() 的过滤由它生成 */
const CI_EXTS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'] as const;
const SOURCE_EXT = new RegExp(`\\.(${CI_EXTS.join('|')})$`);
const CI_STEP = '服务器函数的依赖锁';
/** 那一步 run 块里必须逐字出现的行（去掉首尾空白后整行相等） */
const CI_FIRST = 'deno install --frozen';
const CI_SECOND = 'deno install --frozen --no-check --entrypoint "${entries[@]}"';
const CI_FIND = `find . -type f \\( ${CI_EXTS.map((e) => `-name '*.${e}'`).join(' -o ')} \\) -not -path '*/node_modules/*' | sort`;

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

/** 纯函数：在 ci.yml 文本里找“服务器函数的依赖锁”那一步，返回缺了什么（空数组 = 全对） */
function ciLockStepProblems(yml: string): string[] {
  const { count, step, keys } = findStep(yml, CI_STEP);
  if (count === 0) return [`ci.yml 里找不到名字含“${CI_STEP}”的步骤`];
  if (count > 1) return [`ci.yml 里名字含“${CI_STEP}”的步骤有 ${count} 个，应该正好 1 个`];
  const out: string[] = [];
  for (const k of ['continue-on-error', 'if']) {
    if (keys.some((l) => l.startsWith(`${k}:`))) out.push(`这一步带了 ${k}:，失败可能被放过或整步被跳过`);
  }
  if (!keys.includes('working-directory: supabase/functions')) out.push('这一步不在 supabase/functions 下跑（working-directory）');
  const r = step.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  if (r < 0) return [...out, '这一步没有 run: | 块'];
  const runIndent = indent(step[r] ?? '');
  const run: string[] = [];
  for (const l of step.slice(r + 1)) {
    if (l.trim() && indent(l) <= runIndent) break;
    run.push(l.trim());
  }
  if (!run.includes(CI_FIRST)) out.push(`run 块里没有整行 ${CI_FIRST}`);
  if (!run.includes(CI_SECOND)) out.push(`run 块里没有整行 ${CI_SECOND}`);
  if (!run.some((l) => l.includes(CI_FIND))) out.push(`run 块里的 find 和这里的扩展名清单对不上：${CI_FIND}`);
  return out;
}

const CI_YML = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const UNIT_YML = readFileSync(join(ROOT, '.github', 'workflows', 'unit.yml'), 'utf8');
const UNIT_STEP = '单元和组件测试';
const REQUIRE_LINE = `${REQUIRE_VAR}: '1'`;

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
  return out;
}

describe('ci.yml“服务器函数的依赖锁”那一步和本测试跑的命令一致（不需要 deno）', () => {
  it('真实的 ci.yml：两行命令、find 的扩展名清单、working-directory 一条不缺', () => {
    expect(ciLockStepProblems(CI_YML)).toEqual([]);
  });

  it('反向验证：读到的 ci.yml 去掉任意一行必需内容（或改掉一个扩展名、删掉整步）→ 核对报出来', () => {
    const lines = CI_YML.split(/\r?\n/);
    const from = lines.findIndex((l) => l.includes(CI_STEP));
    const drop = (pred: (l: string) => boolean) => {
      const i = lines.findIndex((l, k) => k > from && pred(l));   // 只删那一步里的行，别的步骤有同样的行也不碰
      expect(i, '前提：真实 ci.yml 里有这一行').toBeGreaterThanOrEqual(0);
      return [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n');
    };
    expect(ciLockStepProblems(drop((l) => l.trim() === CI_FIRST))).toEqual([expect.stringContaining(`整行 ${CI_FIRST}`)]);
    expect(ciLockStepProblems(drop((l) => l.trim() === CI_SECOND))).toEqual([expect.stringContaining('--entrypoint')]);
    expect(ciLockStepProblems(drop((l) => l.includes(CI_FIND)))).toEqual([expect.stringContaining('扩展名清单')]);
    expect(ciLockStepProblems(drop((l) => l.trim() === 'working-directory: supabase/functions'))).toEqual([expect.stringContaining('working-directory')]);
    expect(ciLockStepProblems(CI_YML.replace(" -o -name '*.cjs'", ''))).toEqual([expect.stringContaining('扩展名清单')]);
    expect(ciLockStepProblems(CI_YML.replace(CI_STEP, '别的步骤'))).toEqual([expect.stringContaining('找不到')]);
  });

  it('反向验证：那一步加了 continue-on-error 或 if（写在 name 前后都算）、同名步骤出现两个 → 核对报出来', () => {
    const wd = '        working-directory: supabase/functions';
    expect(CI_YML.split(/\r?\n/).filter((l) => l === wd), '前提：working-directory 行的缩进是 8 格且只有一处').toHaveLength(1);
    expect(ciLockStepProblems(CI_YML.replace(wd, `${wd}\n        continue-on-error: true`))).toEqual([expect.stringContaining('continue-on-error:')]);
    expect(ciLockStepProblems(CI_YML.replace(wd, `${wd}\n        if: github.event_name == 'push'`))).toEqual([expect.stringContaining('if:')]);
    const nameLine = CI_YML.split(/\r?\n/).find((l) => l.includes(CI_STEP)) ?? '';
    expect(ciLockStepProblems(CI_YML.replace(nameLine, `      - if: false\n${nameLine.replace('- name:', '  name:')}`))).toEqual([expect.stringContaining('if:')]);
    expect(ciLockStepProblems(CI_YML.replace('- name: 找旧版契约测试的基线', `- name: ${CI_STEP}（第二个）`))).toEqual([expect.stringContaining('有 2 个')]);
  });
});

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
    const at = rest.findIndex((l) => l.includes('name: 离线数据库检查'));
    expect(at, '前提：单元测试之后有“离线数据库检查”那一步').toBeGreaterThan(0);
    expect(unitDenoProblems([...rest.slice(0, at), ...block, ...rest.slice(at)].join('\n'), CI_YML)).toEqual([expect.stringContaining('之前')]);
  });
});

let dir = '';
let fn = '';

/** ci.yml 的 find：全部源码，排除 node_modules，相对路径、排好序 */
function entries(base: string): string[] {
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE_EXT.test(d.name))
    .map((d) => relative(base, join(d.parentPath, d.name)).split(sep).join('/'))
    .filter((p) => !p.split('/').includes('node_modules'))
    .map((p) => `./${p}`)
    .sort();
}

const deno = (args: string[]): SpawnSyncReturns<string> => spawnSync('deno', args, { cwd: fn, encoding: 'utf8', env: ENV, timeout: 120_000 });
const text = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;

/** 照 CI 原样跑两行（命令和上面核对过的 CI_FIRST、CI_SECOND 一致） */
function runCi() {
  const first = deno(CI_FIRST.split(' ').slice(1));
  const list = entries(fn);
  const second = deno([...CI_SECOND.split(' ').slice(1, -1), ...list]);
  return { first, second, list };
}

const lockFiles = () => [readFileSync(join(fn, 'deno.json'), 'utf8'), readFileSync(join(fn, 'deno.lock'), 'utf8')];
/** 锁里有没有这个 zod 版本（npm:zod@x.y.z 的映射或 zod@x.y.z 的包条目；4.6.1 不会误中 4.6.10） */
const lockHasZod = (lock: string, v: string) => new RegExp(`zod@${v.replace(/\./g, '\\.')}(?![\\d.])`).test(lock);

/** Deno 缓存里 zod 的 registry.json 中挑一个已发布、不等于锁定版本、锁里也没有的正式版；挑不到就抛出带处理办法的错误 */
function pickOutsideZod(locked: string, lock: string): string {
  const info = spawnSync('deno', ['info', '--json'], { encoding: 'utf8', env: ENV });
  const npmCache = info.status === 0 ? (JSON.parse(info.stdout) as { npmCache?: string }).npmCache : undefined;
  if (!npmCache) throw new Error(`deno info --json 没给出 npmCache（退出码 ${info.status}）：${text(info)}`);
  const file = join(npmCache, 'registry.npmjs.org', 'zod', 'registry.json');
  let versions: Record<string, { deprecated?: string }> = {};
  try {
    versions = (JSON.parse(readFileSync(file, 'utf8')) as { versions?: typeof versions }).versions ?? {};
  } catch (e) {
    throw new Error(`读不到 Deno 缓存里 zod 的元数据 ${file}（${String(e)}）。处理：联网后在仓库根跑一次 deno task check，把 zod 的注册表元数据缓存下来再跑本测试`);
  }
  const pick = chooseOutside(versions, locked, lock);
  if (!pick) throw new Error(`${file} 里除了锁定的 ${locked} 没有别的可用正式版（共 ${Object.keys(versions).length} 个版本）。处理：联网后在仓库根跑 deno task check 刷新 zod 的元数据再跑；仍挑不到就说明 zod 只发过这一个正式版，改用别的已缓存包做探针`);
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

/** 正例/反例共用：写探针、跑两行、核对锁文件不变，最后删探针 */
function withProbe(src: string, check: (r: ReturnType<typeof runCi>) => void) {
  const before = lockFiles();
  writeFileSync(join(fn, PROBE), src);
  try {
    const r = runCi();
    expect(r.list).toContain(`./${PROBE.split(sep).join('/')}`);
    expect(r.first.status, text(r.first)).toBe(0);
    check(r);
    expect(lockFiles()).toEqual(before);
  } finally {
    rmSync(join(fn, PROBE), { force: true });
  }
}

describe.skipIf(!HAS_DENO)('服务器函数的依赖锁：deno install --frozen 拦得住锁外依赖（REVIEW-1030-be-sugg ③）', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-deno-frozen-'));
    fn = join(dir, 'functions');
    const gen = join(FN, '_shared', 'gen');
    cpSync(FN, fn, { recursive: true, filter: (src) => src !== gen && !src.startsWith(gen + sep) && !src.split(sep).includes('node_modules') });
    const cp = spawnSync(process.execPath, [join(ROOT, 'build', 'copy_shared.mjs'), join(fn, '_shared', 'gen')], { cwd: ROOT, encoding: 'utf8', env: ENV });
    expect(cp.status, text(cp)).toBe(0);
    // 预热缓存：空缓存（CI 的新机器）时联网取锁里的包和 zod 的 registry.json，后面挑锁外版本要读它；已有缓存时不联网
    //   单独给 240 秒（deno() 只给 120 秒）；超时被杀时 status 是 null，所以报错带上 error、signal
    const warm = spawnSync('deno', CI_FIRST.split(' ').slice(1), { cwd: fn, encoding: 'utf8', env: ENV, timeout: 240_000 });
    expect(warm.status, `预热（联网取锁里的包）失败：status=${warm.status} signal=${warm.signal} error=${String(warm.error)}\n${text(warm)}`).toBe(0);
  }, 260_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('锁外的 zod（从缓存的 registry.json 挑一个已发布的别的版本）：第二行（--entrypoint）退出码不是 0，报 lockfile is out of date；第一行查不出；锁文件不变', () => {
    const locked = /^npm:zod@(\d+\.\d+\.\d+)$/.exec(zodSpec())?.[1];
    expect(locked, `deno.json 的 zod 不是 npm:zod@x.y.z：${zodSpec()}`).toBeTruthy();
    const outside = pickOutsideZod(locked ?? '', lockFiles()[1] ?? '');
    expect(outside).not.toBe(locked);
    // 前提：锁里确实没有这个版本（npm:zod@x.y.z 的映射、zod@x.y.z 的包条目都没有）
    expect(lockHasZod(lockFiles()[1] ?? '', outside), `锁里不该有 zod@${outside}`).toBe(false);
    expect(lockHasZod(lockFiles()[1] ?? '', locked ?? ''), '对照：锁定版本在锁里查得到（证明上一条的查法有效）').toBe(true);
    withProbe(`import { z } from 'npm:zod@${outside}';\nexport const name = z.string();\n`, ({ second }) => {
      expect(second.status, text(second)).not.toBe(0);
      expect(text(second).toLowerCase()).toContain('lockfile is out of date');
    });
  }, 240_000);

  it('反例：换成锁里有的版本（deno.json 的 zod）→ 两行都通过；锁文件不变', () => {
    expect(zodSpec()).toMatch(/^npm:zod@\d+\.\d+\.\d+$/);
    withProbe(`import { z } from '${zodSpec()}';\nexport const name = z.string();\n`, ({ second }) => {
      expect(second.status, text(second)).toBe(0);
    });
  }, 240_000);
});
