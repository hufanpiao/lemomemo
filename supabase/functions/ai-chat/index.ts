// ai-chat 入口（R-492 AI 助手第 1 段；实施计划 3.2）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 客户端带 JWT 调（网关照默认校验 JWT，config.toml 显式写 verify_jwt = true；函数里再 requireActiveUser）。只有主页面 scope=main（不查隐私记）。
// 版本门：查（不在 shared/version-gate-list.ts 的免查名单里：扣每天 50 次、写 private.counters，和 ai-summarize 一样）。
// 用到的库对象：service role：private.account_usable、session_alive（经 _shared/auth.ts）、profiles、settings、app_config（同意、开关、配置、版本门）、
//   private.counters、private.take_rate、private.ai_state、logs（经 _shared/ai/store.ts）；fn_ai 直连（_shared/db.ts 的 withAiUser）：
//   public.events、todos、notes、anniversaries 的列级 select（store.ts；迁移 20261115073000、20261122090000）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL（经 _shared/db.ts）；GEMINI_API_KEY（经 _shared/ai/wire.ts 只放请求头，8.4）。
// 不加 CORS（0.48 第 4 条）：浏览器经 /sb 同源调用。日志只记码和条数（core.ts），不记请求体、记录内容、回答。
// 第 2 段：联网经 wire.ts 的 chatWebSearcher（用途 web）；看随手记的图：fn_ai 读 note_images（store.ts 的 noteImages，只经视图连过去），
//   R2 images 桶只读缩略图（令牌 R2_FN_*，8.6；check_backend 的 R2_FUNCS 已登记 ai-chat），路径按 user_id、note_id、id 拼（media-path.ts），不读存下来的 path；
//   每张按 core.ts 给的剩余预算超时、边读边计数（readThumb）。成功回包发出去前过一遍 chatOk（core.ts 的 checkOk）。
//   隐私记的图在 vault-images 桶，这里不读。环境变量另加 R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX（经 _shared/objstore-env.ts）。
import { serviceAdmin } from '../_shared/admin.ts';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { readStreamCapped } from '../_shared/body.ts';
import { noteImageThumbPath } from '../_shared/gen/logic/files/media-path.ts';
import { r2FromEnv } from '../_shared/objstore-env.ts';
import { recentMemories, relatedMemories, saveMemories } from '../_shared/memories.ts';
import { chatGateDeps, chatWebSearcher, isValidTz } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { withAiUser } from '../_shared/db.ts';
import { normExamples, normLocale, stripCtlText } from '../_shared/gen/schema/ai.ts';
import { chatOk, chatReq } from '../_shared/gen/schema/chat.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { handle } from './core.ts';
import { noteImages, runQuery } from './store.ts';
import { codeLogger } from '../_shared/fn-log.ts';

const log = codeLogger('ai-chat');
const R2 = r2FromEnv();
/** 随手记插图的桶（普通随手记；隐私记的 vault-images 不读） */
const IMAGES_BUCKET = 'images';

Deno.serve(async (req) => {
  const admin = serviceAdmin(log);
  if (admin instanceof Response) return admin;
  const blocked = await versionGate('ai-chat', req, appConfigMinLoader(admin));
  if (blocked) return blocked;
  return handle(req, {
    ...chatGateDeps(admin, log, (userId) => aiAllowed(admin, userId)),
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    parse(v) {
      const p = chatReq.safeParse(v);
      return p.success ? p.data : null;
    },
    isValidTz,
    normLocale,
    normExamples,
    stripCtl: stripCtlText,
    checkOk: (v) => chatOk.safeParse(v).success,
    query: (uid, q, tz) => withAiUser(uid, (tx) => runQuery(tx, uid, q, tz)),
    web: () => chatWebSearcher(admin),
    noteImages: (uid, noteId, limit) => withAiUser(uid, (tx) => noteImages(tx, uid, noteId, limit)),
    readThumb,
    memories: {
      recent: (uid, ms) => withAiUser(uid, (tx) => recentMemories(tx, uid, ms)),
      related: (uid, said, ms) => withAiUser(uid, (tx) => relatedMemories(tx, uid, said, ms)),
      save: (uid, items, now, ver) => withAiUser(uid, (tx) => saveMemories(tx, uid, items, now, ver)),
    },
    voiceIssued: async (key) => {
      const { data, error } = await admin.schema('private').from('counters').select('count').eq('key', key);
      if (error) throw new Error('db');
      return (data ?? []).reduce((n, r) => n + Number(r.count), 0);
    },
  });
});

/**
 * 读一张随手记缩略图（只读缩略图，不读原图）：timeoutMs 由 core.ts 按整轮预算剩下的给，到点中止（拿响应头、读正文都算在内）；
 * 边读边计数，声明的长度或读到的超过 maxBytes 就停、回 null（不整张读进内存再比）
 */
async function readThumb(uid: string, noteId: string, id: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null> {
  if (!R2) throw new Error('r2_misconfigured');
  const signal = AbortSignal.timeout(timeoutMs);
  const cancel = (body: unknown): void => {
    if (body instanceof ReadableStream) void body.cancel().catch(() => {});
  };
  // objstore 的 get 不收 signal：拿响应头这一步和 signal 赛跑，超时就不再等（晚到的正文直接取消；底层请求由 objstore 自己的 30 秒兜底中止）
  const pending = R2.get(IMAGES_BUCKET, noteImageThumbPath(uid, noteId, id));
  const obj = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason);
      pending.then((o) => cancel(o?.body), () => {});
    }, { once: true });
    pending.then(resolve, reject);
  });
  if (!obj) return null;
  if (obj.contentLength !== null && obj.contentLength > maxBytes) {
    cancel(obj.body);
    return null;
  }
  const bytes = await readStreamCapped(obj.body, maxBytes, signal);
  return bytes === 'too_large' ? null : bytes;
}
