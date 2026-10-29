// B1 接手清单 K-dbtypes 方案 ①（架构 2.5）：shared/db.types.ts 由 CI 的 db 任务生成和比对。
// 核对 ci.yml：装的是 tools/ci-tools.lock 锁定的 supabase CLI；先 db reset 再 gen types --local；
// 对不上就失败，并在失败时把生成结果作为产物 db-types-generated 上传，开发者下载覆盖后提交。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

/** 取 db 任务的各个步骤（按“      - ”切，每段是一步的原文） */
function dbSteps(): string[] {
  const start = ci.indexOf('\n  db:\n');
  expect(start, 'ci.yml 里要有 db 任务').toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.slice(5).search(/\n {2}[a-z][\w-]*:\n/);
  const job = next === -1 ? rest : rest.slice(0, next + 5);
  return job.split(/\n(?= {6}- )/).slice(1);
}

const steps = dbSteps();
const idx = (pred: (s: string) => boolean, what: string): number => {
  const i = steps.findIndex(pred);
  expect(i, `db 任务里找不到：${what}`).toBeGreaterThan(-1);
  return i;
};

describe('K-dbtypes：CI 生成并比对 shared/db.types.ts', () => {
  const install = idx((s) => /build\/ci\/install-tool\.sh supabase\b/.test(s), '按 ci-tools.lock 安装 supabase CLI');
  const reset = idx((s) => /run: supabase db reset\s*$/m.test(s), '从头建库 supabase db reset');
  const gen = idx((s) => s.includes('supabase gen types typescript --local'), '生成 db.types.ts');
  const upload = idx((s) => s.includes('name: db-types-generated'), '上传 db-types-generated 产物');

  it('CLI 版本锁在 tools/ci-tools.lock（和预览部署、publish.ps1 同一份）', () => {
    const lock = readFileSync(join(root, 'tools', 'ci-tools.lock'), 'utf8');
    expect(lock).toMatch(/^supabase\s+\d+\.\d+\.\d+\s+linux_amd64\s/m);
    expect(steps[gen]).not.toMatch(/npx\s+supabase/);
  });

  it('顺序：装 CLI → db reset → 生成比对 → 失败时上传', () => {
    expect(install).toBeLessThan(reset);
    expect(reset).toBeLessThan(gen);
    expect(gen).toBeLessThan(upload);
  });

  it('生成到临时目录、和仓库里的 diff，对不上就 exit 1', () => {
    const s = steps[gen] ?? '';
    expect(s).toMatch(/supabase gen types typescript --local > "\$RUNNER_TEMP\/db-types\/db\.types\.ts"/);
    expect(s).toMatch(/if ! diff -u shared\/db\.types\.ts "\$RUNNER_TEMP\/db-types\/db\.types\.ts"; then/);
    expect(s).toMatch(/::error::[^\n]*db-types-generated/);
    expect(s).toMatch(/exit 1/);
    // 生成结果不准直接写回仓库文件（那样比对永远相等）
    expect(s).not.toMatch(/>\s*shared\/db\.types\.ts/);
  });

  it('上传只在失败时、只传生成的那一个文件、钉了提交哈希', () => {
    const s = steps[upload] ?? '';
    expect(s).toMatch(/^\s+if: failure\(\)$/m);
    expect(s).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(s).toMatch(/^\s+path: \$\{\{ runner\.temp \}\}\/db-types\/db\.types\.ts$/m);
    expect(s).toMatch(/if-no-files-found: ignore/);
    // 上传紧跟在比对之后，中间不插别的步骤（别的步骤失败时不会误传旧文件，也一眼能看出对应关系）
    expect(upload).toBe(gen + 1);
  });
});

// ci 第 61 次运行（36f359c）：config.toml 开了 edge_runtime，supabase start 要读函数 import 的 _shared/gen/ 文件，
// gen/ 不进仓库，没先生成就报 failed to read file …/_shared/gen/schema/account.ts。生成要在 start、deno check、依赖锁之前
describe('db 任务在 supabase start 之前生成 _shared/gen/', () => {
  const runs = (s: string, cmd: RegExp): boolean => s.split('\n').some((l) => cmd.test(l.replace(/^\s+(- )?(run: )?/, '').replace(/\s+#.*$/, '')));
  const npmCi = idx((s) => runs(s, /^npm ci\b/), 'npm ci');
  const copy = idx((s) => runs(s, /^(npm run copy:shared|node build\/copy_shared\.mjs)$/), '生成 _shared/gen/（npm run copy:shared）');
  const start = idx((s) => runs(s, /^supabase start\b/), '启动本地 Supabase');
  const check = idx((s) => runs(s, /^deno task check$/), 'deno task check');
  const lock = idx((s) => runs(s, /^deno install --frozen --no-check --entrypoint\b/), '服务器函数的依赖锁');

  it('顺序：npm ci → copy:shared → supabase start → deno task check → 依赖锁', () => {
    expect(npmCi).toBeLessThan(copy);
    expect(copy).toBeLessThan(start);
    expect(start).toBeLessThan(check);
    expect(check).toBeLessThan(lock);
  });

  it('生成那一步单独成步、不带 continue-on-error 或 if（失败就让任务红）', () => {
    expect(steps[copy]).not.toMatch(/^\s+(continue-on-error|if):/m);
  });
});

// 镜像缓存只为提速（避开 ECR Public 限流），载入、存 tar 出错都不许让 db 任务变红；tar 几 GB，无论成败都要删
describe('Supabase 镜像缓存不决定 db 任务成败', () => {
  const load = idx((s) => /docker load -i/.test(s), '载入缓存镜像 docker load');
  const save = idx((s) => /docker save -o/.test(s), '存镜像 tar docker save');
  const cleanup = idx((s) => /rm -f "\$\{\{ runner\.temp \}\}\/supabase-images\.tar"/.test(s), '删镜像 tar');

  it('载入和存 tar 两步都带 continue-on-error', () => {
    expect(steps[load]).toMatch(/^\s+continue-on-error: true$/m);
    expect(steps[save]).toMatch(/^\s+continue-on-error: true$/m);
  });

  it('上传缓存只在存 tar 成功时；删 tar 用 always()', () => {
    const upload = idx((s) => /actions\/cache\/save@[0-9a-f]{40}\b/.test(s), '上传镜像缓存');
    expect(steps[upload]).toMatch(/steps\.sb-save\.outcome == 'success'/);
    expect(steps[cleanup]).toMatch(/^\s+if: always\(\)$/m);
  });
});
