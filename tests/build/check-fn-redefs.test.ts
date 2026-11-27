// build/check_fn_redefs.py（check_backend 的 M7；后端安全审查第 9 条）：迁移里整段重写的函数，最新一版不能丢上一版的 delete 和表名。
// 样例放临时目录（两份迁移：上一版、最新一版），真仓库 0 个错误；check_backend 把它当 M7 一起跑。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'build', 'check_fn_redefs.py');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('python', ['-I', SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    const x = e as { status: number; stdout: string };
    return { code: x.status, out: x.stdout };
  }
}

const fn = (body: string) => `create or replace function private.cleanup_batch(p_limit int default 1000) returns int language plpgsql set search_path = '' as $$
begin
${body}
  return 0;
end $$;
`;

function fixture(prev: string, last: string): string {
  const root = mkdtempSync(join(tmpdir(), 'fn-redefs-'));
  dirs.push(root);
  const mig = join(root, 'supabase', 'migrations');
  mkdirSync(mig, { recursive: true });
  writeFileSync(join(mig, '20260101000000_a.sql'), fn(prev));
  writeFileSync(join(mig, '20260102000000_b.sql'), `-- 最新一版\n${fn(last)}`);
  return root;
}

const PREV = `  delete from public.events where deleted_at < 1;
  delete from public.todo_items where deleted_at < 1;
  perform 1 from private.counters c where c.key = 'x';`;

describe('check_fn_redefs.py', () => {
  it('最新一版漏了上一版的 delete from public.todo_items：报 M7，写明哪个函数、哪张表、上一版是哪份', () => {
    const r = run(['--root', fixture(PREV, PREV.replace('  delete from public.todo_items where deleted_at < 1;\n', ''))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('错误 M7 supabase/migrations/20260102000000_b.sql:2 private.cleanup_batch 最新一版没有 delete from public.todo_items（上一版 20260101000000_a.sql 有）');
  });
  it('最新一版不再出现上一版用过的表（private.counters）：报 M7', () => {
    const r = run(['--root', fixture(PREV, PREV.replace("  perform 1 from private.counters c where c.key = 'x';", ''))]);
    expect([r.code, r.out]).toEqual([1, expect.stringContaining('private.cleanup_batch 最新一版不再出现 private.counters')]);
  });
  it('只多不少、注释里的表名不算：0 个错误', () => {
    const r = run(['--root', fixture(`${PREV}\n  -- delete from public.ghost where 1 = 1;`, `${PREV}\n  delete from public.devices where deleted_at < 1;`)]);
    expect([r.code, r.out.trim()]).toEqual([0, 'check_fn_redefs：0 个错误']);
  });
  it('真仓库：0 个错误（cleanup_batch 最新一版有 todo_items 那句）', () => {
    const r = run([]);
    expect([r.code, r.out.trim()]).toEqual([0, 'check_fn_redefs：0 个错误']);
  });
});
