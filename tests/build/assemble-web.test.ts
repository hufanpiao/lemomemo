// dist/web/_headers 的拼接（B0 集成）：site/_headers（前端 B）+ src/_headers（前端 A），同一个地址不能叠出两条 CSP
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEnvErrors,
  buildVersion,
  checkHeaders,
  MODES,
  parseHeaders,
  renderHeaders,
  WEB_OUT_DEFAULT,
  webOutDir,
  wsOrigin,
} from '../../build/assemble_web.mjs';

const root = join(import.meta.dirname, '..', '..');
const app = readFileSync(join(root, 'src', '_headers'), 'utf8');
const site = readFileSync(join(root, 'site', '_headers'), 'utf8');

describe('renderHeaders', () => {
  it('仓库里的两段拼起来没有问题，各模式的 ws 地址换对了', () => {
    for (const [mode, ws] of [
      ['production', 'wss://lemomemo.com'],
      ['preview', 'wss://preview.lemomemo.com'],
      ['e2e', 'ws://127.0.0.1:8788'],
    ] as const) {
      const text = renderHeaders(app, site, mode);
      expect(text).not.toContain('{{');
      expect(text).toContain(`connect-src 'self' ${ws};`);
    }
  });

  it('e2e-real（真后端 e2e）：connect-src 只加 ws://127.0.0.1:8789（页面和 /sb 同在 8789，http 由 self 覆盖）；e2e 仍是 8788，互不串', () => {
    const real = renderHeaders(app, site, 'e2e-real');
    expect(real).not.toContain('{{');
    expect(real).toContain("connect-src 'self' ws://127.0.0.1:8789;");
    const flat = (t: string) => parseHeaders(t).flatMap((b) => b.lines).join('\n'); // 只看头，不看注释
    expect(flat(real)).not.toContain('8788');
    const e2e = renderHeaders(app, site, 'e2e');
    expect(e2e).toContain("connect-src 'self' ws://127.0.0.1:8788;");
    expect(flat(e2e)).not.toContain('8789');
    // 主 App 和登录页两条 CSP 都换了
    const blocks = parseHeaders(real);
    for (const path of ['/app/*', '/app/auth/*']) {
      const csp = blocks.find((b) => b.path === path)?.lines.find((l) => l.startsWith('Content-Security-Policy:')) ?? '';
      expect(csp, path).toContain("connect-src 'self' ws://127.0.0.1:8789;");
      expect(csp, path).not.toMatch(/https?:\/\/127\.0\.0\.1/);
    }
    expect(MODES).toEqual(expect.arrayContaining(['production', 'preview', 'development', 'test', 'e2e', 'e2e-real']));
  });

  it('每条路径只有一段；首页那几段和 /app/* 不重叠；没有 /* 全站规则', () => {
    const blocks = parseHeaders(renderHeaders(app, site, 'production'));
    const paths = blocks.map((b) => b.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).not.toContain('/*');
    // 首页那几段的路径都命中不了 /app/ 下的地址（否则 CSP 会和 /app/* 的叠在一起）
    for (const p of paths.filter((x) => !x.startsWith('/app'))) expect('/app/index.html'.startsWith(p.replace(/\*$/, '')), p).toBe(false);
  });

  it('/app/ 下面另设 CSP 的段都先去掉 /app/* 那条', () => {
    const blocks = parseHeaders(renderHeaders(app, site, 'production'));
    for (const b of blocks.filter((x) => x.path.startsWith('/app/') && x.path !== '/app/*')) {
      if (b.lines.some((l) => l.startsWith('Content-Security-Policy:'))) expect(b.lines).toContain('! Content-Security-Policy');
    }
  });

  it('拦得住：/* 设 CSP、同一地址两条 CSP、路径写两段', () => {
    const csp = '  Content-Security-Policy: default-src \'self\'';
    expect(checkHeaders(`/*\n${csp}\n`).join()).toContain('/*');
    expect(checkHeaders(`/app/*\n${csp}\n\n/app/x\n${csp}\n`).join()).toContain('叠在一起');
    expect(checkHeaders(`/app/*\n${csp}\n\n/app/x\n  ! Content-Security-Policy\n${csp}\n`)).toEqual([]);
    expect(checkHeaders(`/a\n  X: 1\n\n/a\n  Y: 2\n`).join()).toContain('两段');
    expect(() => renderHeaders(`/app/*\n${csp}\n`, `/*\n${csp}\n`, 'production')).toThrow();
  });

  it('拦得住：官网那段和 /app 那段路径重叠就构建失败（0.31 第 7 条）', () => {
    const appPart = '/app/*\n  X-Content-Type-Options: nosniff\n';
    expect(() => renderHeaders(appPart, '/app/*\n  Cache-Control: no-cache\n', 'production')).toThrow(/重叠/);
    expect(() => renderHeaders(appPart, '/app/sw.js\n  Cache-Control: no-cache\n', 'production')).toThrow(/重叠/);
    expect(() => renderHeaders('/app/\n  Cache-Control: no-cache\n', '/app/*\n  X-Frame-Options: DENY\n', 'production')).toThrow(/重叠/);
    expect(() => renderHeaders(appPart, '/zh/*\n  Cache-Control: no-cache\n', 'production')).not.toThrow();
  });
});

