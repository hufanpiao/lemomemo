// note-search 入口（架构 5.13 第 6 点、第 6 节 note-search 行；B4b-2）：组装依赖，逻辑在 core.ts。
// 客户端带 JWT 调（网关照默认校验 JWT，函数里再 requireActiveUser）；主页面 scope=main，隐私记页面的 scope=vault 这一批不做（D-16）。
// 用到的库对象：service role：private.account_usable、session_alive（经 _shared/auth.ts）、profiles、settings、app_config（同意、配置）、
//   private.user_limits（search_daily）、private.take_rate（每分钟、每天计数）；fn_ai 直连（_shared/db.ts 的 withAiUser）：private.note_vectors（store.ts）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL；GEMINI_API_KEY（经 _shared/ai/wire.ts 的 embedderFor，只放 x-goog-api-key 请求头，8.4）。
// 版本门：免查（shared/version-gate-list.ts：只读函数，架构第 6 节免查名单“note-search、ai-summarize、vault-image 这类只读函数”）。
// 日志只记码（core.ts），不记查询文字。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { withAiUser } from '../_shared/db.ts';
import { json } from '../_shared/http.ts';
import { timedFetch } from '../_shared/net.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { embedderFor } from '../_shared/ai/wire.ts';
import { noteSearchReq } from '../_shared/gen/schema/search.ts';
import { handle, readSearchConfig } from './core.ts';
import { nearest } from './store.ts';

const log = (code: string) => console.error(`note-search: ${code}`);

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    parse(v) {
      const p = noteSearchReq.safeParse(v);
      return p.success ? p.data : null;
    },
    consent: (userId) => aiAllowed(admin, userId),
    takeRate: rpcTakeRate(admin),
    async config() {
      const { data, error } = await admin.from('app_config').select('ai').eq('id', 1).maybeSingle();
      if (error || !data) throw new Error('db:app_config');
      return readSearchConfig((data as { ai: unknown }).ai);
    },
    async searchDaily(userId) {
      const { data, error } = await admin.schema('private').from('user_limits').select('search_daily').eq('user_id', userId).maybeSingle();
      if (error) throw new Error('db:user_limits');
      if (!data) return undefined;
      const v = (data as { search_daily: unknown }).search_daily;
      return typeof v === 'number' ? v : null;
    },
    embedder: embedderFor,
    nearest: (uid, vec, model, limit, min) => withAiUser(uid, (tx) => nearest(tx, uid, vec, model, limit, min)),
    now: Date.now,
    log,
  });
});
