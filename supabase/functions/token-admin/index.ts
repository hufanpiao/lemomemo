// token-admin 入口（架构 5.7、第 6 节 token-admin 行；B3 任务单 BE-5）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）。
// 用到的库对象：private.account_usable、private.session_alive（经 _shared/auth.ts）、private.api_token_create（迁移 20261115061000：
//   按人加锁，数有效码个数、private.take_rate、插入 public.api_tokens 一次做完；表上没有 insert 策略，只能由这里建，0001 第 10 节）、app_config（版本门）。不直连数据库，不碰 R2，不碰 AI。不加 CORS（0.48 第 4 条）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { handle, json, type CreateResult } from './core.ts';
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
  const blocked = await versionGate('token-admin', req, appConfigMinLoader(admin));
  if (blocked) return blocked;
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    store: {
      async createToken(row, lim) {
        const { data, error } = await admin.schema('private').rpc('api_token_create', {
          p_user: row.user_id, p_label: row.label, p_hash: row.token_hash, p_since: lim.sinceIso, p_max: lim.max,
          p_rate_key: lim.rateKey, p_rate_limit: lim.rateLimit, p_rate_window_s: lim.rateWindowS,
        });
        const r = data as CreateResult | null;
        if (error || !r || !['ok', 'too_many', 'rate_limited', 'duplicate'].includes(r.result)) throw new Error('db');
        if (r.result === 'ok' && (typeof r.id !== 'string' || typeof r.created_at !== 'string')) throw new Error('db');
        return r;
      },
    },
    now: Date.now,
    log,
  });
});
