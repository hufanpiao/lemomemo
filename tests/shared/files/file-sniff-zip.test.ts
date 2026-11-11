// shared/logic/files/file-sniff.ts 的 ZIP 部分：结束记录、中央目录逐条读取、读 [Content_Types].xml 那一个条目（TC-B4b1-09 压缩包异常）
import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES_MAX_BYTES, sniffFile, type InflateRaw } from '../../../shared/logic/files/file-sniff.ts';
import { bad, buildZip, concat, CT, ctXml, docx, enc, MAIN, noInflate, ok, put16, put32, sniff, type ZipEntry } from './fixtures.ts';

const count = (z: { central: number[] }) => z.central.filter((c) => c >= 0).length;
/** 一个 extra 块：2 字节 ID、2 字节长度、数据 */
const extraBlock = (id: number, len: number): Uint8Array => {
  const b = new Uint8Array(4 + len).fill(0x5a);
  put16(b, 0, id);
  put16(b, 2, len);
  return b;
};
/** Info-ZIP 的写法：本地头带 UT（mtime、atime）和 ux（uid、gid）共 28 字节，目录头只带 UT 的 mtime 共 9 字节，两边长度不同 */
const LOCAL_EXTRA = concat(extraBlock(0x5455, 9), extraBlock(0x7875, 11));
const CENTRAL_EXTRA = extraBlock(0x5455, 5);

describe('ZIP 结束记录和中央目录', () => {
  it('结束记录带注释、正好到文件尾 → 照常', async () => {
    const z = buildZip([{ name: CT, body: enc(ctXml(MAIN.docx)) }], { comment: enc('made by test') });
    expect(await sniff(z.bytes)).toEqual(ok('docx'));
  });
  it('结束记录后多 1 字节、注释里再嵌一个结束记录 → 压缩包异常', async () => {
    const ents: ZipEntry[] = [{ name: CT, body: enc(ctXml(MAIN.docx)) }];
    expect(await sniff(buildZip(ents, { tail: new Uint8Array(1) }).bytes)).toEqual(bad('eocd_not_at_end'));
    const fake = concat(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), new Uint8Array(18), enc('XY'));
    expect(await sniff(buildZip(ents, { comment: fake }).bytes)).toEqual(bad('eocd_not_at_end'));
  });
  it('截断到没有结束记录 → 压缩包异常', async () => {
    const z = docx();
    expect(await sniff(z.bytes.subarray(0, z.eocd))).toEqual(bad('eocd_missing'));
    expect(await sniff(enc('PK\u0003\u0004'))).toEqual(bad('eocd_missing'));
  });
  it('ZIP64 标记、分卷、两个条目数不等 → 压缩包异常', async () => {
    const cases: Array<[(z: ReturnType<typeof docx>) => void, string]> = [
      [(z) => (put16(z.bytes, z.eocd + 8, 0xffff), put16(z.bytes, z.eocd + 10, 0xffff)), 'zip64'],
      [(z) => put32(z.bytes, z.eocd + 16, 0xffffffff), 'zip64'],
      [(z) => put32(z.bytes, z.eocd + 12, 0xffffffff), 'zip64'],
      [(z) => put16(z.bytes, z.eocd + 4, 1), 'eocd_multi_disk'],
      [(z) => put16(z.bytes, z.eocd + 6, 1), 'eocd_multi_disk'],
      [(z) => put16(z.bytes, z.eocd + 8, count(z) - 1), 'eocd_count_mismatch'],
      [(z) => put32(z.bytes, z.eocd + 12, z.eocd - z.cd + 1), 'cd_out_of_range'],
      [(z) => put32(z.bytes, z.central.at(1) ?? 0, 0), 'cd_bad_entry'],
      [(z) => (put16(z.bytes, z.eocd + 8, count(z) + 1), put16(z.bytes, z.eocd + 10, count(z) + 1)), 'cd_bad_entry'],
    ];
    for (const [mutate, detail] of cases) {
      const z = docx();
      mutate(z);
      expect(await sniff(z.bytes), detail).toEqual(bad(detail));
    }
  });
  it('本地头、目录头带不同长度的 extra，目录头带条目注释 → 照常逐条读到最后一条', async () => {
    const ext = { localExtra: LOCAL_EXTRA, centralExtra: CENTRAL_EXTRA, comment: enc('entry note') };
    const z = buildZip([
      { name: CT, body: enc(ctXml(MAIN.docx)), ...ext },
      { name: 'word/document.xml', body: enc('<w:document/>'), ...ext },
      { name: 'word/vbaProject.bin', body: enc('vba'), ...ext },
    ]);
    // 主部件类型在 XML 末尾 11 字节之前：数据起点少算 28 字节的 extra 就截掉它
    expect(LOCAL_EXTRA.length).toBe(28);
    expect(await sniff(z.bytes)).toEqual(ok('docm'));
  });
  it('目录大小改小 3 字节，最后一条的名字伸出中央目录 → 压缩包异常', async () => {
    const z = docx();
    put32(z.bytes, z.eocd + 12, z.eocd - z.cd - 3);
    expect(await sniff(z.bytes)).toEqual(bad('cd_bad_entry'));
  });
  it('下一条的条目头放不进中央目录（上一条注释少报 4 字节，末尾 4 字节是目录头签名）→ 压缩包异常', async () => {
    const z = buildZip([{ name: CT, body: enc(ctXml(MAIN.docx)), comment: concat(enc('xx'), new Uint8Array([0x50, 0x4b, 0x01, 0x02])) }]);
    put16(z.bytes, (z.central.at(0) ?? 0) + 32, 2);
    put16(z.bytes, z.eocd + 8, 2);
    put16(z.bytes, z.eocd + 10, 2);
    expect(await sniff(z.bytes)).toEqual(bad('cd_bad_entry'));
  });
  it('两个 [Content_Types].xml（含只差大小写的）→ 压缩包异常', async () => {
    const body = enc(ctXml(MAIN.docx));
    expect(await sniff(buildZip([{ name: CT, body }, { name: CT, body }]).bytes)).toEqual(bad('ct_duplicate'));
    expect(await sniff(buildZip([{ name: CT, body }, { name: '[content_types].XML', body }]).bytes)).toEqual(bad('ct_duplicate'));
  });
});

