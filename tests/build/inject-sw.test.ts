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
