// ai-media 入口（架构 5.13 第 5 点、第 6 节 ai-media 行；B4b-2 识图）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每 5 分钟由 pg_cron 经 pg_net 调一次（迁移 20261115040000_ai_media.sql）。逻辑和测试见 core.ts、tests/edge/ai-media.test.ts。
// 用到的库对象：service role：private.account_usable（经 _shared/auth.ts）、profiles（同意、ui_locale）、settings、app_config（同意、配置）、
//   private.user_limits（media_daily）、private.counters（ai_quota_take / refund、take_rate）、private.ai_state（谷歌额度）；
//   fn_ai 直连（_shared/db.ts 的 withAiUser / withAiScan）：private.scan_note_images、public.note_images、notes、private.heartbeat（SQL 在 store.ts）。
// R2：images 桶只读（令牌 R2_FN_*，8.6），按 user_id、note_id、id 拼缩略图路径。隐私记的图（vault-images）这一批不读、不识别。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL；CRON_SECRET；R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX；
//   GEMINI_API_KEY（经 _shared/ai/wire.ts 的 gateDeps，只放 x-goog-api-key 请求头，8.4）。
// 版本门：免查（shared/version-gate-list.ts，pg_cron 调、没有客户端版本）。日志只记码和数，不记描述、标签、路径。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { withAiScan, withAiUser } from '../_shared/db.ts';
import { json } from '../_shared/http.ts';
import { timedFetch } from '../_shared/net.ts';
import { r2FromEnv } from '../_shared/objstore-env.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { appAiConfig, gateDeps } from '../_shared/ai/wire.ts';
import { noteImagePath, noteImageThumbPath } from '../_shared/gen/logic/files/media-path.ts';
import { handle, readMediaDefault } from './core.ts';
import { doneItem, dueItems, dueUsers, failItem, laterItems, parkAll, skipConsent, skipOther, unskip, writeHeartbeat } from './store.ts';
import { codeLogger } from '../_shared/fn-log.ts';

const log = codeLogger('ai-media');
const R2 = r2FromEnv();

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const consent = (userId: string) => aiAllowed(admin, userId);
  const g = gateDeps(admin, log, consent);
  return handle(req, {
    cronSecret: Deno.env.get('CRON_SECRET'),
    store: {
      users: (limit, now) => withAiScan((tx) => dueUsers(tx, limit, now)),
      items: (uid, limit, now) => withAiUser(uid, (tx) => dueItems(tx, uid, limit, now)),
      later: (uid, ids, at, bump) => withAiUser(uid, (tx) => laterItems(tx, uid, ids, at, bump)),
      parkAll: (uid, at) => withAiUser(uid, (tx) => parkAll(tx, uid, at)),
      skipConsent: (uid) => withAiUser(uid, (tx) => skipConsent(tx, uid)),
      unskip: (uid, ids) => withAiUser(uid, (tx) => unskip(tx, uid, ids)),
      skipOther: (uid, ids) => withAiUser(uid, (tx) => skipOther(tx, uid, ids)),
      fail: (uid, id, tries) => withAiUser(uid, (tx) => failItem(tx, uid, id, tries)),
      done: (uid, id, desc, tags) => withAiUser(uid, (tx) => doneItem(tx, uid, id, desc, tags)),
      heartbeat: (d) => withAiScan((tx) => writeHeartbeat(tx, d)),
    },
    r2: R2,
    isUsable: async (userId) => (await isUsable(admin, userId)).ok,
    consent,
    config: async () => ({ ai: await g.config(), mediaDailyDefault: readMediaDefault(await appAiConfig(admin, Date.now())) }),
    provider: g.provider,
    quota: g.quota,
    takeRate: rpcTakeRate(admin),
    async mediaDaily(userId) {
      const { data, error } = await admin.schema('private').from('user_limits').select('media_daily').eq('user_id', userId).maybeSingle();
      if (error) throw new Error('db:user_limits');
      if (!data) return undefined;
      const v = (data as { media_daily: unknown }).media_daily;
      return typeof v === 'number' ? v : null;
    },
    async locale(userId) {
      const { data, error } = await admin.from('profiles').select('ui_locale').eq('user_id', userId).maybeSingle();
      if (error) throw new Error('db:profiles');
      return (data as { ui_locale?: unknown } | null)?.ui_locale === 'ko-KR' ? 'ko-KR' : 'zh-CN';
    },
    exhaustedUntil: g.exhaustedUntil,
    markExhausted: g.markExhausted,
    path: (uid, noteId, id, thumb) => (thumb ? noteImageThumbPath(uid, noteId, id) : noteImagePath(uid, noteId, id)),
    now: Date.now,
    log,
  });
});
