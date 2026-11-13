// 迁移里给热表加列、改结构之前先 set local lock_timeout（租约出队安全审查 S1、复审建议 R2；代码审查复审 N2）：
// alter table、lock table、建删触发器都要拿强锁，万一有长事务占着表，排队的语句会把所有写这张表（含入队触发器）的用户写入一起堵住；
// 先 set local lock_timeout，5 秒内拿不到锁就失败、整个迁移回滚，等长事务结束再推一次。
// 这条检查钉住：凡是对 HOT_TABLES 里的表 alter table、lock table、create/drop trigger … on 的迁移，第一句这样的语句之前要有 set local lock_timeout。
// 每张表从各自的起算迁移开始管（remind_queue 从租约迁移 20261104130000；四张业务表从 R-411 迁移 20261113100000，
// 之前的迁移如 20261111100500 改 anniversaries 时还没有这条规矩）。迁移文件开头的注释不算。以后别的表也要这样做，加进 HOT_TABLES。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../supabase/migrations');
const REWRITE = '20261113100000';
/** 表 → 从哪份迁移起管（文件名前缀，含这一份） */
const HOT_TABLES: Readonly<Record<string, string>> = {
  'private.remind_queue': '20261104130000',
  'public.settings': REWRITE,
  'public.events': REWRITE,
  'public.todos': REWRITE,
  'public.anniversaries': REWRITE,
};

/** 去掉 -- 注释（不处理字符串里的 --：迁移里改结构的语句不会这样写） */
const stripComments = (sql: string): string => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/** 文件 f 要管的热表 */
const tablesFor = (f: string): string[] => Object.entries(HOT_TABLES).filter(([, since]) => f >= since).map(([t]) => t);

/** 不合格时返回原因，合格返回 null */
export function lockTimeoutProblem(sql: string, tables: readonly string[] = Object.keys(HOT_TABLES)): string | null {
  const s = stripComments(sql);
  const hits = tables.flatMap((t) => {
    const n = t.replace('.', '\\.');
    return [
      new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${n}\\b`, 'i'),
      new RegExp(`\\block\\s+table\\s+(?:only\\s+)?(?:[\\w.]+\\s*,\\s*)*${n}\\b`, 'i'),
      new RegExp(`\\b(?:create|drop)\\s+trigger\\b[^;]*?\\bon\\s+${n}\\b`, 'i'),
    ].map((re) => re.exec(s)).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ t, at: m.index }));
  });
  if (hits.length === 0) return null;
  const first = hits.reduce((a, b) => (a.at <= b.at ? a : b));
  const lt = /\bset\s+local\s+lock_timeout\s*(?:=|to)\s*'\d+(?:ms|s)?'\s*;/i.exec(s);
  if (!lt || lt.index > first.at) return `改 ${first.t} 之前没有 set local lock_timeout`;
  return null;
}

describe('迁移改热表结构之前先 set local lock_timeout', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql') && tablesFor(f).length > 0);
  it('各表起算之后的迁移都合格（租约迁移、R-411 迁移这两份确实被管到）', () => {
    // 不让这条检查空转：去掉那句 set local lock_timeout 就会报
    const lease = readFileSync(join(DIR, '20261104130000_core_remind_queue_lease.sql'), 'utf8');
    expect(lockTimeoutProblem(lease.replace(/set local lock_timeout = '5s';/, ''), tablesFor('20261104130000'))).toMatch(/之前没有/);
    const rw = readFileSync(join(DIR, `${REWRITE}_core_remind_queue_rewrite.sql`), 'utf8');
    expect(lockTimeoutProblem(rw.replace(/set local lock_timeout = '5s';/, ''), tablesFor(REWRITE))).toMatch(/改 public\.settings 之前没有/);
    for (const f of files) expect(lockTimeoutProblem(readFileSync(join(DIR, f), 'utf8'), tablesFor(f)), f).toBeNull();
  });
  it('起算之前的迁移不管：20261111100500 改了 anniversaries、没写 lock_timeout，也不报', () => {
    expect(tablesFor('20261111100500_x.sql')).toEqual(['private.remind_queue']);
  });
  it('反例：没写、写在后面、只写在注释里、不带 local；lock table、建删触发器也算', () => {
    const alter = 'alter table private.remind_queue add column x int;';
    expect(lockTimeoutProblem(alter)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`${alter}\nset local lock_timeout = '5s';`)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`-- set local lock_timeout = '5s';\n${alter}`)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`set lock_timeout = '5s';\n${alter}`)).toMatch(/之前没有/);
    expect(lockTimeoutProblem(`ALTER TABLE IF EXISTS private.remind_queue add column x int;`)).toMatch(/之前没有/);
    expect(lockTimeoutProblem('alter table public.todos add column x int;')).toMatch(/改 public\.todos 之前没有/);
    expect(lockTimeoutProblem('lock table public.settings, public.events in access exclusive mode;')).toMatch(/之前没有/);
    expect(lockTimeoutProblem('drop trigger if exists todos_remind on public.todos;')).toMatch(/改 public\.todos 之前没有/);
    expect(lockTimeoutProblem('create trigger x after insert or update on public.anniversaries for each row execute function f();')).toMatch(/之前没有/);
  });
  it('正例：写在前面；不碰热表的迁移不管；别的表上建触发器不算', () => {
    expect(lockTimeoutProblem(`set local lock_timeout = '5s';\nalter table private.remind_queue add column x int;`)).toBeNull();
    expect(lockTimeoutProblem(`SET LOCAL lock_timeout TO '3000ms';\nlock table public.todos in access exclusive mode;`)).toBeNull();
    expect(lockTimeoutProblem('alter table public.vault_items add column x int;')).toBeNull();
    expect(lockTimeoutProblem('create trigger x after update on public.vault_items for each row execute function f();\nselect 1 from public.todos;')).toBeNull();
  });
});
