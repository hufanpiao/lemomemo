// 宽容读取的纯函数·有 vaultRows 的表（架构 0.27 第 1 点、3.5 vaultRows；R-229）：TC-B1-36、37、39 的读取一半、只读空壳
// 从 read-lenient.test.ts 拆出（文件行数上限）；落库一半见 read-ingest.test.ts
import { describe, expect, it } from 'vitest';
import { UNKNOWN } from '../../../shared/schema/rows-read.ts';
import { createParseRows, isVaultRow, readRow, readRows, tableReader, type RowOutcome, type TableReader } from '../read/lenient.ts';
import { serverImage, serverNote, serverTodo, SECRET } from './read-fixtures.ts';
import { uid } from './outbox-fixtures.ts';

const reader = (t: string): TableReader => {
  const r = tableReader(t);
  if (typeof r === 'string') throw new Error(`${t}:${r}`);
  return r;
};

/** 先断言读成功，再收窄 */
function okOf(o: RowOutcome): Extract<RowOutcome, { ok: true }> {
  expect(o.ok).toBe(true);
  if (!o.ok) throw new Error(`dropped:${o.code}:${o.cols.join(',')}`);
  return o;
}
/** 先断言丢掉，再收窄 */
function dropOf(o: RowOutcome): Extract<RowOutcome, { ok: false }> {
  expect(o.ok).toBe(false);
  if (o.ok) throw new Error('not_dropped');
  return o;
}

