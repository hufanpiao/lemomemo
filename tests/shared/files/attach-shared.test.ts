// 附件的几个 shared 小件（B4b-1）：ZIP 炸弹按真实字节数（file-sniff.ts 的 zipBombCheck）、raw deflate 解压（inflate.ts）、
// 文件名清理（file-name.ts，结果对拍 0004 里 note_files.name 的 check 约束）、对象路径（media-path.ts，对拍 path 的 check 约束）
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipBombCheck } from '../../../shared/logic/files/file-sniff.ts';
import { FILE_NAME_MAX, sanitizeFileName } from '../../../shared/logic/files/file-name.ts';
import { inflateRaw } from '../../../shared/logic/files/inflate.ts';
import { noteFilePath, noteFileThumbPath } from '../../../shared/logic/files/media-path.ts';
import { buildZip, enc } from './fixtures.ts';

const deflated = (n: number, ch = 0x41): { body: Uint8Array; method: number; size: number } => ({
  body: new Uint8Array(deflateRawSync(Buffer.alloc(n, ch))),
  method: 8,
  size: n,
});

describe('inflateRaw', () => {
  it('解出原文；超过上限回 null；坏数据抛错', async () => {
    const z = deflated(5000);
    expect((await inflateRaw(z.body, 5000))?.length).toBe(5000);
    expect(await inflateRaw(z.body, 4999)).toBeNull();
    await expect(inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 10)).rejects.toThrow();
  });
});

describe('zipBombCheck', () => {
  const small = { totalBytes: 10_000, entryBytes: 6_000, entries: 3 };
  it('正常的包按真实解压量计', async () => {
    const z = buildZip([{ name: 'a.xml', ...deflated(3000) }, { name: 'b.bin', body: enc('stored') }]);
    expect(await zipBombCheck(z.bytes, inflateRaw, small)).toEqual({ ok: true, total: 3006 });
  });
  it('目录里谎报大小也按真实字节拒：单个条目超限', async () => {
    const z = buildZip([{ name: 'a.xml', ...deflated(7000), size: 10 }]);
    expect(await zipBombCheck(z.bytes, inflateRaw, small)).toEqual({ ok: false, reason: 'bad_archive', detail: 'bomb_entry' });
  });
  it('合计超限', async () => {
    const z = buildZip([1, 2].map((i) => ({ name: `p${i}.xml`, ...deflated(5500) })));
    expect(await zipBombCheck(z.bytes, inflateRaw, small)).toEqual({ ok: false, reason: 'bad_archive', detail: 'bomb_total' });
  });
  it('条目太多', async () => {
    const z = buildZip([1, 2, 3, 4].map((i) => ({ name: `f${i}`, body: enc('x') })));
    expect(await zipBombCheck(z.bytes, inflateRaw, small)).toEqual({ ok: false, reason: 'bad_archive', detail: 'bomb_entries' });
  });
  it('不是 ZIP 的直接过；目录坏了按压缩包异常', async () => {
    expect(await zipBombCheck(enc('%PDF-1.7'), inflateRaw)).toEqual({ ok: true, total: 0 });
    const z = buildZip([{ name: 'a', body: enc('x') }]);
    expect((await zipBombCheck(z.bytes.subarray(0, z.bytes.length - 3), inflateRaw)).ok).toBe(false);
  });
});

// 0004 里 note_files.name 的 check 约束，照抄成 JS（\u 写法）
const dbNameOk = (n: string): boolean =>
  [...n].length >= 1 && [...n].length <= 120 &&
  !/[\u0000-\u001f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/u.test(n) && !/[. ]$/.test(n) &&
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test((n.split('.')[0] ?? '').toLowerCase());

describe('sanitizeFileName', () => {
  it.each([
    ['报价单.PDF', 'pdf', '报价单.pdf'],
    ['C:\\Users\\a\\合同.docx', 'docx', '合同.docx'],
    ['../../etc/passwd', 'pdf', 'passwd.pdf'],
    ['a:b*c?"d<e>f|g.xlsx', 'xlsx', 'abcdefg.xlsx'],
    ['evil\u202Efdp.exe', 'pdf', 'evilfdp.pdf'],
    ['CON.docx', 'docx', '_CON.docx'],
    ['lpt1.backup.xls', 'xls', '_lpt1.backup.xls'],
    ['名字. . .pptx', 'pptx', '名字.pptx'],
    ['', 'pdf', 'file.pdf'],
    ['...', 'doc', 'file.doc'],
    ['伪装.pdf', 'docm', '伪装.docm'],
  ] as const)('%s → %s', (raw, kind, want) => {
    expect(sanitizeFileName(raw, kind)).toBe(want);
    expect(dbNameOk(want)).toBe(true);
  });
  it('超长按码点截到 120（含扩展名），截完不以点或空格结尾', () => {
    const n = sanitizeFileName(`${'한'.repeat(200)}.pdf`, 'pdf');
    expect([...n].length).toBe(FILE_NAME_MAX);
    expect(dbNameOk(n)).toBe(true);
    const m = sanitizeFileName(`${'a'.repeat(114)} .x.pdf`, 'pdf');
    expect(dbNameOk(m)).toBe(true);
  });
  it('emoji（代理对）不截半个', () => {
    const n = sanitizeFileName(`${'😀'.repeat(130)}.pdf`, 'pdf');
    expect(n.endsWith('😀.pdf')).toBe(true);
    expect(dbNameOk(n)).toBe(true);
  });
});

describe('media-path', () => {
  const u = '11111111-1111-4111-8111-111111111111';
  const n = '22222222-2222-4222-8222-222222222222';
  const i = '33333333-3333-4333-8333-333333333333';
  it('和 0004 的 path check 约束、files 桶 pathPattern 同一个拼法', () => {
    expect(noteFilePath(u, n, i, 'xlsm')).toBe(`${u}/${n}/${i}.xlsm`);
    expect(noteFileThumbPath(u, n, i)).toBe(`${u}/${n}/${i}.t.webp`);
  });
});
