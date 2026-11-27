// rls 测试的第二道防线（11-05 审查 S1、复审 R1、审查 M3）：每个 supabase/tests/rls/*.test.sql
//   ① begin; 之前只许空行和 -- 注释（写在 begin 之前的语句在自动提交下先执行，检查段拦不到）；
//   ② 独占一行的 begin; 恰好一个；独占一行的 commit、abort、end transaction / end work 不许出现，rollback; 只许是最后一句；
//      （plpgsql 函数体里的 end; 和事务的 end; 在文本上分不出来，不查）
//   ③ begin;（可带 select plan(n);）之后的第一句是 \ir _helpers.psql 或 \ir _target.psql；
//   ④ 两份检查段逐字一致，raise exception 那一行钉死（改成 raise notice 就不再中止事务）。
// 否则手敲 supabase test db 打到 lemomemo 时，那个文件照样跑。lemo.test_target 是数据库级参数，会话里谁都能 set 掉：只防手误、不防故意。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'tests', 'rls');
const read = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
const CHECK = new RegExp([
  String.raw`do \$\$ begin\n`,
  String.raw` {2}if coalesce\(current_setting\('lemo\.test_target', true\), ''\) not in \('ci', 'e2e', 'offline'\) then\n`,
  String.raw` {4}raise exception 'rls 测试只许打 CI、lemo-e2e 或离线库[^'\n]*';\n`,
  String.raw` {2}end if;\n`,
  String.raw`end \$\$;\n`,
].join(''));

const BEGIN = /^begin;$/i;
const TX_END = /^(commit|abort)\b|^end\s+(transaction|work)\b|^rollback\b/i;

/** begin; 之后、跳过空行、注释和 select plan(n); 的第一句 */
export function firstAfterBegin(sql: string): string | null {
  const lines = sql.replace(/\r\n/g, '\n').split('\n');
  const b = lines.findIndex((l) => BEGIN.test(l.trim()));
  if (b === -1) return null;
  for (const l of lines.slice(b + 1)) {
    const t = l.trim();
    if (t === '' || t.startsWith('--') || /^select plan\(\d+\);$/i.test(t)) continue;
    return t;
  }
  return null;
}

/** 事务结构的问题（空 = 合格）：begin 前只有注释、恰好一个 begin;、没有 commit 等、rollback; 只在最后 */
export function txProblems(sql: string): string[] {
  const lines = sql.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const out: string[] = [];
  const begins = lines.flatMap((l, i) => (BEGIN.test(l) ? [i] : []));
  if (begins.length !== 1) out.push(`独占一行的 begin; 有 ${begins.length} 个`);
  const b = begins[0] ?? lines.length;
  const before = lines.slice(0, b).find((l) => l !== '' && !l.startsWith('--'));
  if (before !== undefined) out.push(`begin 之前有语句：${before.slice(0, 40)}`);
  const code = lines.map((l, i) => [l, i] as const).filter(([l]) => l !== '' && !l.startsWith('--'));
  const lastIdx = code.at(-1)?.[1] ?? -1;
  for (const [l, i] of code) {
    if (!TX_END.test(l)) continue;
    if (/^rollback;$/i.test(l) && i === lastIdx) continue;
    out.push(`第 ${i + 1} 行结束了事务：${l.slice(0, 40)}`);
  }
  if (!/^rollback;$/i.test(lines[lastIdx] ?? '')) out.push('最后一句不是 rollback;');
  return out;
}

describe('rls 测试文件都先过标记检查', () => {
  it('_helpers.psql 和 _target.psql 的检查段逐字一致（含 raise exception），_target.psql 只有这一段', () => {
    const h = CHECK.exec(read('_helpers.psql'))?.[0];
    const t = read('_target.psql');
    expect(h).toBeTruthy();
    expect(CHECK.exec(t)?.[0]).toBe(h);
    expect(t.replace(CHECK, '').split('\n').every((l) => l.trim() === '' || l.trim().startsWith('--'))).toBe(true);
  });
  it('CHECK：改成 raise notice、改掉放行名单、少了 end if 都对不上', () => {
    const t = read('_target.psql');
    expect(CHECK.test(t.replace('raise exception', 'raise notice'))).toBe(false);
    expect(CHECK.test(t.replace("('ci', 'e2e', 'offline')", "('ci', 'e2e', 'offline', '')"))).toBe(false);
    expect(CHECK.test(t.replace('  end if;\n', ''))).toBe(false);
  });
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.sql')).sort();
  it('有测试文件', () => expect(files.length > 30).toBe(true));
  for (const f of files) {
    it(`${f}：begin 之前只有注释、一个 begin、不中途结束事务；begin 之后第一句引 _helpers.psql 或 _target.psql`, () => {
      const sql = read(f);
      expect(txProblems(sql)).toEqual([]);
      expect(['\\ir _helpers.psql', '\\ir _target.psql']).toContain(firstAfterBegin(sql));
    });
  }
  it('firstAfterBegin：先写别的语句、没有 begin 都不算', () => {
    expect(firstAfterBegin('begin;\nselect plan(3);\ndelete from x;\n\\ir _target.psql\n')).toBe('delete from x;');
    expect(firstAfterBegin('select plan(1);\n\\ir _helpers.psql\n')).toBe(null);
    expect(firstAfterBegin('begin;\r\n-- 注释\r\nselect plan(2);\r\n\\ir _target.psql\r\n')).toBe('\\ir _target.psql');
  });
  it('txProblems：begin 前有语句、两个 begin、中途 commit、没有 rollback 都报', () => {
    const ok = '-- 注释\nbegin;\nselect plan(1);\n\\ir _target.psql\nselect 1;\nrollback;\n';
    expect(txProblems(ok)).toEqual([]);
    expect(txProblems(`delete from x;\n${ok}`).join()).toMatch(/begin 之前/);
    expect(txProblems(ok.replace('select 1;', 'select 1;\nbegin;')).join()).toMatch(/2 个/);
    for (const bad of ['commit;', 'COMMIT WORK;', 'end transaction;', 'abort;', 'rollback;']) {
      expect(txProblems(ok.replace('select 1;', `select 1;\n${bad}`)).join(), bad).toMatch(/结束了事务/);
    }
    expect(txProblems(ok.replace('rollback;\n', '')).join()).toMatch(/rollback/);
    expect(txProblems('begin;\n\\ir _target.psql\n')).not.toEqual([]);
  });
});
