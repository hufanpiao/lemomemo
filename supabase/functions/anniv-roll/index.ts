// anniv-roll 入口（B5 S13；架构 5.4、第 6 节 anniv-roll 行）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每天 00:10 UTC 由 pg_cron 经 pg_net 调一次（迁移 20261113181000_anniv_roll_cron.sql）。逻辑和测试见 core.ts、tests/edge/anniv-roll.test.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；CRON_SECRET。
// 用到的库对象：private.account_usable（经 _shared/auth.ts）；anniversaries、profiles、settings、private.heartbeat（store.ts）。不直连数据库，不碰 R2。
// 版本门：免查（shared/version-gate-list.ts，pg_cron 调、没有客户端版本）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { addDays, todayOf } from '../_shared/gen/core/date.ts';
import { isValidTz } from '../_shared/gen/core/tz.ts';
import { annivNextOf } from '../_shared/gen/logic/anniv/next-date.ts';
import { handle } from './core.ts';
import { makeStore } from './store.ts';
import { codeLogger } from '../_shared/fn-log.ts';

const log = codeLogger('anniv-roll');

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } }) : null;
  return handle(req, {
    cronSecret: Deno.env.get('CRON_SECRET'),
    store: admin ? makeStore(admin) : null,
    async isUsable(userId) {
      if (!admin) throw new Error('misconfigured');
      return (await isUsable(admin, userId)).ok;
    },
    logic: { annivNextOf, todayOf, addDays, isValidTz },
    now: Date.now,
    log,
  });
});
