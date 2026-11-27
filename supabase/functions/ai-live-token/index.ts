// ai-live-token 入口（11-24 负责人选“改走录音加云端转写”，按住“＋”边说边出字）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 客户端带 JWT 调（config.toml 显式写 verify_jwt = true；函数里再 requireActiveUser）。
// 不走 gateDeps / aiGate（11-24 评审第 2 条：发令牌不扣每天 50 次、不占 AI 共用的每分钟 6 次），门在 core.ts 自己一套，用到的库对象：
//   app_config（版本门、ai、features，经 wire.ts 的 60 秒缓存）、profiles.beta_features、private.counters（quotaStore 计令牌自己的键；
//   50 次那个键只读 quotaUsed）、take_rate、admins、
//   ai_user_keys（只看这个人是不是在用自己的密钥），public.logs（发令牌失败，logLiveFail）。
// 密钥经 wire.ts 的 projectKey（Vault ai_key_gemini → 环境变量 GEMINI_API_KEY），只放进 core.ts 调令牌接口的 x-goog-api-key 请求头。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；GEMINI_API_KEY（过渡，经 wire.ts）。不直连数据库，不碰 R2。不加 CORS（0.48 第 4 条）。
import { serviceAdmin } from '../_shared/admin.ts';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { logLiveFail, quotaStore, quotaUsed, takeRate, type StoreAdmin } from '../_shared/ai/store.ts';
import { aiFeatures, appAiConfig, fetchOut, ownProvider, projectKey } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { isAdmin } from '../_shared/user-reads.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { LIVE_FLAG, handle } from './core.ts';

const log = codeLogger('ai-live-token');

Deno.serve(async (req) => {
  const admin = serviceAdmin(log);
  if (admin instanceof Response) return admin;
  const blocked = await versionGate('ai-live-token', req, appConfigMinLoader(admin));
  if (blocked) return blocked;
  const sa = admin as unknown as StoreAdmin;
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    consent: (userId) => aiAllowed(admin, userId),
    liveOn: async (userId, v) => (await aiFeatures(admin, userId, v, Date.now(), LIVE_FLAG)).length > 0,
    config: () => appAiConfig(admin, Date.now()),
    key: async () => (await projectKey(admin, 'gemini')) ?? null,
    // 整理这句话的是 ai-voice（用途 stt，和 ai-voice/index.ts 的 gateDeps 一样）：这一项归他自己的密钥做，后面就不扣柠檬记的 50 次（R-494）
    own: async (userId) => (await ownProvider(admin, userId, 'stt')) !== null,
    isAdmin: (userId) => isAdmin(admin, userId),
    rate: (k, limit, windowS) => takeRate(sa, k, limit, windowS),
    quota: quotaStore(sa),
    quotaUsed: (k) => quotaUsed(sa, k),
    logFail: (userId, code, fields) => logLiveFail(sa, userId, code, fields, Date.now()),
    fetch: fetchOut,
    now: () => Date.now(),
    log,
  });
});
