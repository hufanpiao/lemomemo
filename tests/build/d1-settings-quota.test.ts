// D1 R-271（build/d1/quota-when.ts checkQuotaWhen；迁移 20261030120000_core_settings_quota_ai_keys.sql）：
// 挂 row_quota() 的配额触发器不准被放宽——settings_quota 的 WHEN 正好放行 ai.enabled、ai.vault 两个键，别的表不带 WHEN，
// 全部是 before insert for each row、平时触发。真库一侧“放宽成 ai.* 前缀”由 supabase/tests/d1-fixtures/28_settings_quota_when.psql 证明；
// 其余写法（多加键、少一个、加 or、去掉条件、换时机、disable、别的表带 WHEN、挂两个）在这里逐条证明。
// defs 照离线 PGlite 上 pg_get_triggerdef 的真实输出写（not in 反解析成 <> ALL (ARRAY[…])）
import { describe, expect, it } from 'vitest';
import { checkQuotaWhen, QUOTA_EXEMPT_KEYS, type QuotaTrigRow } from '../../build/d1/quota-when.ts';

const def = (when: string, tbl = 'settings', name = 'settings_quota') =>
  `CREATE TRIGGER ${name} BEFORE INSERT ON public.${tbl} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION private.row_quota()`;
const keysWhen = (...keys: string[]) => `(new.key <> ALL (ARRAY[${keys.map((k) => `'${k}'::text`).join(', ')}]))`;
const settings: QuotaTrigRow = { t: 'public.settings', name: 'settings_quota', ty: 7, en: 'O', def: def(keysWhen('ai.enabled', 'ai.vault')) };
const notes: QuotaTrigRow = { t: 'public.notes', name: 'notes_quota', ty: 7, en: 'O', def: null };
const logs: QuotaTrigRow = { t: 'public.logs', name: 'logs_quota', ty: 7, en: 'O', def: null };
const ok = [settings, notes, logs];
const with_ = (s: Partial<QuotaTrigRow>) => [{ ...settings, ...s }, notes, logs];

describe('D1：配额触发器不准放宽（build/d1/quota-when.ts checkQuotaWhen，R-271）', () => {
  it('和迁移 20261030120000 一样 → 通过；两个键换个顺序、tgtype 是字符串、tgenabled = A 也通过', () => {
    expect(QUOTA_EXEMPT_KEYS).toEqual(['ai.enabled', 'ai.vault']);
    expect(checkQuotaWhen(ok)).toEqual([]);
    expect(checkQuotaWhen(with_({ def: def(keysWhen('ai.vault', 'ai.enabled')) }))).toEqual([]);
    expect(checkQuotaWhen(with_({ ty: '7', en: 'A' }))).toEqual([]);
  });

  it('settings_quota 放宽：ai.* 前缀、多一个键、加 or、只剩一个键、键名大小写不同、去掉条件 → 都报', () => {
    const bad = [
      "(new.key !~~ 'ai.%'::text)",
      keysWhen('ai.enabled', 'ai.vault', 'ui.theme'),
      `(${keysWhen('ai.enabled', 'ai.vault')} OR (new.user_id IS NOT NULL))`,
      keysWhen('ai.enabled'),
      keysWhen('AI.enabled', 'ai.vault'),
      keysWhen('ai.enabled', 'ai.vault '),
      '(new.key IS NOT NULL)',
    ];
    for (const w of bad) {
      expect(checkQuotaWhen(with_({ def: def(w) })), w).toEqual([expect.stringContaining('public.settings 的配额触发器 settings_quota 的 WHEN 条件不是正好')]);
    }
    expect(checkQuotaWhen(with_({ def: null }))).toEqual([expect.stringContaining('实际：没有条件')]);
  });

  it('new.key 或字面量带了别的类型转换（::char、::varchar(2)）→ 报（sqlNorm 去转换后看着一样，要在原文上拦）', () => {
    // 下面三条是离线 PGlite 上 pg_get_triggerdef 的真实输出（when 依次写 new.key::char not in (…)、new.key::varchar(2) not in (…)、
    // new.key not in ('ai.enabled'::varchar(2), 'ai.vault')）
    const bad = [
      "((new.key)::character(1) <> ALL (ARRAY['ai.enabled'::bpchar, 'ai.vault'::bpchar]))",
      "(((new.key)::character varying(2))::text <> ALL ((ARRAY['ai.enabled'::character varying, 'ai.vault'::character varying])::text[]))",
      "(new.key <> ALL (ARRAY[('ai.enabled'::character varying(2))::text, 'ai.vault'::text]))",
      "((new.key)::text <> ALL (ARRAY['ai.enabled'::text, 'ai.vault'::text]))",
    ];
    for (const w of bad) {
      expect(checkQuotaWhen(with_({ def: def(w) })), w).toEqual([expect.stringContaining('的 WHEN 条件不是正好')]);
    }
  });

  it('换时机（after insert、只管 update、for each statement）、被 disable → 报', () => {
    for (const ty of [5, 2 | 1 | 16, 6]) expect(checkQuotaWhen(with_({ ty })).join('\n'), String(ty)).toContain('不是 before insert for each row');
    for (const en of ['D', 'R']) expect(checkQuotaWhen(with_({ en })).join('\n'), en).toContain(`平时不触发（tgenabled = '${en}'）`);
    expect(checkQuotaWhen([settings, { ...notes, en: 'D' }, logs])).toEqual([expect.stringContaining('public.notes 的配额触发器 notes_quota 平时不触发')]);
  });

  it('别的表的配额触发器带了 WHEN（哪怕和 settings 一样）→ 报', () => {
    const notesWhen = { ...notes, def: def('(new.title IS NOT NULL)', 'notes', 'notes_quota') };
    expect(checkQuotaWhen([settings, notesWhen, logs])).toEqual([expect.stringContaining('public.notes 的配额触发器 notes_quota 带了 WHEN 条件')]);
    const logsWhen = { ...logs, def: def(keysWhen('ai.enabled', 'ai.vault'), 'logs', 'logs_quota') };
    expect(checkQuotaWhen([settings, notes, logsWhen])).toEqual([expect.stringContaining('只准 public.settings 带')]);
  });

  it('settings 上挂了两个配额触发器（另一个不带条件也不行）、或者一个都没有 → 报', () => {
    expect(checkQuotaWhen([...ok, { ...settings, name: 'settings_quota2', def: null }]).join('\n')).toContain('有 2 个，应该正好 1 个');
    expect(checkQuotaWhen([notes, logs])).toEqual([expect.stringContaining('有 0 个，应该正好 1 个')]);
  });
});
