// shared/logic/files/file-sniff.ts（架构 5.13 第 2 点 ①；TC-B4b1-07 十种类型、TC-B4b1-09 类型判断部分）；ZIP 结构和读条目的用例在 file-sniff-zip.test.ts
import { describe, expect, it } from 'vitest';
import { buildOle, buildZip, concat, CT, ctXml, docx, enc, MAIN, ok, ooxml, put16, put32, rootWith, sniff, unk } from './fixtures.ts';

/** doc 样本：WordDocument 是根下第 5 条，落在第 2 个目录扇区（只读，用的地方不改字节） */
const DOC_2ND_DIR = buildOle(rootWith(['a', 2], ['b', 2], ['c', 2], ['d', 2], ['WordDocument', 2]));

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
    expect(await sniff(vba(MAIN.docx, 'vbaProject.bin'))).toEqual(ok('docm'));
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
  it('只认包根目录的 [Content_Types].xml：子目录里那份声明了 docx 也不算', async () => {
    for (const name of [`word/${CT}`, `foo/${CT}`, `foo\\${CT}`, `x${CT}`]) {
      const z = buildZip([{ name, body: enc(ctXml(MAIN.docx)) }, { name: 'word/document.xml', body: enc('<w:document/>') }]);
      expect(await sniff(z.bytes), name).toEqual(unk('ct_missing'));
    }
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
  it('R-408：根下 EncryptionInfo 和 EncryptedPackage 两个流都在（带打开密码的 docx、xlsx、pptx）→ 带密码，不算类型不认', async () => {
    const enc = { ok: false, reason: 'encrypted', detail: 'ole_encrypted_package' };
    expect(await sniff(ole(['EncryptionInfo', 2], ['EncryptedPackage', 2]))).toEqual(enc);
    // 真文件根下还有 DataSpaces 存储、SummaryInformation 流，不影响
    expect(await sniff(ole(['DataSpaces', 1], ['EncryptedPackage', 2], ['SummaryInformation', 2], ['EncryptionInfo', 2]))).toEqual(enc);
    // 只有其中一个、是存储不是流、大小写不同 → 照旧不认
    expect(await sniff(ole(['EncryptionInfo', 2]))).toEqual(unk('ole_no_stream'));
    expect(await sniff(ole(['EncryptionInfo', 1], ['EncryptedPackage', 2]))).toEqual(unk('ole_no_stream'));
    expect(await sniff(ole(['encryptioninfo', 2], ['EncryptedPackage', 2]))).toEqual(unk('ole_no_stream'));
    // 带密码的旧格式（根下照样有 WordDocument）仍判成 doc
    expect(await sniff(ole(['WordDocument', 2], ['EncryptionInfo', 2], ['EncryptedPackage', 2]))).toEqual(ok('doc'));
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
    expect(DOC_2ND_DIR.dirSectors).toHaveLength(2);
    expect(await sniff(DOC_2ND_DIR.bytes)).toEqual(ok('doc'));
    expect(await sniff(buildOle(rootWith(['Workbook', 2]), { shift: 12 }).bytes)).toEqual(ok('xls'));
  });
  it('4096 字节扇区：目标流在第 2 个目录扇区、目录扇区的 FAT 项在第 2 个 FAT 扇区', async () => {
    const kids = Array.from({ length: 40 }, (_, i): [string, number] => [`s${i}`, 2]);
    kids.splice(35, 0, ['WordDocument', 2]);
    const o = buildOle(rootWith(...kids), { shift: 12, pad: 1100 });
    // 每扇区 32 个目录条目、1024 个 FAT 项：条目 36 在第 2 个目录扇区，目录扇区号 ≥ 1024
    expect(o.dirSectors).toHaveLength(2);
    expect(o.dirSectors.every((s) => s >= 1024)).toBe(true);
    expect(await sniff(o.bytes)).toEqual(ok('doc'));
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
  it('DIFAT 链：FAT 扇区数报成 2^31−1 → 不认（FAT 扇区数超过文件扇区数，不沿链走）', async () => {
    const o = buildOle(rootWith(['WordDocument', 2]));
    put32(o.bytes, 44, 0x7fffffff);
    expect(await sniff(o.bytes)).toEqual(unk('ole_bad_fat'));
  });
  it('DIFAT 链起点指到文件外 → 不认', async () => {
    const o = buildOle(rootWith(['WordDocument', 2]), { pad: 200 });
    put32(o.bytes, 44, 150);
    put32(o.bytes, 68, 9999);
    expect(await sniff(o.bytes)).toEqual(unk('ole_bad_fat'));
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
  it('截断：docx 任何长度都不是 ok；pdf 截断后不会判成别的类型（doc 的截断见下一条）', async () => {
    const samples = [
      [enc('%PDF-1.7\n1 0 obj'), 'pdf'],
      [docx().bytes, 'docx'],
    ] as const;
    for (const [full, kind] of samples) {
      for (let n = 0; n < full.length; n += 1) {
        const r = await sniff(full.slice(0, n));
        if (r.ok) expect(r.kind, `${kind}@${n}`).toBe(kind === 'docx' ? 'never' : kind);
        else expect(['unknown', 'bad_archive'], `${kind}@${n}`).toContain(r.reason);
      }
    }
  });
  it('OLE 截断：WordDocument 那条目录没读完的长度一律不认，读越界回 ole_range；读完了才是 doc', async () => {
    // 第 5 条在第 2 个目录扇区；读到它的左右兄弟（+68、+72 各 4 字节）为止，要读满 entry(5)+76 字节
    const ole = DOC_2ND_DIR;
    const end = ole.entry(5) + 76;
    for (let n = 0; n < end; n += 1) expect((await sniff(ole.bytes.slice(0, n))).ok, `doc@${n}`).toBe(false);
    for (const n of [ole.entry(5), end - 1]) expect(await sniff(ole.bytes.slice(0, n)), `doc@${n}`).toEqual(unk('ole_range'));
    expect(await sniff(ole.bytes.slice(0, end))).toEqual(ok('doc'));
  });
});
