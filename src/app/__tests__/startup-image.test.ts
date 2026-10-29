// B1 T4（R-72 定稿版式、R-232）：iOS 启动图 12 张，只出竖屏。src/index.html 里每条 apple-touch-startup-image：
// media 写全 device-width、device-height、-webkit-device-pixel-ratio、orientation: portrait，12 条各不相同；
// 文件在 src/public/ 下，PNG 实际像素 = CSS 尺寸 × 倍率；12 条和 build/export_splash.py 的 DEVICES、定稿页表格逐条一致。
// 尺寸是否和真机对得上、深色模式能否单独指定，待真机核对（iPhone 实机验收清单 P1-07）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PUBLIC = join(ROOT, 'src', 'public');
const indexHtml = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
const exportPy = readFileSync(join(ROOT, 'build', 'export_splash.py'), 'utf8');
const specHtml = readFileSync(join(ROOT, 'docs', '02-设计', '图标与命名', '图标与名字-候选.html'), 'utf8');

/** 一行机型：图片宽、高，CSS 宽、高，倍率，机型名 */
type Device = [number, number, number, number, number, string];

/** 文本解析 export_splash.py 的 DEVICES（不运行 Python）：`DEVICES = [` 到下一个行首 `]` 之间，每行一个元组 */
function pyDevices(): Device[] {
  const block = /^DEVICES = \[\r?\n([\s\S]*?)^\]/m.exec(exportPy)?.[1] ?? '';
  return [...block.matchAll(/^\s*\((\d+), (\d+), (\d+), (\d+), (\d), "([^"]+)"\),\r?$/gm)].map((m) => [
    Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), m[6] ?? '',
  ]);
}

/** 定稿页“iOS 启动图”一节的表格（从这一节的标题到它后面第一个 </table>） */
function specDevices(): Device[] {
  const start = specHtml.indexOf('iOS 启动图（apple-touch-startup-image');
  const end = specHtml.indexOf('</table>', start);
  const table = start < 0 || end < 0 ? '' : specHtml.slice(start, end);
  return [
    ...table.matchAll(
      /<tr><td>([^<]+)<\/td><td class="k">(\d+)×(\d+)<\/td><td class="k">(\d+)×(\d+) @(\d)x<\/td><\/tr>/g,
    ),
  ].map((m) => [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), m[1] ?? '']);
}

const LINK = /<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)" \/>/g;
const MEDIA =
  /^\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: portrait\)$/;

/** PNG 的 IHDR 里读宽高 */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1'), file).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const links = [...indexHtml.matchAll(LINK)].map((m) => ({ media: m[1] ?? '', href: m[2] ?? '' }));

describe('iOS 启动图（apple-touch-startup-image）', () => {
  it('index.html 里正好 12 条，media 各不相同', () => {
    expect(indexHtml.split('apple-touch-startup-image').length - 1).toBe(12);
    expect(links).toHaveLength(12);
    expect(new Set(links.map((l) => l.media)).size).toBe(12);
  });

  it('build/export_splash.py 的 DEVICES 和定稿页“iOS 启动图”表格逐行一致（尺寸、倍率、机型名、顺序）', () => {
    const py = pyDevices();
    expect(py, 'DEVICES 解析不出 12 行：export_splash.py 的写法变了，改这里的解析').toHaveLength(12);
    expect(specDevices()).toEqual(py);
  });

  it('index.html 的 12 条 link 和 DEVICES 逐条一致（media、href、顺序）', () => {
    const want = pyDevices().map(([w, h, cw, ch, dpr]) => ({
      media: `(device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`,
      href: `/app/icons/startup/startup-${w}x${h}.png`,
    }));
    expect(links).toEqual(want);
  });

  for (const { media, href } of links) {
    it(`${href}：竖屏、文件存在、像素 = CSS 尺寸 × 倍率`, () => {
      const m = MEDIA.exec(media);
      expect(m, media).not.toBeNull();
      const [cw, ch, dpr] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
      expect(href.startsWith('/app/icons/startup/')).toBe(true);
      const file = join(PUBLIC, href.replace(/^\/app\//, ''));
      expect(existsSync(file), file).toBe(true);
      expect(pngSize(file)).toEqual([cw * dpr, ch * dpr]);
      expect(href).toBe(`/app/icons/startup/startup-${cw * dpr}x${ch * dpr}.png`);
    });
  }
});
