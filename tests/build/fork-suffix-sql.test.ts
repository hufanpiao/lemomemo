// K8 实现方案第九节：冲突副本后缀在两处各写一份——shared/sync/fork-suffix-data.ts 的 FORK_SUFFIX（前端、假服务器用）、
// 迁移 20261105100000 里 apply_patch 的 SQL 字面量（服务器写副本标题用）。这里逐字比对，像平台名那样锁住，防两边走样。
// K8 方案评审 R3：读新迁移（旧迁移 20261029200000 里还留着当时的“（冲突副本）”和 154，不算数），并确认它就是最后一个定义 apply_patch 的迁移。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORK_SUFFIX } from '../../shared/sync/fork-suffix-data.ts';

const DIR = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const MIG = '20261105100000_core_apply_patch_fork_suffix.sql';
/** 去掉 -- 注释（这份迁移的字符串里没有 --） */
const code = (f: string) => readFileSync(join(DIR, f), 'utf8').split('\n').map((l) => l.replace(/--.*$/u, '')).join('\n');

describe('冲突副本后缀：SQL 字面量和 FORK_SUFFIX 一字不差', () => {
  const sql = code(MIG);
  const m = /sfx := case \(select p\.ui_locale from public\.profiles p where p\.user_id = \(select auth\.uid\(\)\)\)\s+when '([^']+)' then '([^']*)'\s+else '([^']*)'\s+end;/u.exec(sql);

  it('迁移里按 ui_locale 选后缀：只有 ko-KR 一个分支，其余（含取不到）都走中文', () => {
    expect(m, '没找到 sfx := case … 那一句').not.toBeNull();
    expect(m?.[1]).toBe('ko-KR');
    expect(sql.match(/\bwhen '[^']+' then '/gu)).toHaveLength(1);
  });

  it('两个字面量逐字等于 FORK_SUFFIX（韩文前面半角空格、半角括号，8 个字符；中文 6 个字符）', () => {
    expect(m?.[2]).toBe(FORK_SUFFIX['ko-KR']);
    expect(m?.[3]).toBe(FORK_SUFFIX['zh-CN']);
    expect(FORK_SUFFIX['ko-KR']).toBe(' (충돌 사본)');
    expect([...FORK_SUFFIX['ko-KR']]).toHaveLength(8);
    expect([...FORK_SUFFIX['zh-CN']]).toHaveLength(6);
  });

  it('FORK_SUFFIX 的语言正好是 profiles.ui_locale 允许的两个值', () => {
    const core = code('0001_core.sql');
    const allowed = /ui_locale text not null default 'zh-CN' check \(ui_locale in \(([^)]*)\)\)/u.exec(core)?.[1];
    expect(allowed?.split(',').map((x) => x.trim().replace(/'/gu, '')).sort()).toEqual(Object.keys(FORK_SUFFIX).sort());
  });

  it('截断长度跟着后缀算（160 - char_length(sfx)），不再写死 154；后缀只接一次', () => {
    expect(sql).toContain(", 160 - char_length(sfx)) || sfx,");
    expect(sql).not.toMatch(/\b154\b/u);
    expect(sql).not.toContain("|| '（冲突副本）'");
  });

  it('新迁移是最后一个定义 public.apply_patch 的迁移（之后再改要同步这条测试）', () => {
    const defs = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => /create (or replace )?function public\.apply_patch\(/u.test(code(f)));
    expect(defs.at(-1)).toBe(MIG);
  });
});
