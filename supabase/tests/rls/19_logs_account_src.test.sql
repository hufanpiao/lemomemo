-- logs 的 ins 策略不准客户端写 src = 'account'（迁移 20261030100000_core_logs_ins_no_account_src.sql，R-259）
-- “设置 › 账号 › 最近的导出”只认 src = 'account' 的行（account 函数经 service role 写）；客户端能写的话就能伪造导出记录
-- 原有条件照旧：本人、账号可用（停用的 C 写不进）；别的 src、src 为 null 照常能写；service role 写 src = 'account' 照常成功
begin;
select plan(13);
\ir _helpers.psql
select tests.seed();   -- A、B 正常，C 停用

create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
create function tests.n(p_src text) returns int language sql as $$
  select count(*)::int from public.logs where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and src is not distinct from p_src
$$;

-- ===== authenticated：src = 'account' 一律被拒 =====
select ok(tests.a($$insert into public.logs (t, kind, act, src) values (1, 'run', 'export', 'account')$$) like '42501 %row-level security%',
  'A 以 authenticated 插 src = account、act = export：被 RLS 拒（42501）');
select ok(tests.a($$insert into public.logs (t, kind, act, src, code) values (2, 'run', 'export_mail_failed', 'account', '2026-10-30T00:00:00.000Z')$$) like '42501 %row-level security%',
  'A 插 src = account、act = export_mail_failed：同样被拒');
select ok(tests.a($$insert into public.logs (t, kind, act, src) values (3, 'run', 'x', 'sync'), (4, 'run', 'export', 'account')$$) like '42501 %row-level security%',
  '一批里混一条 src = account：整批被拒');
select is(tests.n('account'), 0, '被拒以后 A 名下没有 src = account 的行');

-- ===== authenticated：别的 src、src 为 null 照常 =====
select is(tests.a($$insert into public.logs (t, kind, act, src) values (5, 'run', 'x', 'sync')$$), 'ok', 'A 插 src = sync：成功');
select is(tests.a($$insert into public.logs (t, kind, act) values (6, 'run', 'x')$$), 'ok', 'A 插不带 src（null，客户端 LogRow 的写法）：成功（is distinct from 放行 null）');
select is(tests.n('sync') || '|' || tests.n(null), '1|1', 'A 名下 src = sync、src 为 null 各一行');

-- ===== 原有条件不变：停用的 C 写不进 =====
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$insert into public.logs (t, kind, act, src) values (7, 'run', 'x', 'sync')$$) like '42501 %row-level security%',
  '停用的 C 插 src = sync：照旧被拒（private.is_active() 那一条没丢）');

-- ===== service role：src = 'account' 照常成功（account 函数的写法：带 user_id） =====
select is(tests.try_as('service_role', null, $$insert into public.logs (user_id, t, device, kind, act, src) values ('aaaaaaaa-0000-4000-8000-000000000001', 8, null, 'run', 'export', 'account')$$),
  'ok', 'service role 替 A 插 src = account、act = export：成功');
select is(tests.n('account'), 1, 'A 名下 src = account 只有 service role 写的那一行');

-- ===== 守门（R259-sugg ②）：以后重写 logs 的 ins 策略也得留着这一条 =====
-- 只看库里最终生效的策略（pg_policies），不比迁移源码：新迁移 alter / drop + create 都逃不过；
-- 另加一个 permissive 的 insert 策略会和 ins 按 OR 合并、把这一条绕过去，所以 insert 策略只许 ins 一个
select is((select string_agg(policyname || '/' || permissive || '/' || array_to_string(roles, ','), ' ' order by policyname)
             from pg_policies where schemaname = 'public' and tablename = 'logs' and cmd in ('INSERT', 'ALL')),
          'ins/PERMISSIVE/authenticated',
  '守门：public.logs 上管 insert 的策略只有 ins 一个（permissive、只给 authenticated），没有别的策略能 OR 掉它');
select ok((select position('(src IS DISTINCT FROM ''account''::text)' in with_check) > 0
             from pg_policies where schemaname = 'public' and tablename = 'logs' and policyname = 'ins'),
  '守门：ins 的 with check 里还留着 src IS DISTINCT FROM ''account''（重写这个策略时不准丢，R-259）');
-- 上一条只查子串：with check (true or src is distinct from 'account') 留着原文、逻辑却坏了（TESTCLEAN-sugg ①）。
-- 再按顶层切开：顶层（括号外、引号外）不许有 OR，src 那一条要是顶层 AND 里单独的一项——… and (true or src …) 这种套一层的也过不了
create function tests.top_and(p text) returns text[] language plpgsql as $$
declare s text := btrim(p); n int; i int; d int; q boolean; c text; parts text[] := '{}'; st int := 1; wrapped boolean;
begin
  loop   -- 剥掉包住整个表达式的外层括号（pg_get_expr 会给整体加一层）
    n := length(s);
    exit when n < 2 or left(s, 1) <> '(' or right(s, 1) <> ')';
    d := 0; q := false; wrapped := true; i := 1;
    while i <= n loop
      c := substr(s, i, 1);
      if c = '''' then q := not q;
      elsif not q and c = '(' then d := d + 1;
      elsif not q and c = ')' then d := d - 1; if d = 0 and i < n then wrapped := false; exit; end if;
      end if;
      i := i + 1;
    end loop;
    exit when not wrapped;
    s := btrim(substr(s, 2, n - 2));
  end loop;
  n := length(s); d := 0; q := false; i := 1;
  while i <= n loop
    c := substr(s, i, 1);
    if c = '''' then q := not q;
    elsif not q and c = '(' then d := d + 1;
    elsif not q and c = ')' then d := d - 1;
    elsif not q and d = 0 and upper(substr(s, i, 4)) = ' OR ' then return null;   -- 顶层有 OR
    elsif not q and d = 0 and upper(substr(s, i, 5)) = ' AND ' then parts := parts || btrim(substr(s, st, i - st)); st := i + 5; i := i + 4;
    end if;
    i := i + 1;
  end loop;
  return parts || btrim(substr(s, st));
end $$;
select ok(coalesce((select '(src IS DISTINCT FROM ''account''::text)' = any(tests.top_and(with_check))
             from pg_policies where schemaname = 'public' and tablename = 'logs' and policyname = 'ins'), false),
  '守门：ins 的 with check 顶层没有 OR，src IS DISTINCT FROM ''account'' 是顶层 AND 里单独的一项（true or …、… and (x or src …) 都过不了）');

select * from finish();
rollback;
