-- 20261030130000_core_notice_ver_order.sql：app_config.notice 里 min_consent_ver 不能晚于 policy_ver（接手清单 CONSENT-upd-sugg ④）
-- • 为什么：record_consent 同意时把 profiles.consent_policy_ver 写成 notice.policy_ver。min_consent_ver 若晚于 policy_ver，
--   写回去的版本永远低于门槛：aiAllowed 一直不放行，客户端每次打开都弹“隐私说明更新了”那一屏，点同意也出不去。
--   R-238（架构 0.40 第 1 条、15.5、数据字典第 8 节）早就写了“min_consent_ver <= policy_ver”，但只写在文档里，库里没拦。
-- • 现状：notice 原来没有任何约束（0001 建表 notice jsonb，可为 null）；版本写法只在运行时核对——_shared/consent.ts 的
--   policyVerAtLeast、前端 consent-api.ts，任何一边为空或格式不对一律不放行。这里不改那套口径，只补“两边都合格式时比先后”：
--     ① 两个键都是 R-238 的写法（YYYY-MM-DD 或 YYYY-MM-DD-N，N 为 1～99）→ 必须 min_consent_ver <= policy_ver，晚了报 23514；
--     ② notice 为 null、缺键、值为 JSON null 或格式不对 → 约束不管（case 落到 null，check 视为通过），仍由运行时从严处理。
--       16_consent_null_ver.test.sql 要把 notice 清成 null、{"policy_ver": null} 来测 record_consent，这些写法必须还能写进去。
--       后缀 -0、-100、-01 这类（R-238 只认 -1～-99、不带前导 0）也属于“格式不对、约束不管”，由运行时从严（consent.ts 的 POLICY_VER_RE 同一条正则）。
--     ③ D1 守门：build/d1/whitelist.ts 的 REQUIRED_CONSTRAINTS 整段精确匹配本约束的 pg_get_constraintdef，被删或改宽就报“缺约束”
--       （反例 supabase/tests/d1-fixtures/29_notice_ver_order_loose.psql、tests/build/d1-notice-ver-order.test.ts）；改约束要同步改那里。
-- • 比较口径和 policyVerAtLeast 一致（按“-”切段逐段比，缺的段按 0）：把每个值变成 'YYYY-MM-DD' || 两位后缀（没有后缀按 00），
--   定长后按 collate "C" 逐字节比。'2026-10-29' → '2026-10-2900'，'2026-10-29-2' → '2026-10-2902'，'-10' → '10'，所以 -10 晚于 -9。
--   正则用 [0-9] 不用 \d（同 20261029190000：ICU 排序规则下 \d 可能认全角数字）。不用函数：约束里直接写表达式，免得
--   以 service_role 或别的角色改 notice 时还要另授函数执行权。
-- • 运营怎么改 notice：架构 0.40 第 2 条——告知页或隐私说明文字改了，在同一个 PR 里加迁移升版；上线与回滚手册“版本号”一节有提示。
--   负责人在控制台 SQL 编辑器直接改也受这条约束管，写反了当场报错。
-- • 先确认现有值能通过：不通过就带着原因停下（add constraint 也会校验现有行，这里先报一个看得懂的错）。
--   这段 DO 块的失败路径在 supabase/tests/rls/20_notice_ver_order.test.sql 里照抄一份测（改这里要同步改那里）。
-- • lock_timeout（写法同 20261029190000）：app_config 只有一行，锁很短；万一有长事务占着表，5 秒内失败，不把后面的请求排成长队。
--   set local 在 CLI 推迁移时是否生效，等第一次推预览库时按接手清单 K10-locktimeout 一起核实。
-- 运行情况：10-30 只在离线 PGlite（npm run test:db:offline）上跑过。

set local lock_timeout = '5s';

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

alter table public.app_config add constraint app_config_notice_ver_order check (
  case when notice->>'min_consent_ver' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[1-9][0-9]?)?$'
        and notice->>'policy_ver' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[1-9][0-9]?)?$'
       then (left(notice->>'min_consent_ver', 10) || lpad(substr(notice->>'min_consent_ver', 12), 2, '0')) collate "C"
         <= (left(notice->>'policy_ver', 10) || lpad(substr(notice->>'policy_ver', 12), 2, '0')) collate "C"
  end);
