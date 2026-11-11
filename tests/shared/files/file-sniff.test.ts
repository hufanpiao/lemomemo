// shared/logic/files/file-sniff.ts（架构 5.13 第 2 点 ①；TC-B4b1-07 十种类型、TC-B4b1-09 类型判断部分）
import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES_MAX_BYTES, sniffFile, type InflateRaw, type SniffResult } from '../../../shared/logic/files/file-sniff.ts';
import { buildOle, buildZip, concat, CT, ctXml, enc, MAIN, ooxml, put16, put32, rootWith, type ZipEntry } from './fixtures.ts';

/** 一调用就抛错：结果照常说明这条路没用到解压 */
const noInflate: InflateRaw = () => {
  throw new Error('不该调用解压函数');
};
const sniff = (b: Uint8Array): Promise<SniffResult> => sniffFile(b, noInflate);
const ok = (kind: string) => ({ ok: true, kind });
const bad = (detail: string) => ({ ok: false, reason: 'bad_archive', detail });
const unk = (detail: string) => ({ ok: false, reason: 'unknown', detail });
const docx = () => ooxml(ctXml(MAIN.docx));
const count = (z: { central: number[] }) => z.central.filter((c) => c >= 0).length;

describe('PDF', () => {
  it('开头是 %PDF- 就是 pdf', async () => {
    expect(await sniff(enc('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toEqual(ok('pdf'));
    expect(await sniff(enc('%PDF-'))).toEqual(ok('pdf'));
  });
  it('只有 4 字节、前面多空格或 BOM 都不认', async () => {
    expect(await sniff(enc('%PDF'))).toEqual(unk('no_signature'));
    expect(await sniff(enc(' %PDF-1.7'))).toEqual(unk('no_signature'));
    expect(await sniff(concat(new Uint8Array([0xef, 0xbb, 0xbf]), enc('%PDF-1.7')))).toEqual(unk('no_signature'));
  });
});

describe('OOXML：按 [Content_Types].xml 判', () => {
  for (const [kind, type] of Object.entries(MAIN)) {
    it(`主部件 ${kind}`, async () => expect(await sniff(ooxml(ctXml(type)).bytes)).toEqual(ok(kind)));
  }
  it('目录里有 vbaProject.bin 归带宏（/ 和 \\ 都是分隔符、不分大小写）', async () => {
    const vba = (main: string, name: string) => ooxml(ctXml(main), [{ name, body: enc('vba') }]).bytes;
    expect(await sniff(vba(MAIN.docx, 'word/vbaProject.bin'))).toEqual(ok('docm'));
    expect(await sniff(vba(MAIN.xlsx, 'xl/vbaProject.bin'))).toEqual(ok('xlsm'));
    expect(await sniff(vba(MAIN.pptx, 'ppt/vbaProject.bin'))).toEqual(ok('pptm'));
    expect(await sniff(vba(MAIN.docx, 'word\\VBAPROJECT.BIN'))).toEqual(ok('docm'));
    expect(await sniff(vba(MAIN.docx, 'word/notvbaProject.bin'))).toEqual(ok('docx'));
  });
  it('声明了 vbaProject 类型（部件改了名）也归带宏', async () => {
    expect(await sniff(ooxml(ctXml(MAIN.docx, 'application/vnd.ms-office.vbaProject')).bytes)).toEqual(ok('docm'));
  });
  it('同一家族普通和 macroEnabled 主部件都有 → 带宏', async () => {
    expect(await sniff(ooxml(ctXml(MAIN.xlsx, MAIN.xlsm)).bytes)).toEqual(ok('xlsm'));
  });
  it('Word 和 Excel 主部件都有 → 不认', async () => {
    expect(await sniff(ooxml(ctXml(MAIN.docx, MAIN.xlsx)).bytes)).toEqual(unk('ct_multi_family'));
  });
  it('伪装成 docx 的 ZIP（没有 [Content_Types].xml）→ 不认', async () => {
    expect(await sniff(buildZip([{ name: 'a.txt', body: enc('hi') }]).bytes)).toEqual(unk('ct_missing'));
  });
  it('主部件不在六种里（dotx、ppsx、xlsb）→ 不认', async () => {
    for (const t of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
      'application/vnd.ms-excel.sheet.binary.macroEnabled.main',
    ]) {
      expect(await sniff(ooxml(ctXml(t)).bytes)).toEqual(unk('ct_no_main'));
    }
  });
  it('只认中央目录列出的：前部藏一个声明 docx 的本地条目不算', async () => {
    const z = buildZip([{ name: CT, body: enc(ctXml(MAIN.docx)), hidden: true }, { name: 'a.txt', body: enc('hi') }]);
    expect(await sniff(z.bytes)).toEqual(unk('ct_missing'));
  });
  it('带数据描述符（标志位 3、本地头大小为 0）照常判出', async () => {
    expect(await sniff(buildZip([{ name: CT, body: enc(ctXml(MAIN.pptx)), descriptor: true }]).bytes)).toEqual(ok('pptx'));
  });
});

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
  it('解压函数返回 null、抛错、长度不符、异步 reject → 压缩包异常；异步解出照常', async () => {
    expect(await sniffFile(packed(), () => null)).toEqual(bad('inflate_failed'));
    expect(await sniffFile(packed(), noInflate)).toEqual(bad('inflate_failed'));
    expect(await sniffFile(packed(), () => xml.subarray(1))).toEqual(bad('inflate_size'));
    expect(await sniffFile(packed(), () => Promise.reject(new Error('x')))).toEqual(bad('inflate_failed'));
    expect(await sniffFile(packed(), () => Promise.resolve(xml))).toEqual(ok('docx'));
    const d = buildZip([{ name: CT, body: deflated, method: 8, size: xml.length, descriptor: true }]);
    expect(await sniffFile(d.bytes, () => xml)).toEqual(ok('docx'));
  });
  it('声明大小超过上限 1 字节 → 压缩包异常，解压函数一次没调', async () => {
    let n = 0;
    const r = await sniffFile(packed(CONTENT_TYPES_MAX_BYTES + 1), () => (n++, xml));
    expect(r).toEqual(bad('ct_too_big'));
    expect(n).toBe(0);
  });
});

