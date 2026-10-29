// SW 预缓存清单（架构 16.1）：注入脚本的排除规则和 src/sw/routes.ts 一致；清单内容正确
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildManifest, excluded, injectSwManifest } from '../../build/inject_sw_manifest.mjs';
import { excludedFromPrecache } from '../../src/sw/routes.ts';

const SAMPLES = [
  'sw.js',
  'index.html',
  'preview.html',
  'version.json',
  'manifest.webmanifest',
  'assets/index-AbC12_9x.js',
  'assets/index-AbC12_9x.js.map',
  'assets/index-AbC12_9x.css',
  'holidays/kr/2026.json',
  'fonts/lemo-sub.woff2',
  'icons/startup/startup-1170x2532.png',
  'diag/startup.html',
  'diag/startup.js',
  'diag/startup.css',
  'diag/tilt.html',
  'diag/tilt.js',
  'diag/tilt.css',
  'icons/icon-192.png',
  '.vite/manifest.json',
];

describe('inject_sw_manifest', () => {
  it('排除规则和 src/sw/routes.ts 一致', () => {
    for (const p of SAMPLES) expect(excluded(p), p).toBe(excludedFromPrecache(p));
  });

  const dir = mkdtempSync(join(tmpdir(), 'lemo-sw-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('buildManifest：带哈希的文件 revision 为 null，其余带内容摘要；排除的文件不在里面', () => {
    for (const p of SAMPLES) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), p);
    }
    const m = buildManifest(dir) as { url: string; revision: string | null }[];
    const urls = m.map((e) => e.url).sort();
    expect(urls).toEqual(SAMPLES.filter((p) => !excludedFromPrecache(p)).map((p) => `/app/${p}`).sort());
    expect(m.find((e) => e.url === '/app/assets/index-AbC12_9x.js')?.revision).toBeNull();
    expect(m.find((e) => e.url === '/app/index.html')?.revision).toMatch(/^[0-9a-f]{8,}$/);
  });

  it('机型信息页、倾斜授权试验页（diag/）和 iOS 启动图 icons/startup/ 不进预缓存清单（架构 8.1、0.38 第 63 条）', () => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-sw-'));
    try {
      for (const p of ['index.html', 'icons/icon-192.png', 'icons/startup/startup-1170x2532.png', 'diag/startup.html', 'diag/startup.js', 'diag/startup.css', 'diag/tilt.html', 'diag/tilt.js', 'diag/tilt.css']) {
        mkdirSync(join(d, p, '..'), { recursive: true });
        writeFileSync(join(d, p), p);
      }
      const urls = (buildManifest(d) as { url: string }[]).map((e) => e.url).sort();
      expect(urls).toEqual(['/app/icons/icon-192.png', '/app/index.html']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('sw.ts 导航路由的 denylist 用的就是 routes.ts 的 NAV_DENYLIST（含 diag/，不在 sw.ts 里另写一份）', () => {
    const sw = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'sw', 'sw.ts'), 'utf8');
    expect(sw).toMatch(/import \{[^}]*\bNAV_DENYLIST\b[^}]*\} from '\.\/routes\.ts'/);
    expect(sw).toMatch(/denylist:\s*\[\.\.\.NAV_DENYLIST\]/);
    expect(sw).not.toMatch(/denylist:\s*\[\s*\//);
  });

  it('injectSwManifest：sw.js 里找不到 self.__WB_MANIFEST（或不止一处）就失败，不悄悄产出没有预缓存的 sw.js（0.31 第 5 条）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-sw-'));
    try {
      writeFileSync(join(d, 'index.html'), 'x');
      writeFileSync(join(d, 'sw.js'), 'precacheAndRoute([]);');
      await expect(injectSwManifest(d)).rejects.toThrow(/__WB_MANIFEST/);
      writeFileSync(join(d, 'sw.js'), 'a(self.__WB_MANIFEST);b(self.__WB_MANIFEST);');
      await expect(injectSwManifest(d)).rejects.toThrow(/__WB_MANIFEST/);
      writeFileSync(join(d, 'sw.js'), 'precacheAndRoute(self.__WB_MANIFEST);');
      await expect(injectSwManifest(d)).resolves.toBe(1);
      expect(readFileSync(join(d, 'sw.js'), 'utf8')).toContain('"url":"/app/index.html"');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
