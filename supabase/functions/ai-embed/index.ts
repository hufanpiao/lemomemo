// ai-embed 入口（架构 5.13 第 6 点、第 6 节 ai-embed 行；B4b-2）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每 2 分钟由 pg_cron 经 pg_net 调一次（迁移 20261115020000_search_embed_cron.sql）。逻辑和测试见 core.ts、tests/edge/ai-embed.test.ts。
// 用到的库对象：service role：private.account_usable（经 _shared/auth.ts）、profiles、settings、app_config（同意、配置）、private.take_rate（全项目每天计数）；
//   fn_ai 直连（_shared/db.ts 的 withAiUser / withAiScan）：private.scan_embed_queue、embed_queue、note_vectors、notes、events、todos、note_images、
//   note_files、private.heartbeat（SQL 在 store.ts）。不碰 R2、不解密隐私记（隐私记的队列项推后，见 core.ts）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL；CRON_SECRET；GEMINI_API_KEY（经 _shared/ai/wire.ts 的 embedderFor，只放 x-goog-api-key 请求头，8.4）。
// 版本门：免查（shared/version-gate-list.ts，pg_cron 调、没有客户端版本）。日志只记码和数。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { withAiScan, withAiUser } from '../_shared/db.ts';
import { sha256Hex } from '../_shared/body.ts';
import { timedFetch } from '../_shared/net.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { appAiConfig, embedderFor } from '../_shared/ai/wire.ts';
import { handle, readEmbedConfig } from './core.ts';
import { dueItems, dueUsers, hashes, laterItems, settleItems, sources, writeHeartbeat, writeVector } from './store.ts';

const log = (code: string) => console.error(`ai-embed: ${code}`);
const enc = new TextEncoder();

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } }) : null;
  const no = () => Promise.reject(new Error('misconfigured'));
  return handle(req, {
    cronSecret: Deno.env.get('CRON_SECRET'),
    store: admin
      ? {
        users: (limit) => withAiScan((tx) => dueUsers(tx, limit)),
        items: (uid, limit) => withAiUser(uid, (tx) => dueItems(tx, uid, limit)),
        sources: (uid, items) => withAiUser(uid, (tx) => sources(tx, uid, items)),
        hashes: (uid, items, model) => withAiUser(uid, (tx) => hashes(tx, uid, items, model)),
        write: (uid, it, model, hash, vec) => withAiUser(uid, (tx) => writeVector(tx, uid, it, model, hash, vec)),
        settle: (uid, items) => (items.length === 0 ? Promise.resolve() : withAiUser(uid, (tx) => settleItems(tx, uid, items))),
        later: (uid, items, at, bump) => (items.length === 0 ? Promise.resolve() : withAiUser(uid, (tx) => laterItems(tx, uid, items, at, bump))),
        heartbeat: (d) => withAiScan((tx) => writeHeartbeat(tx, d)),
      }
      : null,
    isUsable: async (userId) => (admin ? (await isUsable(admin, userId)).ok : no()),
    consent: (userId) => (admin ? aiAllowed(admin, userId) : no()),
    config: async () => (admin ? readEmbedConfig(await appAiConfig(admin, Date.now())) : no()),
    takeRate: admin ? rpcTakeRate(admin) : no,
    embedder: embedderFor,
    sha256Hex: (text) => sha256Hex(enc.encode(text)),
    now: Date.now,
    log,
  });
});
