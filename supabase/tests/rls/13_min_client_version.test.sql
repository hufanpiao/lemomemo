-- B1 K10（接手清单 K10-min-db，迁移 20261029190000）：app_config.min_client_version 只收每段 1～6 位的 ASCII 数字三段，
-- 和两道版本门（转发层、函数侧）认的格式一致；超长的值数据库直接拒，不会写进去以后让版本门放行所有人。
-- 0.27 原来的几条（4.1 被拒、4.0.1 能写）在 04_config_constraints.test.sql，这里不重复。
-- 最后一段测迁移开头 DO 块的失败路径：DO 块照抄自迁移（改迁移要同步改这里）。
begin;
select plan(11);
\ir _helpers.psql
select tests.seed();

select is((select count(*)::int from pg_constraint
           where conrelid = 'public.app_config'::regclass and conname = 'app_config_min_client_version_check'), 1,
  '约束 app_config_min_client_version_check 有且只有一条');
select ok((select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.app_config'::regclass and conname = 'app_config_min_client_version_check') like '%[0-9]{1,6}%',
  '约束是每段 1～6 位 [0-9] 的写法（不是 0001 的 \d+，也不用会认非 ASCII 数字的 \d）');
select is(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '999999.999999.999999'$$), 'ok',
  '每段 6 位：能写');
select is(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '4.0.0'$$), 'ok', '4.0.0：能写');
select ok(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '1234567.0.0'$$) like '23514%',
  '第一段 7 位：被拒');
select ok(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '4.1234567.0'$$) like '23514%',
  '第二段 7 位：被拒');
select ok(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '4.1.1234567'$$) like '23514%',
  '第三段 7 位：被拒');
select ok(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '4.1.0-preview.1'$$) like '23514%',
  '带后缀：被拒（min_client_version 只认不带后缀的三段）');
select ok(tests.try_as('postgres', null, $$update public.app_config set min_client_version = '４.1.0'$$) like '23514%',
  '全角数字：被拒');
select is(tests.try_as('postgres', null, $$update public.app_config set min_client_version = null$$), 'ok',
  'null 能写（版本门读到 null 放行，和 0001 一样）');

-- 迁移开头 DO 块的失败路径：先去掉约束写进 7 位的值（模拟迁移前库里已有的坏值），再跑同一段 DO 块，必须报错停下
alter table public.app_config drop constraint app_config_min_client_version_check;
update public.app_config set min_client_version = '1234567.0.0';
select ok(tests.try_as('postgres', null, $q$
do $$
begin
  if exists (select 1 from public.app_config
             where min_client_version is not null and min_client_version !~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$') then
    raise exception 'app_config.min_client_version 现有的值不是每段 1～6 位的三段数字，先改对再跑这条迁移';
  end if;
end $$;
$q$) like '%现有的值不是每段 1～6 位%', '迁移前库里有 7 位的值：DO 块报错停下');

select * from finish();
rollback;
