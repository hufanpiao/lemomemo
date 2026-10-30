// D1 第 11c 节用（架构 0.47 第 20 条 ③；TC-B1-147）：一列文本有没有被某条 check 约束“限住”。
// 只认这几种写法（pg_get_constraintdef 的输出；列名可能带双引号，如 "time"）：
//   char_length / length / octet_length / cardinality / pg_column_size(列)、octet_length((列)::text) —— 长度、个数、大小上限；
//   (列 = ANY (ARRAY[…])) —— 取值清单；整条约束是 (列 = '常量') —— 只许一个值；整条约束是 (列 = CASE … END) —— 按别的列查表（如 note_files.mime 按 kind）；
//   (列 ~ '…') —— 格式；(列 = (…)) —— 等于一个拼出来的值（如 path）；private.函数(列) —— 逐项检查（如 tags_ok）。
// 只是在别的条件里被提到（如 notes 的隐私记那条整表 check 里的 raw_text = ''）不算。
// 正反例在 tests/build/d1-text-bounds.test.ts。

import type { Query } from './checks.ts';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** defs：这张表全部 check 约束的定义文字 */
export function boundedBy(col: string, defs: readonly string[]): boolean {
  const id = `(?:${esc(col)}|"${esc(col)}")`;
  const pats = [
    new RegExp(`\\b(?:char_length|length|octet_length|cardinality|pg_column_size)\\(${id}\\)`),
    // jsonb 按文字形式量大小：octet_length(col::text) 输出为 octet_length((col)::text)（notes.converted_to，安全审查 10-31）
    new RegExp(`\\boctet_length\\(\\(${id}\\)::text\\)`),
    new RegExp(`\\(${id} = ANY \\(`),
    new RegExp(`\\(${id} ~ '`),
    new RegExp(`\\(${id} = \\(`),
    // 单个值、CASE 查表只认“整条约束就是这一句”：别的条件里顺带写的 (raw_text = ''::text) 这种不算。
    // pg_get_constraintdef 会在 CASE 前面换行
    new RegExp(`^CHECK \\(\\(${id} = '[^']*'::text\\)\\)$`),
    new RegExp(`^CHECK \\(\\(${id} =\\s+CASE\\s[\\s\\S]*\\bEND\\)\\)$`),
    new RegExp(`\\bprivate\\.\\w+\\(${id}\\)`),
  ];
  return defs.some((d) => pats.some((p) => p.test(d)));
}

/** 架构 0.47 续 ①“补”的 9 列：客户端写的列，一列都不准进 TEXT_COLS_UNBOUNDED（TC-B1-147 ⑦） */
export const NEVER_EXEMPT: readonly string[] = [
  'public.categories.color', 'public.devices.label', 'public.devices.app_version', 'public.events.tz', 'public.note_files.mime',
  'public.note_files.sha256', 'public.note_images.mime', 'public.notes.converted_to', 'public.settings.key',
];

/**
 * D1 第 11c 节的判定：unbounded 是查出来没约束的列（public.表.列），whitelist 是 TEXT_COLS_UNBOUNDED。
 * 名单外的没约束列、没写理由的豁免、已经有约束（或不再是客户端可写文本列）的豁免都报
 */
export function textBoundProblems(unbounded: readonly string[], whitelist: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const k of NEVER_EXEMPT) {
    if (Object.hasOwn(whitelist, k)) out.push(`TEXT_COLS_UNBOUNDED 的 ${k} 不准豁免（架构 0.47 续 ①：这 9 列都是客户端写的，一列都不进白名单，必须有约束）`);
  }
  for (const k of unbounded) {
    if (!Object.hasOwn(whitelist, k)) out.push(`${k}：客户端可写的文本列没有长度或取值约束（TC-B1-147；要么加 check，要么进 TEXT_COLS_UNBOUNDED 并写理由）`);
  }
  for (const [k, why] of Object.entries(whitelist)) {
    if (why.trim().length < 4) out.push(`TEXT_COLS_UNBOUNDED 的 ${k} 没写理由`);
    if (!unbounded.includes(k)) out.push(`TEXT_COLS_UNBOUNDED 的 ${k} 已经有约束或不是客户端可写的文本列，从白名单删掉`);
  }
  return out;
}

/**
 * D1 第 11c 节（从 checks.ts 挪来，max-lines）：查 public 下 authenticated 能 insert 或 update 的 text、text[]、varchar、jsonb、json 列，
 * 只看同步表（syncNames），按这张表的 check 约束（cons 里 d 以 CHECK 开头的）判定有没有被限住，再和白名单比。
 */
export async function textColProblems(q: Query, syncNames: readonly string[], cons: readonly { s: string; t: string; d: string }[],
  whitelist: Readonly<Record<string, string>>): Promise<string[]> {
  const textCols = await q<{ t: string; c: string }>(`select c.table_name as t, c.column_name as c from information_schema.columns c
    where c.table_schema = 'public' and c.udt_name in ('text', '_text', 'varchar', '_varchar', 'jsonb', 'json')
      and (has_column_privilege('authenticated', format('public.%I', c.table_name)::regclass, c.column_name, 'INSERT')
        or has_column_privilege('authenticated', format('public.%I', c.table_name)::regclass, c.column_name, 'UPDATE'))`);
  const unbounded = textCols.filter((r) => syncNames.includes(r.t))
    .filter((r) => !boundedBy(r.c, cons.filter((k) => k.s === 'public' && k.t === r.t && k.d.startsWith('CHECK')).map((k) => k.d)))
    .map((r) => `public.${r.t}.${r.c}`);
  return textBoundProblems(unbounded, whitelist);
}