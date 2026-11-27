-- 20261030140000_core_admins_insert_service_role.sql：给 service_role 开 private.admins 的 insert（只 insert）
-- • 用途：预览 E2E 种子脚本 tools/e2e/preview-login.ts --admin 用 service key 给 @lemomemo.test 测试账号写一行管理员
--   （接手清单 TC75-admin；TC-B1-74、75）。0001 起 service_role 对 admins 只有 select（account 拒绝注销管理员、token-admin 读）。
-- • 谁定的：产品负责人 10-30 决定（R-279；架构 0.46 第 1 条），在三个方案里明确选了“给脚本加写入权限”，知道这条迁移会同样进正式库。
-- • 风险：正式项目的 service key 一旦泄露，拿到的人除了原来就能做的读写数据，还能给自己（或任何账号）加管理员、发邀请码，
--   把陌生人拉进来。安全审查员推荐过“不加迁移、脚本只校验并给出带检查段的 SQL，由主持人在预览 SQL Editor 手工执行”的方案，
--   负责人未采纳。风险、守则和什么时候重新评估见 docs/10-架构/安全说明-v4.md S-6。
-- • 守则（S-6）：只给 insert，不给 update、delete，也不给 private 里别的表；只有 preview-login --admin 用它，Edge Functions、
--   lemo-ops、别的脚本都不准写 private.admins；正式环境不跑 --admin（正式库的管理员只有负责人本人，手工加）。
-- • 同步的地方（改授权时一起改）：架构 3.3 C 和附录 A 末尾各一行（一字不差，check_backend M4 比对）、build/d1/whitelist.ts
--   （D1 双向比对）、supabase/tests/rls/03_roles_grants.test.sql（service_role 对 private 的授权 = 3.3 C 白名单；
--   并单独断言对 admins 只有 select 和 insert）。
-- • 以后要收回（S-6 重新评估条件 ⑤，预览 E2E 不再需要 .test 管理员时）：写新迁移 revoke insert on private.admins from service_role，
--   并同步改上面这几处。
-- 运行情况：10-30 只在离线 PGlite（npm run test:db:offline）和本机测试库上跑过，还没推预览库。

grant insert on private.admins to service_role;