describe('读 [Content_Types].xml 这一个条目', () => {
  const xml = enc(ctXml(MAIN.docx));
  const one = (e: Partial<ZipEntry>) => buildZip([{ name: CT, body: xml, ...e }, { name: 'word/document.xml', body: enc('<w/>') }]);
  it('加密位、压缩方法 12、本地头签名不对、数据区伸进中央目录、不压缩但两个大小不等', async () => {
    expect(await sniff(one({ flags: 1 }).bytes)).toEqual(bad('ct_encrypted'));
    expect(await sniff(one({ method: 12 }).bytes)).toEqual(bad('ct_bad_method'));
    // 文件开头那个本地头改了就不是 ZIP 了：让目录指到第二个本地头，再改坏它
    const z2 = one({});
    put32(z2.bytes, (z2.central.at(0) ?? 0) + 42, z2.local.at(1) ?? 0);
    put32(z2.bytes, z2.local.at(1) ?? 0, 0);
    expect(await sniff(z2.bytes)).toEqual(bad('ct_bad_local'));
    const z3 = one({});
    put32(z3.bytes, (z3.central.at(0) ?? 0) + 20, z3.cd);
    put32(z3.bytes, (z3.central.at(0) ?? 0) + 24, z3.cd);
    expect(await sniff(z3.bytes)).toEqual(bad('ct_data_overrun'));
    const z4 = one({});
    put32(z4.bytes, (z4.central.at(0) ?? 0) + 42, z4.cd);
    expect(await sniff(z4.bytes), '本地头偏移指进中央目录').toEqual(bad('ct_data_overrun'));
    expect(await sniff(one({ size: xml.length + 1 }).bytes)).toEqual(bad('ct_size_mismatch'));
  });

  const deflated = enc('pretend-deflated');
  const packed = (size = xml.length) => one({ body: deflated, method: 8, size }).bytes;
  it('压缩方法 8：解压函数只调一次，拿到压缩那一段，上限是目录声明的大小', async () => {
    const calls: Array<[number[], number]> = [];
    const inflate: InflateRaw = (d, max) => {
      calls.push([Array.from(d), max]);
      return xml;
    };
    expect(await sniffFile(packed(), inflate)).toEqual(ok('docx'));
    expect(calls).toEqual([[Array.from(deflated), xml.length]]);
  });
  it('压缩方法 8、两边 extra 长度不同、本地头名字和目录头不一样长：数据起点只按本地头算，解压函数拿到的正好是压缩那一段', async () => {
    const calls: number[][] = [];
    const ext = { localExtra: LOCAL_EXTRA, centralExtra: CENTRAL_EXTRA };
    const z = buildZip([
      { name: CT, body: deflated, method: 8, size: xml.length, localName: 'local-name-is-longer.xml', comment: enc('c'), ...ext },
      { name: 'word/document.xml', body: enc('<w/>'), ...ext },
    ]);
    const inflate: InflateRaw = (d) => {
      calls.push(Array.from(d));
      return xml;
    };
    expect(await sniffFile(z.bytes, inflate)).toEqual(ok('docx'));
    expect(calls).toEqual([Array.from(deflated)]);
  });
  it('解压函数返回 null、抛错、长度不符、异步 reject → 压缩包异常；异步解出照常', async () => {
    expect(await sniffFile(packed(), () => null)).toEqual(bad('inflate_failed'));
    expect(await sniffFile(packed(), noInflate)).toEqual(bad('inflate_failed'));
    expect(await sniffFile(packed(), () => xml.subarray(1))).toEqual(bad('inflate_size'));
    expect(await sniffFile(packed(), () => concat(xml, new Uint8Array(1))), '目录把大小报小、解压没按上限停').toEqual(bad('inflate_size'));
    expect(await sniffFile(packed(), () => Promise.reject(new Error('x')))).toEqual(bad('inflate_failed'));
    expect(await sniffFile(packed(), () => Promise.resolve(xml))).toEqual(ok('docx'));
    const d = buildZip([{ name: CT, body: deflated, method: 8, size: xml.length, descriptor: true }]);
    expect(await sniffFile(d.bytes, () => xml)).toEqual(ok('docx'));
  });
  it('声明大小正好等于上限 → 照常解压一次，上限参数就是它', async () => {
    const full = concat(xml, new Uint8Array(CONTENT_TYPES_MAX_BYTES - xml.length).fill(0x20));
    const maxes: number[] = [];
    const r = await sniffFile(packed(CONTENT_TYPES_MAX_BYTES), (_, max) => (maxes.push(max), full));
    expect(r).toEqual(ok('docx'));
    expect(maxes).toEqual([CONTENT_TYPES_MAX_BYTES]);
  });
  it('声明大小超过上限 1 字节 → 压缩包异常，解压函数一次没调', async () => {
    let n = 0;
    const r = await sniffFile(packed(CONTENT_TYPES_MAX_BYTES + 1), () => (n++, xml));
    expect(r).toEqual(bad('ct_too_big'));
    expect(n).toBe(0);
  });
});
