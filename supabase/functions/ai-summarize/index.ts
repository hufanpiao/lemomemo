// ai-summarize 入口（架构 5.14 第 4 点、第 6 节 ai-summarize 行；B4b-3）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 客户端带 JWT 调（网关照默认校验 JWT，config.toml 显式写 verify_jwt = true；函数里再 requireActiveUser）。主页面 scope=main；隐私记页面的总结这一批不做（400）。
// 版本门：查（不在 shared/version-gate-list.ts 的免查名单里：扣每天 50 次、写 private.counters，和 ai-parse 一样）。
// 用到的库对象：service role：private.account_usable、session_alive（经 _shared/auth.ts）、profiles、settings、app_config（同意、开关、配置、版本门）、
//   private.counters、private.take_rate、private.ai_state、logs（经 _shared/ai/store.ts）；fn_ai 直连（_shared/db.ts 的 withAiUser）：
//   public.events、todos、notes 的列级 select（store.ts；迁移 20261115070000）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL（经 _shared/db.ts）；GEMINI_API_KEY（经 _shared/ai/wire.ts 只放请求头，8.4）。
// 不加 CORS（0.48 第 4 条）：浏览器经 /sb 同源调用。日志只记码和条数（core.ts），不记请求体和记录内容。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { gateDeps, isValidTz } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { withAiUser } from '../_shared/db.ts';
import { normLocale, stripCtlText } from '../_shared/gen/schema/ai.ts';
import { summarizeRaw, summarizeReq } from '../_shared/gen/schema/summarize.ts';
import { versionGate } from '../_shared/version-gate.ts';
import { json } from '../_shared/http.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { handle } from './core.ts';
import { loadRows } from './store.ts';

const log = (code: string) => console.error(`ai-summarize: ${code}`);

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const blocked = await versionGate('ai-summarize', req, async (signal) => {
    const { data, error } = await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle();
    if (error) throw new Error('db');
    return data?.min_client_version ?? null;
  });
  if (blocked) return blocked;
  return handle(req, {
    ...gateDeps(admin, log, (userId) => aiAllowed(admin, userId)),
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    parse(v) {
      const p = summarizeReq.safeParse(v);
      return p.success ? p.data : null;
    },
    isValidTz,
    normLocale,
    checkRaw(v) {
      const p = summarizeRaw.safeParse(v);
      return p.success ? p.data : null;
    },
    stripCtl: stripCtlText,
    loadRows: (uid, ids) => withAiUser(uid, (tx) => loadRows(tx, uid, ids)),
  });
});
