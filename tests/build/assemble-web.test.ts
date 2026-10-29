// dist/web/_headers 的拼接（B0 集成）：site/_headers（前端 B）+ src/_headers（前端 A），同一个地址不能叠出两条 CSP
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEnvErrors, buildVersion, checkHeaders, MODES, parseHeaders, renderHeaders } from '../../build/assemble_web.mjs';

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
