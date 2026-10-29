// 启动画面子集字库（R-253；接手清单 SPLASH-font-sugg ②⑤）：
// ② build/make_splash_font.py 按 sha256 核对两份源字体（本机字体换了版本就停下，不悄悄生成另一份）；
// ⑤ 生成的 woff2 里没有竖排度量表 vhea、vmtx（启动画面没有竖排），横排要用的表都在；
// 顺带：文件确实是 WOFF2（文件头 wOF2），10-30 前脚本没在字体对象上设 flavor，存出来的是扩展名 .woff2 的 TTF。
// woff2 的表目录不压缩，直接按 WOFF2 规范（W3C，5.2 节）读出表名，不用解压字形数据
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const FONTS = join(ROOT, 'src', 'styles', 'fonts', 'splash');
const script = readFileSync(join(ROOT, 'build', 'make_splash_font.py'), 'utf8');

/** WOFF2 规范 Table 1 的已知表名（flags 的低 6 位是下标，63 表示后面跟 4 字节表名） */
const KNOWN = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** woff2 的表名列表 */
function woff2Tables(buf: Buffer): string[] {
  expect(buf.subarray(0, 4).toString('latin1')).toBe('wOF2');
  const numTables = buf.readUInt16BE(12);
  let at = 48;
  const base128 = (): number => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[at++] ?? 0;
      v = v * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error('UIntBase128 太长');
  };
  const tags: string[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at++] ?? 0;
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 63) {
      tag = buf.subarray(at, at + 4).toString('latin1');
      at += 4;
    } else {
      tag = KNOWN[idx] ?? `#${idx}`;
    }
    base128();   // origLength
    const version = flags >> 6;
    // glyf、loca 的版本 0 是“做了变换”，别的表版本非 0 才是；做了变换的后面多一个 transformLength
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    if (transformed) base128();
    tags.push(tag);
  }
  return tags;
}

describe.each([400, 800])('启动画面子集字库 %i', (weight) => {
  const tags = woff2Tables(readFileSync(join(FONTS, `noto-sans-sc-splash-${weight}.woff2`)));

  it('没有竖排度量表 vhea、vmtx（SPLASH-font-sugg ⑤）', () => {
    expect(tags).not.toContain('vhea');
    expect(tags).not.toContain('vmtx');
  });

  it('横排要用的表都在（字形、步进、字符映射、名称表里的版权和许可证）', () => {
    for (const t of ['cmap', 'glyf', 'loca', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'GSUB', 'GPOS']) expect(tags, t).toContain(t);
    // 400 保留可变字体的变化表（make_splash_font.py 文件头：固定成静态字会和启动图差 1372 个像素）
    if (weight === 400) for (const t of ['fvar', 'gvar', 'HVAR']) expect(tags, t).toContain(t);
  });
});

describe('make_splash_font.py 的源字体核对（SPLASH-font-sugg ②）', () => {
  it('FACES 两个字重都记着源文件的 sha256，load_source 不一致就停下', () => {
    const faces = /FACES = \[([\s\S]*?)\n\]/.exec(script)?.[1] ?? '';
    const digests = [...faces.matchAll(/\((\d{3}), [^\n]*?, (?:True|False), "([0-9a-f]+)"\)/g)].map((m) => [m[1], m[2]]);
    expect(digests.map((d) => d[0])).toEqual(['400', '800']);
    for (const [, d] of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(script).toMatch(/got = sha256_file\(path\)\n\s+if got != digest:\n\s+sys\.exit\(/);
  });

  it('存成真正的 WOFF2：在字体对象上设 flavor，存完核对文件头 wOF2（10-30 前存出来的是扩展名 .woff2 的 TTF）', () => {
    expect(script).toMatch(/font\.flavor = "woff2"\n\s+font\.save\(/);
    expect(script).toMatch(/if dest\.read_bytes\(\)\[:4\] != b"wOF2":/);
  });

  it('子集时去掉 vhea、vmtx，生成后再查一遍', () => {
    expect(script).toMatch(/DROP_TABLES = \("vhea", "vmtx"\)/);
    expect(script).toMatch(/opts\.drop_tables = list\(opts\.drop_tables\) \+ \[t for t in DROP_TABLES/);
    expect(script).toMatch(/left = \[t for t in DROP_TABLES if t in TTFont\(str\(dest\)\)\]/);
  });
});
