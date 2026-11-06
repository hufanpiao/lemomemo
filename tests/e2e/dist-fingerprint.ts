// 无后端组 e2e 的 globalSetup（playwright.config.ts，E2E-guard-sugg2 ④，10-30）：核对 8788 上跑的就是本机这份产物
// 本机设了 LEMO_E2E_REUSE=1 时复用已经在跑的 wrangler（reuseExistingServer；11-04 起默认不复用，见 tools/e2e/reuse-servers.mjs），这时 Playwright 不重新构建，也不管 8788 上跑的是哪份产物
// （可能是别的工作副本、别的产物目录起的）。这里取服务上的 /app/ 首页，和本机 <产物目录>/app/index.html 逐字比对：
// index.html 里引的是带内容哈希的 JS、CSS 文件名，两边一样就是同一份产物；不一样、取不到、本机没有都直接失败，不往下跑用例。
// • 产物比源码旧（B2 FA-5 第四轮 Q1，11-04）：服务和本机是同一份 dist、但 dist 比 src 旧时（复用时不会重新构建），指纹比对照样通过。
//   这里再比一次修改时间：src/、shared/ 里（不含 __tests__）有文件比 <产物目录>/app/index.html 新，就警告、列出最新的几个，
//   不中断（改了注释、测试以外的文件也算，宁可多提醒）。看到警告：先 npm run build -- --mode e2e，或关掉复用中的服务让 Playwright 自己构建。
//   Playwright 先起 webServer 再跑 globalSetup：让它自己构建时产物一定比源码新，不会误报
//   首页一致也只能证明前端产物一致，证明不了 functions/ 代码或 wrangler 的 binding 一致——比如另一个工作副本构建出同一份 dist，
//   它的 functions/ 改过、或 binding 指着别的假后端端口，这里照样通过
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { webOutDir } from '../../build/assemble_web.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

/** 比对结果（纯函数）：served 是服务上 /app/ 的正文（取不到是 null），local 是本机 index.html（没有是 null）；一样返回 null，不一样返回问题 */
export function fingerprintProblem(served: string | null, local: string | null, where: { url: string; file: string }): string | null {
  if (local === null) return `本机没有 ${where.file}：先 npm run build -- --mode e2e（或关掉复用中的服务，让 Playwright 自己构建）`;
  if (served === null) return `取不到 ${where.url}：服务没起来，或不是 wrangler pages dev 起的`;
  if (served !== local) {
    return `${where.url} 和本机 ${where.file} 不一样：复用的服务跑的不是这份产物（别的工作副本或旧构建），先关掉那个服务再跑`;
  }
  return null;
}

/** 比 sinceMs 新的源文件（src/、shared/ 下，跳过 __tests__、node_modules），按修改时间从新到旧 */
export function sourcesNewerThan(root: string, sinceMs: number, dirs: readonly string[] = ['src', 'shared']): { file: string; mtimeMs: number }[] {
  const out: { file: string; mtimeMs: number }[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > sinceMs) out.push({ file: relative(root, p).replaceAll('\\', '/'), mtimeMs: m });
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 产物比源码旧时的提示（纯函数）：newer 是比产物新的源文件（从新到旧）；没有就是 null */
export function staleProblem(distMtimeMs: number, newer: readonly { file: string; mtimeMs: number }[], file: string): string | null {
  if (newer.length === 0) return null;
  const at = (ms: number) => new Date(ms).toISOString();
  const top = newer
    .slice(0, 5)
    .map((x) => `${x.file}（${at(x.mtimeMs)}）`)
    .join('、');
  return `${file}（${at(distMtimeMs)}）比 ${newer.length} 个源文件旧，最新的：${top}。用例可能跑的是旧代码：先 npm run build -- --mode e2e，或关掉复用中的服务`;
}

/** 取服务上的 /app/ 和本机 <outDir>/app/index.html 比对；fetchImpl 测试时可换 */
export async function checkDistFingerprint(baseURL: string, outDir: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = new URL('/app/', baseURL).href;
  const file = join(outDir, 'app', 'index.html');
  // 去掉开头的 BOM：r.text() 按 UTF-8 解码时会去掉它，本机读出来的也去掉，两边才对得上
  const local = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : null;
  let served: string | null = null;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) served = await r.text();
  } catch {
    served = null;
  }
  return fingerprintProblem(served, local, { url, file: relative(ROOT, file).replaceAll('\\', '/') });
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('dist-fingerprint：配置里没有 baseURL');
  const outDir = webOutDir(ROOT, process.env);
  const problem = await checkDistFingerprint(baseURL, outDir);
  if (problem) throw new Error(`e2e 产物指纹不对：${problem}`);
  const index = join(outDir, 'app', 'index.html');
  const distMs = statSync(index).mtimeMs;
  const stale = staleProblem(distMs, sourcesNewerThan(ROOT, distMs), relative(ROOT, index).replaceAll('\\', '/'));
  if (stale) console.warn(`⚠ e2e 产物可能是旧的：${stale}`);
  else console.log(`e2e 产物：${relative(ROOT, index).replaceAll('\\', '/')} 构建于 ${new Date(distMs).toISOString()}，不比 src/、shared/ 旧`);
}