describe('XML 写法', () => {
  const pkg = (s: string | Uint8Array) => buildZip([{ name: CT, body: typeof s === 'string' ? enc(s) : s }]).bytes;
  it('单引号、等号两边空白、UTF-8 BOM → 照常', async () => {
    expect(await sniff(pkg(`<Types><Override PartName='/w.xml' ContentType = '${MAIN.docx}'/></Types>`))).toEqual(ok('docx'));
    expect(await sniff(pkg(concat(new Uint8Array([0xef, 0xbb, 0xbf]), enc(ctXml(MAIN.xlsx)))))).toEqual(ok('xlsx'));
  });
  it('注释、DOCTYPE、CDATA、值里有 & → 不认；UTF-16 → 不认', async () => {
    const base = ctXml(MAIN.docx);
    for (const s of [base.replace('<Types', '<!-- x --><Types'), base.replace('<Types', '<!DOCTYPE Types><Types'), base.replace('</Types>', '<![CDATA[x]]></Types>')]) {
      expect(await sniff(pkg(s))).toEqual(unk('ct_xml_unsafe'));
    }
    expect(await sniff(pkg(base.replace('main+xml', 'main&#43;xml')))).toEqual(unk('ct_xml_unsafe'));
    const u16 = new Uint8Array(base.length * 2);
    [...base].forEach((c, i) => put16(u16, i * 2, c.charCodeAt(0)));
    expect(await sniff(pkg(u16))).toEqual(unk('ct_no_main'));
  });
});