describe('buildEnvErrors', () => {
  it('e2e-real 缺 VITE_PUBLIC_SUPABASE_URL 或 VITE_PUBLIC_ANON_KEY 就失败，提示先跑 e2e:real:up', () => {
    const ok = { VITE_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:8789/sb', VITE_PUBLIC_ANON_KEY: 'fake-anon-e2e' };
    expect(buildEnvErrors('e2e-real', ok)).toEqual([]);
    for (const env of [{}, { VITE_PUBLIC_ANON_KEY: 'k' }, { VITE_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:8789/sb' }, { ...ok, VITE_PUBLIC_ANON_KEY: '  ' }]) {
      const errors = buildEnvErrors('e2e-real', env);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('npm run e2e:real:up');
    }
    expect(buildEnvErrors('e2e-real', {})[0]).toContain('VITE_PUBLIC_SUPABASE_URL、VITE_PUBLIC_ANON_KEY');
  });

  it('其他模式不查（e2e 照旧不带 supabaseUrl 也能构建；production 没给时由 vite.config.ts 报）', () => {
    for (const mode of ['e2e', 'preview', 'development', 'test', 'production']) expect(buildEnvErrors(mode, {})).toEqual([]);
    // 非正式模式指向本机是正常用法
    for (const mode of ['e2e', 'preview', 'development', 'test']) expect(buildEnvErrors(mode, { VITE_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:8789/sb' })).toEqual([]);
  });

  it('production：VITE_PUBLIC_SUPABASE_URL 指向本机就失败（防 e2e-real 的变量漏进正式构建）', () => {
    for (const url of ['http://127.0.0.1:8789/sb', 'http://localhost:8789/sb', 'http://LOCALHOST/sb', 'http://[::1]:8789/sb', ' https://127.0.0.1/sb ']) {
      const errors = buildEnvErrors('production', { VITE_PUBLIC_SUPABASE_URL: url, VITE_PUBLIC_ANON_KEY: 'k' });
      expect(errors, url).toHaveLength(1);
      expect(errors[0], url).toContain('指向本机');
      expect(errors[0], url).toContain('e2e-real');
    }
    expect(buildEnvErrors('production', { VITE_PUBLIC_SUPABASE_URL: 'not a url' })[0]).toContain('不是合法网址');
    for (const url of ['https://lemomemo.com/sb', 'https://preview.lemomemo.com/sb', 'https://127.0.0.1.example.com/sb', 'https://localhost.example.com/sb']) {
      expect(buildEnvErrors('production', { VITE_PUBLIC_SUPABASE_URL: url }), url).toEqual([]);
    }
  });
});

describe('buildVersion', () => {
  it('LEMO_BUILD_VERSION 优先，只认 VERSION 或 VERSION-preview.N', () => {
    const base = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    expect(buildVersion(root, {})).toBe(base);
    expect(buildVersion(root, { LEMO_BUILD_VERSION: `${base}-preview.12` })).toBe(`${base}-preview.12`);
    expect(() => buildVersion(root, { LEMO_BUILD_VERSION: '9.9.9' })).toThrow();
    expect(() => buildVersion(root, { LEMO_BUILD_VERSION: `${base}-beta` })).toThrow();
  });
});

// 接手清单 E2E-dist：无后端组写 dist/web、真后端组写 dist/web-real，互不覆盖；LEMO_WEB_OUT 不设时一切照旧
describe('输出目录（webOutDir、LEMO_WEB_OUT）', () => {
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  // vite.sw.config.ts 在加载时就算好 outDir，所以每次先 resetModules 再重新 import
  const loaders = {
    'vite.config.ts': () => import('../../vite.config.ts'),
    'vite.sw.config.ts': () => import('../../vite.sw.config.ts'),
  } as const;
  const loadVite = async (f: keyof typeof loaders, env: Record<string, string>) => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    try {
      const mod = (await loaders[f]()) as { default: unknown };
      const cfg = typeof mod.default === 'function' ? (mod.default as (e: object) => unknown)({ mode: 'preview', command: 'build' }) : mod.default;
      return resolve((cfg as { build: { outDir: string } }).build.outDir);
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it('LEMO_WEB_OUT 不设（或空白）时产物位置不变：dist/web，App 和 SW 都在 dist/web/app', async () => {
    expect(webOutDir(root, {})).toBe(resolve(root, 'dist/web'));
    expect(webOutDir(root, { LEMO_WEB_OUT: '  ' })).toBe(resolve(root, 'dist/web'));
    expect(WEB_OUT_DEFAULT).toBe('dist/web');
    expect(await loadVite('vite.config.ts', { LEMO_WEB_OUT: '' })).toBe(resolve(root, 'dist/web/app'));
    expect(await loadVite('vite.sw.config.ts', { LEMO_WEB_OUT: '' })).toBe(resolve(root, 'dist/web/app'));
  });

  it('LEMO_WEB_OUT=dist/web-real 时 App 和 SW 都写到 dist/web-real/app', async () => {
    expect(webOutDir(root, { LEMO_WEB_OUT: 'dist/web-real' })).toBe(resolve(root, 'dist/web-real'));
    expect(webOutDir(root, { LEMO_WEB_OUT: String.raw`dist\web-real` })).toBe(resolve(root, 'dist/web-real'));
    expect(await loadVite('vite.config.ts', { LEMO_WEB_OUT: 'dist/web-real' })).toBe(resolve(root, 'dist/web-real/app'));
    expect(await loadVite('vite.sw.config.ts', { LEMO_WEB_OUT: 'dist/web-real' })).toBe(resolve(root, 'dist/web-real/app'));
  });

  it('只许 dist/web 或 dist/web-<小写字母数字>：仓库外、dist 本身、别的 dist 子目录一律拒', () => {
    for (const bad of ['dist', 'dist/', '../web', '/tmp/web', 'C:/web', 'dist/web/../..', 'dist/vite-manifest', 'dist/web-', 'dist/web-Real', 'dist/web-real/app', 'web-real']) {
      expect(() => webOutDir(root, { LEMO_WEB_OUT: bad }), bad).toThrow(/LEMO_WEB_OUT/);
    }
  });

  it('production、preview 不许设 LEMO_WEB_OUT（发布和 CI 只认 dist/web）；本机模式可以', () => {
    for (const mode of ['production', 'preview']) {
      expect(buildEnvErrors(mode, { LEMO_WEB_OUT: 'dist/web-real' })[0], mode).toContain('LEMO_WEB_OUT');
      expect(buildEnvErrors(mode, { LEMO_WEB_OUT: 'dist/web' }), mode).toEqual([]);
    }
    for (const mode of ['e2e', 'development', 'test']) expect(buildEnvErrors(mode, { LEMO_WEB_OUT: 'dist/web-real' }), mode).toEqual([]);
  });

  it('四处都走 webOutDir，不再写死 dist/web/app；真后端组构建到 dist/web-real 并从那里起；.gitignore 覆盖新目录', () => {
    for (const f of ['vite.config.ts', 'vite.sw.config.ts', 'build/build_web.mjs']) {
      const code = read(f).replace(/^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/['"]dist\/web(\/app)?['"]/);
      expect(code, f).toContain('webOutDir');
    }
    const asm = read('build/assemble_web.mjs').replace(/^\s*\/\/.*$/gm, '');
    expect(asm).not.toMatch(/resolve\(root, 'dist\/web'\)/);
    const real = read('playwright.real.config.ts');
    expect(real).toContain("const WEB_OUT = 'dist/web-real';");
    expect(real).toContain('wrangler pages dev ${WEB_OUT} ');
    expect(real).toMatch(/LEMO_WEB_OUT: WEB_OUT,/);
    expect(real).toMatch(/LEMO_WS_PORT: String\(PORT\),/);
    expect(real).not.toMatch(/pages dev dist\/web /);
    // 无后端组照旧
    expect(read('playwright.config.ts')).toMatch(/pages dev dist\/web /);
    const ignore = read('.gitignore').split(/\r?\n/);
    expect(ignore).toEqual(expect.arrayContaining(['dist/web/', 'dist/web-*/']));
  });
});

describe('connect-src 的 ws 端口（wsOrigin、LEMO_WS_PORT）', () => {
  it('不设时和原来一样：e2e、development、test 8788，e2e-real 8789', () => {
    expect(wsOrigin('e2e', {})).toBe('ws://127.0.0.1:8788');
    expect(wsOrigin('development', {})).toBe('ws://127.0.0.1:8788');
    expect(wsOrigin('test', {})).toBe('ws://127.0.0.1:8788');
    expect(wsOrigin('e2e-real', {})).toBe('ws://127.0.0.1:8789');
  });

  it('本机模式跟着 LEMO_WS_PORT 走（如无后端组跑在 8790）', () => {
    const text = renderHeaders(app, site, 'e2e', { LEMO_WS_PORT: '8790' });
    expect(text).toContain("connect-src 'self' ws://127.0.0.1:8790;");
    expect(parseHeaders(text).flatMap((b) => b.lines).join('\n')).not.toContain('8788');
    expect(wsOrigin('e2e-real', { LEMO_WS_PORT: '8791' })).toBe('ws://127.0.0.1:8791');
  });

  it('正式、预览写死，LEMO_WS_PORT 不起作用（正式 CSP 原本就有 wss://lemomemo.com，保持原样）', () => {
    for (const [mode, ws] of [
      ['production', 'wss://lemomemo.com'],
      ['preview', 'wss://preview.lemomemo.com'],
    ] as const) {
      expect(wsOrigin(mode, { LEMO_WS_PORT: '8790' })).toBe(ws);
      const text = renderHeaders(app, site, mode, { LEMO_WS_PORT: '8790' });
      expect(text).toContain(`connect-src 'self' ${ws};`);
      expect(text).not.toContain('8790');
    }
  });

  it('LEMO_WS_PORT 不是 1024–65535 的整数就抛错；未知模式也抛错', () => {
    for (const bad of ['abc', '80', '0', '65536', '8790x', '-1', '8790.5']) {
      expect(() => wsOrigin('e2e', { LEMO_WS_PORT: bad }), bad).toThrow(/LEMO_WS_PORT/);
    }
    expect(() => wsOrigin('nope', {})).toThrow(/未知的构建模式/);
  });
});
