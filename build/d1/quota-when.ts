// D1（R-271，迁移 20261030120000_core_settings_quota_ai_keys.sql）：挂 private.row_quota() 的配额触发器不准被放宽。
// • public.settings 上正好一个，WHEN 条件正好是 new.key not in ('ai.enabled', 'ai.vault')：撤回 AI 同意（record_consent 写 ai.enabled）
//   和关掉隐私记 AI（ai.vault = false）满额时也要做得到，除此以外一个键都不放（改成 like 'ai.%'、多加键、加 or、去掉条件以外的任何写法都报）；
// • 其余表的配额触发器一律不带 WHEN；
// • 全部是 before insert for each row（tgtype = 7）、平时触发（tgenabled 'O' 或 'A'）：改成 after、只管 update、被 disable 也等于放宽。
// “挂在哪些表”由 checks.ts 原有的 trigTables('row_quota') 核对，这里不重复。
// 纯函数 checkQuotaWhen 单独导出给 tests/build/d1-settings-quota.test.ts 逐条证明；真库一侧的违规样例是 supabase/tests/d1-fixtures/28_settings_quota_when.psql
import { sqlNorm } from './auth-guard.ts';
import type { Query } from './checks.ts';

/** 满额也放行的键：只准正好这两个（R-271） */
export const QUOTA_EXEMPT_KEYS: readonly string[] = ['ai.enabled', 'ai.vault'];
const SETTINGS = 'public.settings';
/** tgtype：ROW 1 + BEFORE 2 + INSERT 4 */
const BEFORE_INSERT_ROW = 7;

/** t = schema.表；def = 带 WHEN 时的 pg_get_triggerdef（tgqual 为空时是 null） */
export interface QuotaTrigRow { t: string; name: string; ty: number | string; en: string; def: string | null }

/** pg_get_triggerdef 里 WHEN (…) 的内容；没有 WHEN 是 null */
function whenOf(def: string | null): string | null {
  if (def === null) return null;
  return /\sWHEN\s+\(([\s\S]*)\)\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s/i.exec(def)?.[1] ?? def;
}

/** 规范化后必须是 new.key <> all(array['…', '…'])（not in 反解析出来的样子），字面量正好是 QUOTA_EXEMPT_KEYS。
 *  先在原文上查类型转换：只准出现 '字面量'::text（not in 原样反解析就是这样）。sqlNorm 去转换会把 (new.key)::character(1)、
 *  'ai.enabled'::character varying(2) 也抹掉——前者让 key 只剩 1 个字、后者把字面量截成 'ai'，比较的已不是原来的两个键 */
function exemptOk(when: string | null): boolean {
  if (when === null) return false;
  if (when.replace(/'(?:[^']|'')*'::text\b(?!\s*\[)/g, "''").includes('::')) return false;
  const m = /^new\.key<>allarray\[('(?:[^']|'')*'(?:,'(?:[^']|'')*')*)\]$/.exec(sqlNorm(when, { casts: true, parens: true }));
  if (!m?.[1]) return false;
  const lits = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => (x[1] ?? '').replace(/''/g, "'")).sort();
  return lits.length === QUOTA_EXEMPT_KEYS.length && lits.every((k, i) => k === [...QUOTA_EXEMPT_KEYS].sort()[i]);
}

/** 挂 row_quota() 的全部触发器 → 问题列表 */
export function checkQuotaWhen(rows: readonly QuotaTrigRow[]): string[] {
  const out: string[] = [];
  const want = `new.key not in (${QUOTA_EXEMPT_KEYS.map((k) => `'${k}'`).join(', ')})`;
  for (const r of rows) {
    const when = whenOf(r.def);
    if (Number(r.ty) !== BEFORE_INSERT_ROW) out.push(`${r.t} 的配额触发器 ${r.name} 不是 before insert for each row（tgtype = ${r.ty}），配额等于被放宽（R-271）`);
    if (r.en !== 'O' && r.en !== 'A') out.push(`${r.t} 的配额触发器 ${r.name} 平时不触发（tgenabled = '${r.en}'），配额等于被关掉（R-271）`);
    if (r.t === SETTINGS) {
      if (!exemptOk(when)) out.push(`${SETTINGS} 的配额触发器 ${r.name} 的 WHEN 条件不是正好 ${want}（实际：${when ?? '没有条件'}；R-271：只放行这两个键）`);
    } else if (when !== null) {
      out.push(`${r.t} 的配额触发器 ${r.name} 带了 WHEN 条件（${when}），row_quota() 只准 ${SETTINGS} 带（R-271）`);
    }
  }
  const n = rows.filter((r) => r.t === SETTINGS).length;
  if (n !== 1) out.push(`${SETTINGS} 上挂 row_quota() 的触发器有 ${n} 个，应该正好 1 个（R-271）`);
  return out;
}

/** 查库再判定（checks.ts 的 runD1 调） */
export async function quotaWhenProblems(q: Query): Promise<string[]> {
  const rows = await q<QuotaTrigRow>(`select n.nspname || '.' || c.relname as t, t.tgname as name, t.tgtype::int as ty, t.tgenabled::text as en,
      case when t.tgqual is null then null else pg_get_triggerdef(t.oid) end as def
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal and pn.nspname = 'private' and p.proname = 'row_quota'`);
  return checkQuotaWhen(rows);
}
