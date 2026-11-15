// 四份 Playwright 配置（playwright.config.ts、.fastread、.real、.visual）共用的骨架（第三方审查 CI-13 前半）：每份只写自己的差异
// • webServer：先构建、再 wrangler pages dev <产物目录>（带 _headers 的 CSP 和 Pages Functions），binding 由各组给；有假后端的组先起假后端
//   （tests/e2e/fake-backends.ts，顺序固定 [假后端, wrangler]，tests/build/e2e-ports.test.ts 按这个顺序读）
// • CI（CI=true）：forbidOnly、retries 1、list + html 报告 + flaky 汇总（tests/e2e/flaky-summary.ts 写进 GitHub Step Summary）；本机只 list、不重试
// • globalTimeout 读 E2E_GLOBAL_TIMEOUT_MS（tests/e2e/global-timeout.ts），默认值各组给
// • 快读组的用例名单 FASTREAD_ONLY_SPECS 也在这里：快读组 testMatch、默认组 testIgnore 用同一份（第三方审查 CI-5）
import { join, relative } from 'node:path';
import { devices, type PlaywrightTestConfig, type ReporterDescription } from '@playwright/test';
import { webOutDir } from '../../build/assemble_web.mjs';
import { FAKE_PORT_ENV, e2eBindings, type FakePorts } from './fake-values.ts';
import { globalTimeoutMs, NO_BACKEND_GLOBAL_TIMEOUT_MS } from './global-timeout.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * 只在快读组（playwright.fastread.config.ts，带同源 /sb 地址的构建）跑的用例：要会话令牌、/sb 地址或同步引擎，默认组的构建没配地址跑不了。
 * 默认组 testIgnore 这一份；b2-first-screen-supabase.spec.ts 两组都跑（两种构建各验一条分支），不在名单里，快读组另外加上
 */
export const FASTREAD_ONLY_SPECS: readonly string[] = [
  '**/r402-webp-wasm.spec.ts',
  '**/r384-me-avatar.spec.ts',
  '**/b5-vault.spec.ts',
  '**/b4b1-attachments.spec.ts',
  '**/b4b2-find.spec.ts',
  '**/b4b2-image-ai.spec.ts',
  '**/b4b3-assist.spec.ts',
  '**/todo-autodel-pull.spec.ts',
];

/** chromium（桌面）+ webkit（iPhone 15）：默认组、快读组的两个项目 */
export const DESKTOP_AND_PHONE: NonNullable<PlaywrightTestConfig['projects']> = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'webkit', use: { ...devices['iPhone 15'] } },
];

/** 产物目录（相对仓库根，正斜杠）：和 build_web 同一条规则（build/assemble_web.mjs 的 webOutDir，读 LEMO_WEB_OUT），默认 dist/web */
export const webOut = (): string => relative(ROOT, webOutDir(ROOT, process.env)).replaceAll('\\', '/');

export interface E2eGroup {
  /** wrangler pages dev 的端口（baseURL 跟着走） */
  port: number;
  /** 产物目录；不传按 webOut()（LEMO_WEB_OUT，默认 dist/web） */
  out?: string;
  /** wrangler 本地状态目录（--persist-to） */
  state: string;
  /** wrangler 调试端口（--inspector-port） */
  inspector: number;
  /** 假后端端口：给了就先起 tests/e2e/fake-backends.ts；null 不起 */
  fake: FakePorts | null;
  /** wrangler 的 --binding；不传就是 e2eBindings(fake) */
  bindings?: Record<string, string>;
  /** reuseExistingServer */
  reuse: boolean;
  /** 构建命令，默认 npm run build -- --mode e2e */
  build?: string;
  /** 构建和 wrangler 子进程额外的环境变量 */
  env?: Record<string, string>;
  /** CI 上 html 报告的目录，默认 playwright-report */
  report?: string;
  /** globalTimeout 的默认值（E2E_GLOBAL_TIMEOUT_MS 可改），默认无后端组的 20 分钟 */
  timeoutMs?: number;
  /** 挂产物指纹核对（tests/e2e/dist-fingerprint.ts，只读本进程的 LEMO_WEB_OUT），默认挂；真后端组的产物目录只传给子进程，不挂 */
  fingerprint?: boolean;
}

const flags = (b: Record<string, string>): string =>
  Object.entries(b)
    .map(([k, v]) => `--binding ${k}=${v}`)
    .join(' ');

/** 一组 e2e 的公共配置；各配置再按需覆盖 testMatch、projects、outputDir 等 */
export function e2eConfig(g: E2eGroup): PlaywrightTestConfig {
  const ci = process.env.CI === 'true';
  const out = g.out ?? webOut();
  const bindings = g.bindings ?? (g.fake ? e2eBindings(g.fake) : {});
  const reporter: ReporterDescription[] = [['list'], ['html', { open: 'never', outputFolder: g.report ?? 'playwright-report' }], ['./tests/e2e/flaky-summary.ts']];
  const wrangler = {
    command: `${g.build ?? 'npm run build -- --mode e2e'} && npx wrangler pages dev ${out} --ip 127.0.0.1 --port ${g.port} --compatibility-date 2026-10-01 --persist-to ${g.state} --inspector-port ${g.inspector} ${flags(bindings)}`,
    url: `http://127.0.0.1:${g.port}/app/`,
    reuseExistingServer: g.reuse,
    timeout: 180_000,
    env: { WRANGLER_SEND_METRICS: 'false', CI: process.env.CI ?? '', ...g.env },
  };
  const fake = g.fake && {
    command: 'node tests/e2e/fake-backends.ts',
    url: `http://127.0.0.1:${g.fake.supabase}/health`,
    reuseExistingServer: g.reuse,
    timeout: 30_000,
    env: { [FAKE_PORT_ENV.s3]: String(g.fake.s3), [FAKE_PORT_ENV.supabase]: String(g.fake.supabase) },
  };
  return {
    testDir: 'tests/e2e',
    fullyParallel: true,
    globalTimeout: globalTimeoutMs(process.env, g.timeoutMs ?? NO_BACKEND_GLOBAL_TIMEOUT_MS),
    ...(g.fingerprint === false ? {} : { globalSetup: './tests/e2e/dist-fingerprint.ts' }),
    forbidOnly: ci,
    retries: ci ? 1 : 0,
    reporter: ci ? reporter : 'list',
    use: { baseURL: `http://127.0.0.1:${g.port}`, trace: 'retain-on-failure' },
    webServer: fake ? [fake, wrangler] : [wrangler],
  };
}
