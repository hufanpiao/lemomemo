// D1 第 11c 节“同步表文本列都要有长度或取值约束”的判定（build/d1/text-bounds.ts；架构 0.47 第 20 条 ③，TC-B1-147）。
// 约束文字照 pg_get_constraintdef 的实际输出写（离线 PGlite 实测，CASE 前面会换行）
import { describe, expect, it } from 'vitest';
import { boundedBy, NEVER_EXEMPT, textBoundProblems } from '../../build/d1/text-bounds.ts';

describe('boundedBy：认得出哪些写法算限住了这一列', () => {
  it('长度、个数、大小：char_length / length / octet_length / cardinality / pg_column_size', () => {
    expect(boundedBy('note', ['CHECK ((char_length(note) <= 2000))'])).toBe(true);
    expect(boundedBy('label', ['CHECK ((length(label) <= 80))'])).toBe(true);
    expect(boundedBy('tags', ['CHECK ((cardinality(tags) <= 20))'])).toBe(true);
    expect(boundedBy('converted_to', ["CHECK (((converted_to IS NULL) OR ((jsonb_typeof(converted_to) = ANY (ARRAY['object'::text, 'array'::text])) AND (pg_column_size(converted_to) <= 2048))))"])).toBe(true);
    // 安全审查 10-31 起迁移改按文字形式量：pg_get_constraintdef 输出 octet_length((converted_to)::text)
    expect(boundedBy('converted_to', ["CHECK (((converted_to IS NULL) OR ((jsonb_typeof(converted_to) = ANY (ARRAY['object'::text, 'array'::text])) AND (octet_length((converted_to)::text) <= 2048))))"])).toBe(true);
    expect(boundedBy('converted_to', ["CHECK ((octet_length((ai_meta)::text) <= 2048))"])).toBe(false);
  });

  it('取值清单、单个值、按别的列查表（CASE 前换行）、格式、拼出来的值、private 函数', () => {
    expect(boundedBy('source', ["CHECK ((source = ANY (ARRAY['page'::text, 'chat'::text])))"])).toBe(true);
    expect(boundedBy('mime', ["CHECK ((mime = 'image/webp'::text))"])).toBe(true);
    expect(boundedBy('mime', ["CHECK ((mime =\nCASE kind\n    WHEN 'pdf'::text THEN 'application/pdf'::text\n    ELSE NULL::text\nEND))"])).toBe(true);
    expect(boundedBy('sha256', ["CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))"])).toBe(true);
    expect(boundedBy('path', ["CHECK ((path = ((user_id)::text || '/'::text)))"])).toBe(true);
    expect(boundedBy('tags', ['CHECK (private.tags_ok(tags))'])).toBe(true);
  });

  it('列名带双引号（如 "time"）也认', () => {
    expect(boundedBy('time', [`CHECK (("time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))`])).toBe(true);
  });

  it('只是在别的条件里被提到不算；名字是别的列的前缀、后缀也不算', () => {
    expect(boundedBy('raw_text', ["CHECK (((is_private = false) OR (raw_text = ''::text) IS NOT FALSE))"])).toBe(false);
    expect(boundedBy('raw_text', ["CHECK ((raw_text IS NOT NULL))"])).toBe(false);
    expect(boundedBy('qa_probe', ['CHECK ((qa_probe IS NOT NULL))'])).toBe(false);
    expect(boundedBy('note', ['CHECK ((char_length(notes) <= 2000))'])).toBe(false);
    expect(boundedBy('key', ['CHECK ((char_length(api_key) <= 80))'])).toBe(false);
    expect(boundedBy('tz', [])).toBe(false);
  });
});

describe('textBoundProblems：名单外没约束、白名单没理由、多余豁免', () => {
  it('都有约束、白名单为空：没有问题', () => {
    expect(textBoundProblems([], {})).toEqual([]);
  });

  it('名单外没约束的列报出表名、列名（TC-B1-147 ②⑥）', () => {
    expect(textBoundProblems(['public.settings.key'], {})).toEqual([
      'public.settings.key：客户端可写的文本列没有长度或取值约束（TC-B1-147；要么加 check，要么进 TEXT_COLS_UNBOUNDED 并写理由）',
    ]);
  });

  it('白名单里有理由的列放行', () => {
    expect(textBoundProblems(['public.todos.fv'], { 'public.todos.fv': '只由 apply_patch 写' })).toEqual([]);
  });

  it('白名单项没写理由（TC-B1-147 ⑤）', () => {
    expect(textBoundProblems(['public.todos.fv'], { 'public.todos.fv': ' ' })).toEqual(['TEXT_COLS_UNBOUNDED 的 public.todos.fv 没写理由']);
  });

  it('白名单里的列已经有约束：多余豁免要删（TC-B1-147 ⑦ 把 9 列中的一列加进白名单）', () => {
    expect(textBoundProblems([], { 'public.todos.qa_probe': '演示用的豁免' })).toEqual([
      'TEXT_COLS_UNBOUNDED 的 public.todos.qa_probe 已经有约束或不是客户端可写的文本列，从白名单删掉',
    ]);
  });
});

// TC-B1-147 ⑦（架构 0.47 续 ①“补”的 9 列）：这 9 列一列都不准进白名单。
// 真库一侧“去掉任一列的约束 D1 报出”见 supabase/tests/d1-fixtures/34_drop_nine_col_check.psql（逐列各一行 expect）。
describe('补的 9 列：一列都不进 D1 白名单（TC-B1-147 ⑦）', () => {
  it('不准豁免的名单正好是这 9 列', () => {
    expect([...NEVER_EXEMPT].sort()).toEqual([
      'public.categories.color', 'public.devices.app_version', 'public.devices.label', 'public.events.tz', 'public.note_files.mime',
      'public.note_files.sha256', 'public.note_images.mime', 'public.notes.converted_to', 'public.settings.key',
    ]);
  });

  it('现在的 TEXT_COLS_UNBOUNDED 里没有这 9 列中的任何一列', async () => {
    const { TEXT_COLS_UNBOUNDED } = await import('../../build/d1/whitelist.ts');
    expect(NEVER_EXEMPT.filter((c) => Object.hasOwn(TEXT_COLS_UNBOUNDED, c))).toEqual([]);
  });

  it.each(NEVER_EXEMPT)('%s 有约束、却加进白名单：报不准豁免和多余豁免', (c) => {
    const ps = textBoundProblems([], { [c]: '有人想豁免这一列' });
    expect(ps).toContain(`TEXT_COLS_UNBOUNDED 的 ${c} 不准豁免（架构 0.47 续 ①：这 9 列都是客户端写的，一列都不进白名单，必须有约束）`);
    expect(ps).toContain(`TEXT_COLS_UNBOUNDED 的 ${c} 已经有约束或不是客户端可写的文本列，从白名单删掉`);
  });

  it.each(NEVER_EXEMPT)('%s 去掉约束、同时加进白名单（写了理由）想放行：照样报错', (c) => {
    expect(textBoundProblems([c], { [c]: '有人想豁免这一列' })).toEqual([
      `TEXT_COLS_UNBOUNDED 的 ${c} 不准豁免（架构 0.47 续 ①：这 9 列都是客户端写的，一列都不进白名单，必须有约束）`,
    ]);
  });

  it.each(NEVER_EXEMPT)('%s 去掉约束、不进白名单：报没有约束', (c) => {
    expect(textBoundProblems([c], {})).toEqual([`${c}：客户端可写的文本列没有长度或取值约束（TC-B1-147；要么加 check，要么进 TEXT_COLS_UNBOUNDED 并写理由）`]);
  });
});