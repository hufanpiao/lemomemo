-- logs 的 ins 策略不准客户端写 src = 'account'（迁移 20261030100000_core_logs_ins_no_account_src.sql，R-259），
--   连大小写、空白、全角、零宽字符、标点的变体也不准（20261030110000_core_logs_ins_src_variants.sql，R259-sugg ①）
-- “设置 › 账号 › 最近的导出”只认 src = 'account' 的行（account 函数经 service role 写）；客户端能写的话就能伪造导出记录
-- 原有条件照旧：本人、账号可用（停用的 C 写不进）；别的 src、src 为 null 照常能写；service role 写 src = 'account' 照常成功
begin;
select plan(24);
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

-- ===== R259-sugg ①：'account' 的变体一样被拒（NFKC 规范化、去掉非字母数字、转小写以后等于 account） =====
create function tests.not_rejected(p_vals text[]) returns text language sql as $$
  select string_agg(quote_literal(v), ' | ') from unnest(p_vals) v
   where tests.a(format('insert into public.logs (t, kind, act, src) values (9, %L, %L, %L)', 'run', 'export', v)) not like '42501 %row-level security%'
$$;
-- 特殊字符一律用 chr() 写（chr(9) 制表、chr(10) 换行、chr(13) 回车、chr(12288) 全角空格 U+3000、chr(8203) 零宽空格 U+200B、
--   chr(65345) 起是全角小写字母 ａ），文件里不出现反斜杠转义
select is(tests.not_rejected(array['Account', 'ACCOUNT', 'aCcOuNt', 'account ', ' account', 'account' || chr(9), chr(10) || 'account' || chr(13) || chr(10)]), null,
  '大小写、两头半角空格、制表、换行的变体：一个个都被 RLS 拒（列出来的是没被拒的）');
select is(tests.not_rejected(array['account' || chr(12288),
    (select string_agg(chr(65345 + ascii(ch) - ascii('a')), '' order by i) from unnest(string_to_array('account', null)) with ordinality as x(ch, i)),
    'acc' || chr(8203) || 'ount', 'ac-count', 'account.', 'a c c o u n t']), null,
  '全角空格 U+3000、全角字母、中间夹零宽空格 U+200B、连字符、标点、字母间空格：都被拒');
select is(tests.a($$insert into public.logs (t, kind, act, src) values (10, 'run', 'x', 'accounts'), (11, 'run', 'x', 'account1'), (12, 'run', 'x', 'myaccount')$$), 'ok',
  '只是含 account 的别的值（accounts、account1、myaccount）照常能写：规范化以后不等于 account');

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
select ok((select position('(lower(regexp_replace(NORMALIZE(src, NFKC), ''[^[:alnum:]]''::text, ''''::text, ''g''::text)) IS DISTINCT FROM ''account''::text)' in with_check) > 0
             from pg_policies where schemaname = 'public' and tablename = 'logs' and policyname = 'ins'),
  '守门：ins 的 with check 里还留着“规范化以后的 src IS DISTINCT FROM ''account''”（重写这个策略时不准丢，R-259、R259-sugg ①）');
-- 上一条只查子串：with check (true or src is distinct from 'account') 留着原文、逻辑却坏了（TESTCLEAN-sugg ①）。
-- 再按顶层切开：顶层（括号外、引号外）不许有 OR，src 那一条要是顶层 AND 里单独的一项——… and (true or src …) 这种套一层的也过不了。
-- 引号有两种：'…' 字符串（'' 转义）和 "…" 标识符（"" 转义）；q、w 分别记在不在里面，引号里的括号、AND、OR 都不算，两种引号互不打开对方
create function tests.top_and(p text) returns text[] language plpgsql as $$
declare s text := btrim(p); n int; i int; d int; q boolean; w boolean; c text; parts text[] := '{}'; st int := 1; wrapped boolean;
begin
  loop   -- 剥掉包住整个表达式的外层括号（pg_get_expr 会给整体加一层）
    n := length(s);
    exit when n < 2 or left(s, 1) <> '(' or right(s, 1) <> ')';
    d := 0; q := false; w := false; wrapped := true; i := 1;
    while i <= n loop
      c := substr(s, i, 1);
      if c = '''' and not w then q := not q;
      elsif c = '"' and not q then w := not w;
      elsif not q and not w and c = '(' then d := d + 1;
      elsif not q and not w and c = ')' then d := d - 1; if d = 0 and i < n then wrapped := false; exit; end if;
      end if;
      i := i + 1;
    end loop;
    exit when not wrapped;
    s := btrim(substr(s, 2, n - 2));
  end loop;
  n := length(s); d := 0; q := false; w := false; i := 1;
  while i <= n loop
    c := substr(s, i, 1);
    if c = '''' and not w then q := not q;
    elsif c = '"' and not q then w := not w;
    elsif q or w then null;   -- 引号里的一律不看
    elsif c = '(' then d := d + 1;
    elsif c = ')' then d := d - 1;
    elsif d = 0 and upper(substr(s, i, 4)) = ' OR ' then return null;   -- 顶层有 OR
    elsif d = 0 and upper(substr(s, i, 5)) = ' AND ' then parts := parts || btrim(substr(s, st, i - st)); st := i + 5; i := i + 4;
    end if;
    i := i + 1;
  end loop;
  return parts || btrim(substr(s, st));
end $$;
-- top_and 自己的正反例（TESTCLEAN 复审建议）：双引号标识符里的 or / and / 括号不算，引号外的照算；两种引号互不打开对方
select is(tests.top_and('"a or b" = 1 and c'), array['"a or b" = 1', 'c'], 'top_and 正例：双引号标识符里的 or 不算顶层 OR，照样按顶层 AND 切开');
select is(tests.top_and('"a and b" = 1'), array['"a and b" = 1'], 'top_and 正例：双引号标识符里的 and 不切');
select is(tests.top_and('"x (" = 1 and c'), array['"x (" = 1', 'c'], 'top_and 正例：双引号标识符里的括号不改层数');
select is(tests.top_and('("a)" = 1 and c)'), array['"a)" = 1', 'c'], 'top_and 正例：外层括号照剥，标识符里的 ) 不算');
select is(tests.top_and('"q""r" = 1 and c'), array['"q""r" = 1', 'c'], 'top_and 正例：标识符里的 "" 转义不打乱');
select ok(tests.top_and('"a" = 1 or c') is null, 'top_and 反例：标识符外的顶层 OR 照报（返回 null）');
select ok(tests.top_and('''x "'' = 1 or c') is null, 'top_and 反例：单引号字符串里的 " 不开标识符，后面的顶层 OR 照报');
select ok(tests.top_and('"y''" = 1 or c') is null, 'top_and 反例：标识符里的单引号不开字符串，后面的顶层 OR 照报');
select ok(coalesce((select '(lower(regexp_replace(NORMALIZE(src, NFKC), ''[^[:alnum:]]''::text, ''''::text, ''g''::text)) IS DISTINCT FROM ''account''::text)' = any(tests.top_and(with_check))
             from pg_policies where schemaname = 'public' and tablename = 'logs' and policyname = 'ins'), false),
  '守门：ins 的 with check 顶层没有 OR，规范化以后的 src 条件是顶层 AND 里单独的一项（true or …、… and (x or src …) 都过不了）');

select * from finish();
rollback;
