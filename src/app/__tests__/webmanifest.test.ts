// TC-B0-13（架构 16.3 B0 ①、R-66、R-74；QA 第二节“部分”）：manifest 的 start_url、scope 都是 /app/
// （SW 注册的 scope 由 tests/e2e/csp.spec.ts 核；主屏幕实际打开进 /app/ 是真机 P1-01）
// B1 T4：icons 按定稿图标的导出清单（R-72，docs/02-设计/图标与命名/图标与名字-候选.html “交给开发的导出清单”）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(import.meta.dirname, '..', '..', 'public');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
const indexHtml = readFileSync(join(import.meta.dirname, '..', '..', 'index.html'), 'utf8');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
const icons = (manifest['icons'] ?? []) as Icon[];

/** /app/xxx → src/public/xxx */
function publicFile(url: string): string {
  expect(url.startsWith('/app/')).toBe(true);
  return join(PUBLIC, url.slice('/app/'.length));
}

/** 读 PNG 头：宽、高、颜色类型（2 = RGB 不带透明通道） */
function pngInfo(path: string): { width: number; height: number; colorType: number } {
  const buf = readFileSync(path);
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] ?? -1 };
}

describe('manifest.webmanifest', () => {
  it('start_url、scope 都是 /app/；独立窗口打开', () => {
    expect(manifest['start_url']).toBe('/app/');
    expect(manifest['scope']).toBe('/app/');
    expect(manifest['display']).toBe('standalone');
  });

  it('颜色按导出清单：theme_color 柠檬黄、background_color 取启动画面中间那片黄光', () => {
    expect(manifest['theme_color']).toBe('#F2DF4A');
    expect(manifest['background_color']).toBe('#F0E289');
  });

  it('icons 非空，每个文件都在、是方形不透明 PNG、尺寸和 sizes 一致', () => {
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      const path = publicFile(icon.src);
      expect(existsSync(path), icon.src).toBe(true);
      expect(icon.type).toBe('image/png');
      const m = /^(\d+)x(\d+)$/.exec(icon.sizes);
      expect(m, icon.sizes).not.toBeNull();
      const info = pngInfo(path);
      expect([info.width, info.height], icon.src).toEqual([Number(m?.[1]), Number(m?.[2])]);
      expect(info.width).toBe(info.height);
      expect(info.colorType, `${icon.src} 应当不透明（RGB）`).toBe(2);
    }
  });

  it('any 和 maskable 都有 192、512 两个尺寸', () => {
    for (const purpose of ['any', 'maskable']) {
      const sizes = icons.filter((i) => (i.purpose ?? 'any').split(' ').includes(purpose)).map((i) => i.sizes);
      expect(sizes, purpose).toEqual(expect.arrayContaining(['192x192', '512x512']));
    }
  });
});

describe('index.html 的图标链接', () => {
  const links = [...indexHtml.matchAll(/<link\s+rel="(icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)];

  it('apple-touch-icon 是 180×180 不透明 PNG；favicon 有 ico 和 svg', () => {
    const touch = links.find((l) => l[1] === 'apple-touch-icon' && !/sizes=/.test(l[0]));
    expect(touch?.[2]).toBe('/app/icons/apple-touch-icon.png');
    const info = pngInfo(publicFile(touch?.[2] ?? ''));
    expect([info.width, info.height, info.colorType]).toEqual([180, 180, 2]);
    const iconHrefs = links.filter((l) => l[1] === 'icon').map((l) => l[2]);
    expect(iconHrefs).toEqual(expect.arrayContaining(['/app/icons/favicon.ico', '/app/icons/favicon.svg']));
  });

  it('链接的图标文件都在', () => {
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(existsSync(publicFile(l[2] ?? '')), l[2]).toBe(true);
  });
});
