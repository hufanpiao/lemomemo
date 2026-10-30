-- 接手清单 CONSENT-upd-sugg ④（迁移 20261030130000_core_notice_ver_order.sql）：app_config.notice 里 min_consent_ver 不能晚于 policy_ver。
-- 两个键都合 R-238 写法时比先后：等于、早于能写，晚于报 23514；按段比，-10 晚于 -9（不是字符串比）。
-- notice 为 null、缺键、JSON null、格式不对按现有口径不拦（运行时 consent.ts 从严，16_consent_null_ver 要写这些值）。
-- 全部以 postgres 写（app_config 没授客户端写权限；负责人在控制台改也是这个身份）。最后一段测迁移开头 DO 块的失败路径（照抄自迁移）。
begin;
select plan(19);
\ir _helpers.psql
select tests.seed();

create function tests.notice(p_min text, p_pol text) returns text language sql as $$
  select tests.try_as('postgres', null, format('update public.app_config set notice = %L::jsonb where id = 1',
    jsonb_strip_nulls(jsonb_build_object('min_consent_ver', p_min, 'policy_ver', p_pol))::text))
$$;

select is((select count(*)::int from pg_constraint
           where conrelid = 'public.app_config'::regclass and conname = 'app_config_notice_ver_order'), 1,
  '约束 app_config_notice_ver_order 有且只有一条');
select is((select notice from public.app_config where id = 1),
  '{"policy_ver": "2026-10-29", "min_consent_ver": "2026-10-29"}'::jsonb, '迁移后初值还在（R-239 的两个 2026-10-29，约束放行）');

-- ===== 放行：等于、早于 =====
select is(tests.notice('2026-10-29', '2026-10-29'), 'ok', '相等：能写');
select is(tests.notice('2026-10-29', '2026-11-03'), 'ok', 'min 早于 policy：能写（非实质改动只升 policy_ver）');
select is(tests.notice('2026-10-29', '2026-10-29-2'), 'ok', '同一天：无后缀早于 -2，能写');
select is(tests.notice('2026-10-29-9', '2026-10-29-10'), 'ok', '-9 早于 -10（按数字比，不是字符串比）：能写');
select is(tests.notice('2025-12-31', '2026-01-01'), 'ok', '跨年：能写');

-- ===== 拒绝：晚于 =====
select ok(tests.notice('2026-10-30', '2026-10-29') like '23514%', 'min 晚一天：被拒');
select ok(tests.notice('2026-10-29-2', '2026-10-29') like '23514%', '同一天 min 是 -2、policy 无后缀：被拒');
select ok(tests.notice('2026-10-29-10', '2026-10-29-9') like '23514%', 'min -10 晚于 policy -9：被拒（字符串比会放过）');
select ok(tests.notice('2026-11-01', '2026-10-31') like '23514%', '跨月：被拒');
select ok(tests.try_as('postgres', null,
  $$update public.app_config set notice = jsonb_set(notice, '{policy_ver}', '"2025-12-30"') where id = 1$$) like '23514%',
  '只把 policy_ver 调低到 min 之前：被拒');
select is((select notice from public.app_config where id = 1),
  '{"policy_ver": "2026-01-01", "min_consent_ver": "2025-12-31"}'::jsonb, '被拒的写入都没生效：还是最后一次成功写的值');

-- ===== 按现有口径不拦：null、缺键、JSON null、格式不对（运行时一律不放行） =====
select is(tests.try_as('postgres', null, $$update public.app_config set notice = null where id = 1$$), 'ok', 'notice 为 null：能写');
select is(tests.notice(null, '2026-10-29'), 'ok', '缺 min_consent_ver：能写');
select is(tests.notice('2026-10-30', null), 'ok', '缺 policy_ver：能写');
select is(tests.try_as('postgres', null,
  $$update public.app_config set notice = '{"policy_ver": null, "min_consent_ver": "2026-10-30"}' where id = 1$$), 'ok',
  'policy_ver 是 JSON null：能写');
select is(tests.notice('4.0.1', '2026-10-29'), 'ok', 'min 格式不对（4.0.1）：约束不管，运行时不放行');

-- ===== 迁移开头 DO 块的失败路径：先去掉约束写进反着的值（模拟迁移前库里已有的坏值），再跑同一段 DO 块，必须报错停下 =====
alter table public.app_config drop constraint app_config_notice_ver_order;
update public.app_config set notice = '{"policy_ver": "2026-10-29", "min_consent_ver": "2026-10-30"}' where id = 1;
select ok(tests.try_as('postgres', null, $q$
do $$
begin
  if exists (select 1 from public.app_config c
             where c.notice->>'min_consent_ver' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[1-9][0-9]?)?$'
               and c.notice->>'policy_ver' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[1-9][0-9]?)?$'
               and (left(c.notice->>'min_consent_ver', 10) || lpad(substr(c.notice->>'min_consent_ver', 12), 2, '0')) collate "C"
                 > (left(c.notice->>'policy_ver', 10) || lpad(substr(c.notice->>'policy_ver', 12), 2, '0')) collate "C") then
    raise exception 'app_config.notice 现有的 min_consent_ver 晚于 policy_ver，先改对再跑这条迁移';
  end if;
end $$;
$q$) like '%min_consent_ver 晚于 policy_ver%', '迁移前库里 min 晚于 policy：DO 块报错停下');

select * from finish();
rollback;
