// ai-classify 入口（架构 5.2、第 6 节 ai-classify 行；B4 任务单 S6）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每 2 分钟由 pg_cron 经 pg_net 调一次（迁移 20261110120000_notes_ai_classify_cron.sql）。逻辑和测试见 core.ts、tests/edge/ai-classify.test.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；CRON_SECRET；GEMINI_API_KEY（8.4，经 _shared/ai/wire.ts 只放请求头）。
// 用到的库对象：private.account_usable（经 _shared/auth.ts）；profiles、settings、app_config（同意、配置）；private.counters、ai_state（额度）；
//   notes、categories、private.heartbeat（store.ts）。不直连数据库（不 import _shared/db.ts），不碰 R2。
// 版本门：免查（shared/version-gate-list.ts，pg_cron 调、没有客户端版本）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { gateDeps } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { classifyByRules } from '../_shared/gen/logic/notes/classify-rules.ts';
import { normalizeForSearch } from '../_shared/gen/logic/search.ts';
import { handle } from './core.ts';
import { makeStore } from './store.ts';

const log = (code: string) => console.error(`ai-classify: ${code}`);

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  if (!admin) return handle(req, { ...unconfigured(), cronSecret: Deno.env.get('CRON_SECRET') });
  const g = gateDeps(admin, log, (userId) => aiAllowed(admin, userId));
  return handle(req, {
    cronSecret: Deno.env.get('CRON_SECRET'),
    store: makeStore(admin),
    async isUsable(userId) {
      return (await isUsable(admin, userId)).ok;
    },
    // 隐私记这一批不取（B5 才解密），所以这里不带 {vault: true}
    consent: (userId) => aiAllowed(admin, userId),
    config: g.config,
    provider: g.provider,
    quota: g.quota,
    exhaustedUntil: g.exhaustedUntil,
    markExhausted: g.markExhausted,
    logic: { classifyByRules, normalize: normalizeForSearch },
    newId: () => crypto.randomUUID(),
    now: Date.now,
    log,
  });
});

/** 没有库客户端：鉴权照旧先做（没带对密钥的看不出配没配），过了以后 core.ts 回 500 misconfigured */
function unconfigured() {
  const no = () => Promise.reject(new Error('misconfigured'));
  return {
    store: null, isUsable: no, consent: no, config: no, provider: () => null,
    quota: { take: no, refund: no }, exhaustedUntil: no, markExhausted: no,
    logic: { classifyByRules: () => ({ category_id: null }), normalize: (s: string) => s },
    newId: () => crypto.randomUUID(), now: Date.now, log,
  };
}