describe('OLE2 旧格式', () => {
  const ole = (...kids: Array<[string, number]>) => buildOle(rootWith(...kids)).bytes;
  it('根下的流名定类型', async () => {
    expect(await sniff(ole(['WordDocument', 2]))).toEqual(ok('doc'));
    expect(await sniff(ole(['Workbook', 2]))).toEqual(ok('xls'));
    expect(await sniff(ole(['Book', 2]))).toEqual(ok('xls'));
    expect(await sniff(ole(['PowerPoint Document', 2], ['Pictures', 2]))).toEqual(ok('ppt'));
    expect(await sniff(ole(['Book', 2], ['Workbook', 2]))).toEqual(ok('xls'));
  });
  it('没有这几种流、大小写不同、是存储不是流 → 不认', async () => {
    expect(await sniff(ole(['EncryptedPackage', 2]))).toEqual(unk('ole_no_stream'));
    expect(await sniff(ole())).toEqual(unk('ole_no_stream'));
    expect(await sniff(ole(['worddocument', 2]))).toEqual(unk('ole_no_stream'));
    expect(await sniff(ole(['WordDocument', 1]))).toEqual(unk('ole_no_stream'));
  });
  it('PPT 里嵌 Excel（子存储里的 Workbook 不算）→ ppt；根下 Word 和 Excel 都有 → 不认', async () => {
    const embed = buildOle([
      { name: 'Root Entry', type: 5, child: 1 },
      { name: 'PowerPoint Document', type: 2, right: 2 },
      { name: 'MBD0001', type: 1, child: 3 },
      { name: 'Workbook', type: 2 },
    ]);
    expect(await sniff(embed.bytes)).toEqual(ok('ppt'));
    expect(await sniff(ole(['WordDocument', 2], ['Workbook', 2]))).toEqual(unk('ole_multi_family'));
  });
  it('目标流在第二个目录扇区、4096 字节扇区 → 判得出', async () => {
    const two = buildOle(rootWith(['a', 2], ['b', 2], ['c', 2], ['d', 2], ['WordDocument', 2]));
    expect(two.dirSectors).toHaveLength(2);
    expect(await sniff(two.bytes)).toEqual(ok('doc'));
    expect(await sniff(buildOle(rootWith(['Workbook', 2]), { shift: 12 }).bytes)).toEqual(ok('xls'));
  });
  it('大文件：目录扇区的 FAT 项在第 110 个 FAT 扇区，要走 DIFAT 链', async () => {
    const big = buildOle(rootWith(['WordDocument', 2]), { pad: 13900 });
    expect((big.dirSectors.at(0) ?? 0) >= 109 * 128).toBe(true);
    expect(big.bytes.length).toBeGreaterThan(6.8e6);
    expect(await sniff(big.bytes)).toEqual(ok('doc'));
  });
  it('畸形一律不认，不抛错、不死循环', async () => {
    const cases: Array<[(b: Uint8Array, entry: (k: number) => number) => Uint8Array | void, string]> = [
      [(b) => b.subarray(0, 511), 'ole_short'],
      [(b) => put16(b, 28, 0xfeff), 'ole_bad_header'],
      [(b) => put16(b, 30, 10), 'ole_bad_header'],
      [(b) => put32(b, 44, 0xffff), 'ole_bad_fat'],
      [(b) => put32(b, 76, 9999), 'ole_bad_fat'],
      [(b) => put32(b, 48, 9999), 'ole_dir_chain'],
      [(b) => put32(b, 512 + 4, 1), 'ole_dir_chain'],
      [
        (b, e) => {
          b[e(0) + 66] = 1;
        },
        'ole_no_root',
      ],
      [(b, e) => put32(b, e(1) + 72, 1), 'ole_bad_tree'],
      [(b, e) => put32(b, e(1) + 72, 0), 'ole_bad_tree'],
      [(b, e) => put32(b, e(1) + 68, 50), 'ole_bad_tree'],
    ];
    for (const [mutate, detail] of cases) {
      const o = buildOle(rootWith(['WordDocument', 2]));
      const b = mutate(o.bytes, o.entry) ?? o.bytes;
      expect(await sniff(b), detail).toEqual(unk(detail));
    }
  });
});

describe('其他文件和拼接', () => {
  it('exe、空文件、1 字节、纯文本、webp、png、jpg → 不认', async () => {
    const samples = [
      concat(enc('MZ'), new Uint8Array(200)),
      new Uint8Array(0),
      new Uint8Array([0x25]),
      enc('just some text'),
      enc('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
      buildZip([]).bytes,
    ];
    for (const b of samples) expect(await sniff(b)).toEqual(unk('no_signature'));
  });
  it('%PDF- 开头后接 docx → pdf；exe 桩后接 docx → 不认', async () => {
    expect(await sniff(concat(enc('%PDF-1.4\n'), docx().bytes))).toEqual(ok('pdf'));
    expect(await sniff(concat(enc('MZ'), new Uint8Array(64), docx().bytes))).toEqual(unk('no_signature'));
  });
  it('输入是大缓冲区的子视图 → 和单独一份一样', async () => {
    for (const [b, kind] of [[enc('%PDF-1.7'), 'pdf'], [docx().bytes, 'docx'], [buildOle(rootWith(['Workbook', 2])).bytes, 'xls']] as const) {
      const host = concat(new Uint8Array(7), b, new Uint8Array(5));
      expect(await sniff(host.subarray(7, 7 + b.length))).toEqual(ok(kind));
    }
  });
  it('截断：docx 任何长度都不是 ok；三种样本截断后都不会判成别的类型', async () => {
    const samples = [
      [enc('%PDF-1.7\n1 0 obj'), 'pdf'],
      [docx().bytes, 'docx'],
      [buildOle(rootWith(['a', 2], ['b', 2], ['c', 2], ['d', 2], ['WordDocument', 2])).bytes, 'doc'],
    ] as const;
    for (const [full, kind] of samples) {
      for (let n = 0; n < full.length; n += 1) {
        const r = await sniff(full.slice(0, n));
        if (r.ok) expect(r.kind, `${kind}@${n}`).toBe(kind === 'docx' ? 'never' : kind);
        else expect(['unknown', 'bad_archive'], `${kind}@${n}`).toContain(r.reason);
      }
    }
  });
});
