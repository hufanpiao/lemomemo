// token-admin 入口（架构 5.7、第 6 节 token-admin 行；B3 任务单 BE-5）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）。
// 用到的库对象：private.account_usable、private.session_alive（经 _shared/auth.ts）、private.take_rate、public.api_tokens（数有效码个数；service role 插入：
//   表上没有 insert 策略，只能由这里建，0001 第 10 节）、app_config（版本门）。不直连数据库，不碰 R2，不碰 AI。不加 CORS（0.48 第 4 条）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { versionGate } from '../_shared/version-gate.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { handle, json } from './core.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';

const log = (code: string) => console.error(`token-admin: ${code}`);

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const blocked = await versionGate('token-admin', req, async (signal) => {
    const { data, error } = await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle();
    if (error) throw new Error('db');
    return data?.min_client_version ?? null;
  });
  if (blocked) return blocked;
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    store: {
      takeRate: rpcTakeRate(admin),
      async activeCount(userId, sinceIso) {
        const { count, error } = await admin.from('api_tokens').select('id', { count: 'exact', head: true })
          .eq('user_id', userId).is('revoked_at', null).gt('created_at', sinceIso);
        if (error) throw new Error('db');
        return count ?? 0;
      },
      async insertToken(row) {
        const { data, error } = await admin.from('api_tokens').insert(row).select('id, created_at').single();
        if (error) {
          if ((error as { code?: string }).code === '23505') return 'duplicate';
          throw new Error('db');
        }
        return data as { id: string; created_at: string };
      },
    },
    now: Date.now,
    log,
  });
});
