// ai-provider 入口（R-494 AI 助手第 4 段：自行更换 AI 服务商）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 客户端带 JWT 调（config.toml 显式写 verify_jwt = true；函数里再 requireActiveUser）。管理员判定和 invite-admin 同一个查法（_shared/user-reads.ts 的 isAdmin）。
// 用到的库对象（全部经 service role）：private.account_usable、session_alive（经 _shared/auth.ts）、private.admins、private.take_rate、
//   public.app_config（读写 ai 一列）、private.ai_user_keys（读写删）、private.ai_secret_set / ai_secret_get（Vault，迁移 20261123090000）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；GEMINI_API_KEY 只经 _shared/ai/wire.ts 的 projectKey 读（Vault 里没有 Gemini 那把时的过渡）。
// 出站：试调时连各家服务商（generativelanguage.googleapis.com、api.openai.com、api.deepseek.com、api.anthropic.com），只经 _shared/ai 的适配器；
//   试联网密钥时连 api.search.brave.com、api.tavily.com、naverapihub.apigw.ntruss.com；admin_web_compare（对比用）另连 api.deepseek.com/v1/tools/search（都只经 _shared/ai/websearch.ts）。
// 不加 CORS（0.48 第 4 条）：浏览器经 /sb 同源调用。日志只记动作和码（core.ts），不记密钥、模型名、请求体。
import { serviceAdmin } from '../_shared/admin.ts';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { makeProvider } from '../_shared/ai/router.ts';
import { makeSearcher } from '../_shared/ai/websearch.ts';
import { fetchOut, forgetProjectKey, projectKey, vaultSecret } from '../_shared/ai/wire.ts';
import { aiProviderReq, supportOf } from '../_shared/gen/schema/ai-provider.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { isAdmin } from '../_shared/user-reads.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { handle, type OwnRow, type Req } from './core.ts';

const log = codeLogger('ai-provider');

Deno.serve(async (req) => {
  const admin = serviceAdmin(log);
  if (admin instanceof Response) return admin;
  const blocked = await versionGate('ai-provider', req, appConfigMinLoader(admin));
  if (blocked) return blocked;
  const priv = admin.schema('private');
  const must = <T>(r: { data: T; error: unknown }): T => {
    if (r.error) throw new Error('db');
    return r.data;
  };
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    parse(v) {
      const p = aiProviderReq.safeParse(v);
      return p.success ? (p.data as Req) : null;
    },
    support: supportOf,
    isAdmin: (userId) => isAdmin(admin, userId),
    consent: (userId) => aiAllowed(admin, userId),
    rate: rpcTakeRate(admin),
    async readAi() {
      return (must(await admin.from('app_config').select('ai').eq('id', 1).maybeSingle()) as { ai?: unknown } | null)?.ai ?? null;
    },
    async writeAi(ai) {
      must(await admin.from('app_config').update({ ai }).eq('id', 1));
    },
    async secretSet(name, k) {
      must(await priv.rpc('ai_secret_set', { p_name: name, p_key: k }));
    },
    secretGet: (name) => vaultSecret(admin, name),
    projectKey: (p) => projectKey(admin, p),
    forgetKey: forgetProjectKey,
    async ownRead(userId) {
      const row = must(await priv.from('ai_user_keys').select('provider, model, key_last4, active, fell_back_at, fell_back_why').eq('user_id', userId).maybeSingle());
      return (row as OwnRow | null) ?? null;
    },
    async ownWrite(userId, row) {
      must(await priv.from('ai_user_keys').upsert({ user_id: userId, ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }));
    },
    async ownActive(userId, active) {
      must(await priv.from('ai_user_keys').update({ active, updated_at: new Date().toISOString() }).eq('user_id', userId));
    },
    async ownDelete(userId) {
      must(await priv.from('ai_user_keys').delete().eq('user_id', userId));
    },
    make: (p, model, k) => makeProvider(p, model, k, fetchOut),
    makeSearcher: (p, k) => makeSearcher(p, k, fetchOut),
    now: Date.now,
    log,
  });
});