describe('有 vaultRows 的表', () => {
  it('TC-B1-36：隐私记行带不认识的明文列 qa_plain：只留 cipherCols 和 neutralCols，qa_plain 丢掉', () => {
    const r = reader('notes');
    const o = okOf(readRow(r, serverNote(1, true, { qa_plain: SECRET, title: SECRET })));
    const allowed = new Set(['id', ...(r.vault?.rules.cipherCols ?? []), ...(r.vault?.rules.neutralCols ?? [])]);
    expect(Object.keys(o.input.row).filter((c) => !allowed.has(c))).toEqual([]);
    expect(o.input.row['qa_plain']).toBeUndefined();
    expect(o.input.row['title']).toBeUndefined();
    expect(o.input.row['body_enc']).toBe('ZW5j');
    expect(JSON.stringify(o.input.row)).not.toContain(SECRET);
    expect(o.vault).toBe(true);
    expect(o.input.ro).toBeUndefined();   // 判断得了的隐私记行不算只读（本来就只经服务器函数改）
    expect(o.unknownCols).toEqual(['qa_plain']);
  });

  it('同一张表的普通行：不认识的列照样留着', () => {
    const o = okOf(readRow(reader('notes'), serverNote(2, false, { qa_plain: 'x' })));
    expect(o.input.row['qa_plain']).toBe('x');
    expect(o.input.row['title']).toBe('随手记2');
    expect(o.vault).toBe(false);
  });

  it.each([
    ['is_private 不是布尔', { is_private: 'yes' }],
    ['is_private 为 null', { is_private: null }],
    ['缺了 is_private', { is_private: undefined }],
  ])('TC-B1-37：flag 列解析不了（%s）：按隐私记行处理，不留明文，只读，flag 列写 unknown', (_name, over) => {
    const raw = serverNote(3, false, { qa_plain: SECRET, title: SECRET, body: SECRET, ...over });
    if (over.is_private === undefined) delete raw['is_private'];
    const o = okOf(readRow(reader('notes'), raw));
    expect(o.vault).toBe(true);
    expect(o.input.ro).toBe(true);
    expect(JSON.stringify(o.input.row)).not.toContain(SECRET);
    expect(o.input.row['is_private']).toBe(UNKNOWN);
    expect(isVaultRow('notes', o.input.row)).toBe(true);
  });

  it('TC-B1-37：note_images 的 bucket 读到不认识的值：按隐私记行处理，ai_desc、taken_at 不进本机；之后 isVaultRow 仍判成隐私记', () => {
    const o = okOf(readRow(reader('note_images'), serverImage(4, 'vault-images-v2')));
    expect(o.vault).toBe(true);
    expect(o.input.ro).toBe(true);
    expect(o.input.row['bucket']).toBe(UNKNOWN);
    expect(o.input.row['ai_desc']).toBeUndefined();
    expect(o.input.row['taken_at']).toBeUndefined();
    expect(isVaultRow('note_images', o.input.row)).toBe(true);
    const plain = okOf(readRow(reader('note_images'), serverImage(5, 'images')));
    expect(plain.input.row['ai_desc']).toBe('图片描述');
    expect(isVaultRow('note_images', plain.input.row)).toBe(false);
    const vault = okOf(readRow(reader('note_images'), serverImage(6, 'vault-images')));
    expect(vault.input.row['ai_desc']).toBeUndefined();
    expect(vault.input.ro).toBeUndefined();
    expect(isVaultRow('note_images', vault.input.row)).toBe(true);
  });

  it('isVaultRow：没有 vaultRows 的表是 false；清单里没有的表是 true（失败就关上）', () => {
    expect(isVaultRow('todos', serverTodo(1))).toBe(false);
    expect(isVaultRow('habits', { id: uid(1) })).toBe(true);
    expect(isVaultRow('notes', { id: uid(1) })).toBe(true);
  });

  it('隐私记行只按白名单列判缺：plainColsMustBeNull、不认识的列缺了不算', () => {
    const raw = serverNote(8, true);
    for (const c of ['title', 'body', 'raw_text', 'tags', 'ai_meta', 'converted_to']) delete raw[c];
    okOf(readRow(reader('notes'), raw));
    const noRev = serverNote(9, true);
    delete noRev['rev'];
    expect(dropOf(readRow(reader('notes'), noRev))).toMatchObject({ code: 'missing', cols: ['rev'] });
  });

  it('R-229：隐私记行（判断得了）解析不了：整行丢掉，带只读空壳（只有 id 和 flag 列），id 进 bad', () => {
    const o = dropOf(readRow(reader('notes'), serverNote(7, true, { rev: 'x', qa_plain: SECRET })));
    expect(o).toMatchObject({ id: uid(7), code: 'bad_type', cols: ['rev'] });
    expect(o.shell).toEqual({ row: { id: uid(7), is_private: true }, ro: true, shell: true, minRev: null });
    const p = createParseRows()('notes', [serverNote(7, true, { rev: 'x' })]);
    expect(p.bad).toEqual([uid(7)]);
    expect(p.rows).toEqual([{ row: { id: uid(7), is_private: true }, ro: true, shell: true, minRev: null }]);
  });

  it('R-229：空壳带 minRev：原始行 rev 是有效正整数才给，否则 null', () => {
    const shellOf = (rev: unknown): unknown => dropOf(readRow(reader('notes'), serverNote(7, true, { rev, user_id: 5 }))).shell;
    expect(shellOf(3)).toMatchObject({ shell: true, minRev: 3 });
    for (const bad of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 2]) expect(shellOf(bad)).toMatchObject({ shell: true, minRev: null });
    const noRev = serverNote(8, true);
    delete noRev['rev'];
    expect(dropOf(readRow(reader('notes'), noRev)).shell).toMatchObject({ shell: true, minRev: null });
  });

  it('R-229：判断不了的行解析不了：空壳的 flag 列写 unknown；普通行解析不了没有空壳', () => {
    const unsure = dropOf(readRow(reader('note_images'), serverImage(8, 'weird', { rev: 'x' })));
    expect(unsure.shell).toEqual({ row: { id: uid(8), bucket: UNKNOWN }, ro: true, shell: true, minRev: null });
    const plain = dropOf(readRow(reader('notes'), serverNote(9, false, { rev: 'x' })));
    expect(plain.shell).toBeUndefined();
  });

  it('TC-B1-39（读取一半）：新列、新枚举、repeat、隐私记新明文列混在一批：整批不拒收，该只读的只读', () => {
    const todos = readRows('todos', [serverTodo(1, { qa_new: 1 }), serverTodo(2, { short_by: 'model' }), serverTodo(3, { repeat: { freq: 'daily' } })]);
    expect(todos.rows).toHaveLength(3);
    expect(todos.readonlyIds).toEqual([uid(2), uid(3)]);
    const notes = readRows('notes', [serverNote(4, true, { qa_plain: SECRET }), serverNote(5, false)]);
    expect(notes.rows).toHaveLength(2);
    expect(JSON.stringify(notes.rows)).not.toContain(SECRET);
  });
});
