// 迁移里给热表加列、改结构之前先 set local lock_timeout（租约出队安全审查 S1、复审建议 R2；代码审查复审 N2）：
// alter table 要拿 AccessExclusive 锁，万一有长事务占着表，排队的 alter 会把所有写这张表（含入队触发器）的用户写入一起堵住；
// 先 set local lock_timeout，5 秒内拿不到锁就失败、整个迁移回滚，等长事务结束再推一次。
// 这条检查钉住：凡是 alter table HOT_TABLES 里的表的迁移，第一句这样的 alter 之前要有 set local lock_timeout（迁移 20261104130000 起）。
// 迁移文件开头的注释不算。以后别的表也要这样做，加进 HOT_TABLES。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../supabase/migrations');
const HOT_TABLES = ['private.remind_queue'];
const SINCE = '20261104130000';

/** 去掉 -- 注释（不处理字符串里的 --：迁移里改结构的语句不会这样写） */
const stripComments = (sql: string): string => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/** 不合格时返回原因，合格返回 null */
export function lockTimeoutProblem(sql: string, tables: readonly string[] = HOT_TABLES): string | null {
  const s = stripComments(sql);
  const alters = tables.map((t) => {
    const re = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${t.replace('.', '\\.')}\\b`, 'i');
    const m = re.exec(s);
    return m ? { t, at: m.index } : null;
  }).filter((x): x is { t: string; at: number } => x !== null);
  if (alters.length === 0) return null;
  const first = alters.reduce((a, b) => (a.at <= b.at ? a : b));
  const lt = /\bset\s+local\s+lock_timeout\s*(?:=|to)\s*'\d+(?:ms|s)?'\s*;/i.exec(s);
  if (!lt || lt.index > first.at) return `alter table ${first.t} 之前没有 set local lock_timeout`;
  return null;
}

describe('迁移改热表结构之前先 set local lock_timeout', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f >= SINCE);
  it('20261104130000 起的迁移都合格（至少检查到租约迁移这一份）', () => {
    // 不让这条检查空转：租约迁移确实改了 remind_queue（去掉它那句 set local lock_timeout 就会报）
    const lease = readFileSync(join(DIR, '20261104130000_core_remind_queue_lease.sql'), 'utf8');
    expect(lockTimeoutProblem(lease.replace(/set local lock_timeout = '5s';/, ''))).toMatch(/之前没有/);
    for (const f of files) expect(lockTimeoutProblem(readFileSync(join(DIR, f), 'utf8')), f).toBeNull();
  });
  it('反例：没写、写在 alter 之后、只写在注释里、不带 local，都报', () => {
    const alter = 'alter table private.remind_queue add column x int;';
    expect(lockTimeoutProblem(alter)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`${alter}\nset local lock_timeout = '5s';`)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`-- set local lock_timeout = '5s';\n${alter}`)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`set lock_timeout = '5s';\n${alter}`)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`ALTER TABLE IF EXISTS private.remind_queue add column x int;`)).toMatch(/之前没有/);
  });
  it('正例：写在前面；不碰热表的迁移不管', () => {
    expect(lockTimeoutProblem(`set local lock_timeout = '5s';\nalter table private.remind_queue add column x int;`)).toBeNull();
    expect(lockTimeoutProblem(`SET LOCAL lock_timeout TO '3000ms';\nalter table private.remind_queue add column x int;`)).toBeNull();
    expect(lockTimeoutProblem('alter table public.todos add column x int;')).toBeNull();
  });
});
