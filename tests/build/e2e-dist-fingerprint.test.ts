// 无后端组 e2e 的产物指纹（tests/e2e/dist-fingerprint.ts，E2E-guard-sugg2 ③④，10-30）：
// • 复用 8788 上的服务时，服务上的 /app/ 首页要和本机 <产物目录>/app/index.html 逐字一样；不一样、取不到、本机没有都报
// • 产物目录和 build_web 同一条规则（LEMO_WEB_OUT）：playwright.config.ts 的 wrangler 和 no-backend-premise.spec.ts 都跟着它
// fetch 换成假的，不起服务、不起子进程
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import { checkDistFingerprint, fingerprintProblem } from '../e2e/dist-fingerprint.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const HTML = '<!doctype html><script type="module" src="/app/assets/index-AbC123.js"></script>';
const where = { url: 'http://127.0.0.1:8788/app/', file: 'dist/web/app/index.html' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function outDir(html: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'b10qa-fp-'));
  dirs.push(d);
  if (html !== null) {
    mkdirSync(join(d, 'app'), { recursive: true });
    writeFileSync(join(d, 'app', 'index.html'), html);
  }
  return d;
}

const fakeFetch = (status: number, body: string): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

describe('产物指纹（纯函数）', () => {
  it('一样返回 null；本机没有、服务上取不到、两边不一样各报一种', () => {
    expect(fingerprintProblem(HTML, HTML, where)).toBeNull();
    expect(fingerprintProblem(HTML, null, where)).toContain('本机没有 dist/web/app/index.html');
    expect(fingerprintProblem(null, HTML, where)).toContain('取不到 http://127.0.0.1:8788/app/');
    expect(fingerprintProblem(HTML.replace('AbC123', 'XyZ789'), HTML, where)).toContain('复用的服务跑的不是这份产物');
  });
});

describe('checkDistFingerprint（假 fetch + 临时产物目录）', () => {
  it('服务上的首页和本机 index.html 一样：通过；取的是 baseURL 下的 /app/', async () => {
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(HTML, { status: 200 });
    }) as typeof fetch;
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(HTML), f)).toBeNull();
    expect(urls).toEqual(['http://127.0.0.1:8790/app/']);
  });

  it('本机 index.html 开头带 BOM（r.text() 解码时会去掉）也算一致；去掉 BOM 后内容不同照样报', async () => {
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(`\uFEFF${HTML}`), fakeFetch(200, HTML))).toBeNull();
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(`\uFEFF${HTML}`), fakeFetch(200, `\uFEFF${HTML}`))).toBeNull();
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(`\uFEFF${HTML}x`), fakeFetch(200, HTML))).toContain('不是这份产物');
  });

  it('换了一份构建（哈希文件名不同）、服务回 404、连不上、本机没构建：都报', async () => {
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(HTML), fakeFetch(200, HTML.replace('AbC123', 'old999')))).toContain('不是这份产物');
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(HTML), fakeFetch(404, 'nope'))).toContain('取不到');
    const refused = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(HTML), refused)).toContain('取不到');
    expect(await checkDistFingerprint('http://127.0.0.1:8790', outDir(null), fakeFetch(200, HTML))).toContain('本机没有');
  });
});

describe('playwright.config.ts：产物目录跟 LEMO_WEB_OUT 走，globalSetup 挂着指纹核对', () => {
  async function load(env: Record<string, string>): Promise<PlaywrightTestConfig> {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return (await import(/* @vite-ignore */ `${'../../playwright.config.ts'}`) as { default: PlaywrightTestConfig }).default;
  }
  const wrangler = (c: PlaywrightTestConfig) => (Array.isArray(c.webServer) ? c.webServer[1]?.command : '') ?? '';

  it('LEMO_WEB_OUT 没设：wrangler 起 dist/web；设成 dist/web-x：wrangler 起 dist/web-x；写法不对加载时就抛错', async () => {
    const def = await load({ LEMO_WEB_OUT: '' });
    expect(def.globalSetup).toBe('./tests/e2e/dist-fingerprint.ts');
    expect(wrangler(def)).toContain('npx wrangler pages dev dist/web --ip');
    expect(wrangler(await load({ LEMO_WEB_OUT: 'dist/web-x' }))).toContain('npx wrangler pages dev dist/web-x --ip');
    await expect(load({ LEMO_WEB_OUT: '../elsewhere' })).rejects.toThrow('LEMO_WEB_OUT');
  });

  it('no-backend-premise.spec.ts 用同一条规则（webOutDir），不再写死 dist/web', () => {
    const spec = readFileSync(join(ROOT, 'tests/e2e/no-backend-premise.spec.ts'), 'utf8');
    expect(spec).toContain("const ASSETS_DIR = join(webOutDir(ROOT, process.env), 'app', 'assets');");
    expect(spec).not.toMatch(/dist\/web\/app\/assets'/);
  });
});
