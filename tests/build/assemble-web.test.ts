// dist/web/_headers 的拼接（B0 集成）：site/_headers（前端 B）+ src/_headers（前端 A），同一个地址不能叠出两条 CSP
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildVersion, checkHeaders, parseHeaders, renderHeaders } from '../../build/assemble_web.mjs';

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
