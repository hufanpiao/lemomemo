// ai-memory 入口（R-495 AI 助手第 3 段“记住的事”）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 客户端带 JWT 调（config.toml 显式写 verify_jwt = true；函数里再 requireActiveUser）。
// 用到的库对象：service role：private.account_usable、session_alive（经 _shared/auth.ts）、app_config（版本门）、private.take_rate；
//   fn_ai 直连（_shared/db.ts 的 withAiUser）：private.ai_memories（迁移 20261123130000，策略只放本人的行）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL（经 _shared/db.ts）。不调 AI 服务商。不加 CORS（0.48 第 4 条）：浏览器经 /sb 同源调用。
import { serviceAdmin } from '../_shared/admin.ts';
import { clearMemories, deleteMemory, listMemories, undoMemory, undoReplace } from '../_shared/memories.ts';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { withAiUser } from '../_shared/db.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { memoryReq } from '../_shared/gen/schema/ai-memory.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { handle } from './core.ts';

const log = codeLogger('ai-memory');

Deno.serve(async (req) => {
  const admin = serviceAdmin(log);
  if (admin instanceof Response) return admin;
  const blocked = await versionGate('ai-memory', req, appConfigMinLoader(admin));
  if (blocked) return blocked;
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    parse(v) {
      const p = memoryReq.safeParse(v);
      return p.success ? p.data : null;
    },
    rate: rpcTakeRate(admin),
    list: async (uid, cursor) => {
      const p = await withAiUser(uid, (tx) => listMemories(tx, uid, cursor));
      return { items: p.items.map(({ id, text, at }) => ({ id, text, at })), next: p.next, total: p.total };
    },
    remove: (uid, id, now) => withAiUser(uid, (tx) => deleteMemory(tx, uid, id, now)),
    undo: (uid, id) => withAiUser(uid, (tx) => undoMemory(tx, uid, id)),
    undoReplace: (uid, id, replaced, now) => withAiUser(uid, (tx) => undoReplace(tx, uid, id, replaced, now)),
    clear: (uid) => withAiUser(uid, (tx) => clearMemories(tx, uid)),
    now: () => Date.now(),
    log,
  });
});
