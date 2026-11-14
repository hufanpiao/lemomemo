// 附件列表的纯函数（data/attach-list.ts、attach-kinds.ts、core/ms-pref.ts）
import { afterEach, describe, expect, it } from 'vitest';
import { countOf, isMacro, markOf, previewOf, sizeText } from '../data/attach-kinds.ts';
import { filesByNote } from '../data/attach-list.ts';
import { MS_PREF_KEYS, readMsPref, writeMsPref } from '../../../core/ms-pref.ts';

const row = (id: string, o: Record<string, unknown> = {}) => ({ id, note_id: 'n1', kind: 'pdf', path: `u/n1/${id}.pdf`, name: `${id}.pdf`, bytes: 10, sha256: 's', check_status: 'ok', deleted_at: null, undone: false, ...o });

describe('filesByNote', () => {
  it('只列活着的普通附件，按 id 排；check_status 不认识的当 pending', () => {
    const m = filesByNote([row('b'), row('a', { check_status: 'weird' }), row('c', { deleted_at: 1 }), row('d', { is_vault: true }), row('e', { kind: 'exe' }), row('f', { undone: true })]);
    expect(m.get('n1')?.map((f) => [f.id, f.check])).toEqual([
      ['a', 'pending'],
      ['b', 'ok'],
    ]);
  });
  it('页数只认正整数；has_thumb 只认 true', () => {
    const m = filesByNote([row('a', { pages: 4, has_thumb: true }), row('b', { pages: 0 }), row('c', { pages: 2.5, has_thumb: 'yes' })]).get('n1') ?? [];
    expect(m.map((f) => [f.pages, f.hasThumb])).toEqual([[4, true], [null, false], [null, false]]);
  });
  it('没名字时用 file.<kind>', () => {
    expect(filesByNote([row('a', { name: null })]).get('n1')?.[0]?.name).toBe('file.pdf');
  });
});

describe('类型和大小', () => {
  it('pdf、docx、xlsx 本机预览，pptx 交微软，带宏、旧格式只下载', () => {
    expect(['pdf', 'docx', 'xlsx', 'pptx', 'docm', 'xls'].map((k) => previewOf(k as never))).toEqual(['pdf', 'docx', 'xlsx', 'ms', null, null]);
    expect(['pdf', 'pptx', 'xlsx', 'docx', 'ppt'].map((k) => countOf(k as never))).toEqual(['pages', 'pages', 'sheets', null, null]);
    expect(isMacro('xlsm')).toBe(true);
    expect(isMacro('doc')).toBe(false);
    expect(['pdf', 'docm', 'xls', 'ppt'].map((k) => markOf(k as never))).toEqual(['PDF', 'W', 'X', 'P']);
  });
  it('大小：不到 1 KB 写 1 KB，MB 留一位', () => {
    expect(sizeText(10)).toBe('1 KB');
    expect(sizeText(88_064)).toBe('86 KB');
    expect(sizeText(1_258_291)).toBe('1.2 MB');
  });
});

describe('PPT 交不交给微软（本机记）', () => {
  afterEach(() => {
    localStorage.removeItem(MS_PREF_KEYS.note);
    localStorage.removeItem(MS_PREF_KEYS.vault);
  });
  it('没选过回 null，选了记住；别的值当没选过；普通、隐私记各记各的；null 清掉', () => {
    expect(readMsPref('note')).toBeNull();
    writeMsPref('note', 'no');
    expect(readMsPref('note')).toBe('no');
    expect(readMsPref('vault')).toBeNull();
    writeMsPref('vault', 'yes');
    expect(readMsPref('vault')).toBe('yes');
    writeMsPref('note', null);
    expect(readMsPref('note')).toBeNull();
    localStorage.setItem(MS_PREF_KEYS.vault, 'maybe');
    expect(readMsPref('vault')).toBeNull();
  });
});
