// 无后端组 e2e 的 globalSetup（playwright.config.ts，E2E-guard-sugg2 ④，10-30）：核对 8788 上跑的就是本机这份产物
// 本机默认复用已经在跑的 wrangler（reuseExistingServer），这时 Playwright 不重新构建，也不管 8788 上跑的是哪份产物
// （可能是别的工作副本、别的产物目录起的）。这里取服务上的 /app/ 首页，和本机 <产物目录>/app/index.html 逐字比对：
// index.html 里引的是带内容哈希的 JS、CSS 文件名，两边一样就是同一份产物；不一样、取不到、本机没有都直接失败，不往下跑用例。
// ⚠ 查不出的：服务和本机是同一份 dist，但 dist 比 src 旧（复用时不会重新构建）。改了 src 要先 npm run build -- --mode e2e，
//   或者关掉 8788 上的服务让 Playwright 自己构建、起服务。
//   首页一致也只能证明前端产物一致，证明不了 functions/ 代码或 wrangler 的 binding 一致——比如另一个工作副本构建出同一份 dist，
//   它的 functions/ 改过、或 binding 指着别的假后端端口，这里照样通过
import { existsSync, readFileSync } from 'node:fs';
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
  const problem = await checkDistFingerprint(baseURL, webOutDir(ROOT, process.env));
  if (problem) throw new Error(`e2e 产物指纹不对：${problem}`);
}
