// ci.yml 的 e2e 作业跑在 Playwright 官方镜像里（11-06：runner 上 apt 装浏览器依赖反复卡住、被取消，改用镜像）。
// 镜像里 /ms-playwright 的浏览器版本跟镜像 tag 走，tag 和 package-lock 里的 @playwright/test 对不上，playwright 就找不到浏览器；
// 这里核对：tag 写死且等于 lock 版本、钉了 digest、作业里不再 apt 装浏览器、Node 仍由 setup-node 按 NODE_VERSION 装。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };

/** e2e 作业那一段：从 `  e2e:` 到下一个两格缩进的作业名或文件尾 */
function e2eJob(): string {
  const start = ci.search(/^ {2}e2e:\s*$/m);
  expect(start, 'ci.yml 里找不到 e2e 作业').toBeGreaterThanOrEqual(0);
  const rest = ci.slice(start + 1);
  const next = rest.search(/^ {2}[a-z0-9-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('e2e 作业的 Playwright 容器镜像', () => {
  const job = e2eJob();
  const m = /^\s+image:\s*mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:([0-9a-f]{64})\s*$/m.exec(job);

  it('用官方镜像，tag 写死为 v<版本>-noble 并钉 digest', () => {
    expect(m, 'e2e 作业的 container.image 不是 mcr.microsoft.com/playwright:v<版本>-noble@sha256:<digest>').not.toBeNull();
  });

  it('镜像 tag 的版本和 package-lock 里的 @playwright/test、playwright-core 一致', () => {
    const want = lock.packages['node_modules/@playwright/test']?.version;
    expect(want).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m?.[1]).toBe(want);
    expect(lock.packages['node_modules/playwright-core']?.version).toBe(want);
  });

  it('不再 apt 装浏览器和系统依赖（只看非注释行）', () => {
    const code = job
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/playwright(?:-core)?\s+install/);
    expect(code).not.toMatch(/apt-get|install-deps|--with-deps/);
  });

  it('带 --ipc=host；Node 仍由 setup-node 按 NODE_VERSION 装，并核对版本', () => {
    expect(job).toMatch(/^\s+options:\s*--ipc=host\s*$/m);
    expect(job).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(job).toContain('node-version: ${{ env.NODE_VERSION }}');
    expect(job).toContain('grep -q "^v${NODE_VERSION}\\."');
  });

  it('跑 e2e 和计数的步骤照常用 shell: bash 加 tee', () => {
    expect(job).toMatch(/shell: bash\n\s+run: \|\n\s+npm run e2e 2>&1 \| tee e2e\.log/);
    expect(job).toMatch(/汇总：本轮关模糊的用例数\n\s+if: always\(\)\n\s+shell: bash/);
  });
});
