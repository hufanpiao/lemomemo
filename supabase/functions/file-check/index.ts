// file-check 入口（架构 5.13 第 2 点、第 6 节 file-check 行；B4b-1）：组装依赖，逻辑在 core.ts。
// 两种调用：客户端带 JWT 的 {action: check, id}（网关不校验，函数里 requireActiveUser 自己验）；pg_cron 每 10 分钟带 x-cron-secret 的 {action: sweep}
//   （迁移 20261115000000；cron 请求没有用户 JWT，所以 config.toml 的 [functions.file-check] verify_jwt = false，check 一支在函数里自己 requireActiveUser）。
// 用到的库对象：service role：private.account_usable、session_alive（经 _shared/auth.ts）、private.take_rate；
//   fn_ai 直连（_shared/db.ts 的 withAiUser / withAiScan）：public.note_files、private.scan_note_files、private.heartbeat（SQL 在 store.ts）。
// R2：files 桶，令牌 R2_FN_*（8.6）：读原文件、查缩略图、被拒时删对象。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL；CRON_SECRET；R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX。
// 版本门：check 一支在入口照常查（客户端调）；带 x-cron-secret 的请求（pg_cron 的 sweep，没有客户端版本）跳过版本门，密钥由 core 的 cronGate 核；
//   不进 shared/version-gate-list.ts 的免查名单（那份名单按方法整体免查，这里 POST 的 check 要查）。日志只记错误码。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, isUsable, requireActiveUser } from '../_shared/auth.ts';
import { withAiScan, withAiUser } from '../_shared/db.ts';
import { json } from '../_shared/http.ts';
import { timedFetch } from '../_shared/net.ts';
import { r2FromEnv } from '../_shared/objstore-env.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { sha256Hex } from '../_shared/body.ts';
import { sniffFile } from '../_shared/gen/logic/files/file-sniff.ts';
import { FILE_MAX_BYTES } from '../_shared/gen/logic/files/limits.ts';
import { inflateRaw } from '../_shared/gen/logic/files/inflate.ts';
import { noteFilePath, noteFileThumbPath } from '../_shared/gen/logic/files/media-path.ts';
import { fileCheckReq } from '../_shared/gen/schema/attachments.ts';
import { handle } from './core.ts';
import { fileRow, settleRow, staleIds, writeHeartbeat } from './store.ts';

const log = (code: string) => console.error(`file-check: ${code}`);
const R2 = r2FromEnv();

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  // cron 的 sweep 没有客户端版本；只有带用户 JWT 的那一支过版本门
  //   （带了 x-cron-secret 却不是 sweep 的，core 照样要 JWT；版本门不是鉴权边界）
  if (!req.headers.get('x-cron-secret')) {
    const blocked = await versionGate('file-check', req, appConfigMinLoader(admin));
    if (blocked) return blocked;
  }
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    takeRate: rpcTakeRate(admin),
    cronSecret: Deno.env.get('CRON_SECRET'),
    maxBytes: FILE_MAX_BYTES,
    parse(v) {
      const p = fileCheckReq.safeParse(v);
      return p.success ? p.data : null;
    },
    store: {
      row: (uid, id) => withAiUser(uid, (tx) => fileRow(tx, uid, id)),
      async stale(before, limit) {
        const ids = await withAiScan((tx) => staleIds(tx, before, limit));
        const out = [];
        for (const { user_id, id } of ids) {
          if (!(await isUsable(admin, user_id)).ok) continue;
          const r = await withAiUser(user_id, (tx) => fileRow(tx, user_id, id));
          if (r) out.push(r);
        }
        return out;
      },
      settle: (row, status, etag) => withAiUser(row.user_id, (tx) => settleRow(tx, row, status, etag)),
      heartbeat: (d) => withAiScan((tx) => writeHeartbeat(tx, d)),
    },
    r2: R2,
    sniff: (b) => sniffFile(b, inflateRaw),
    sha256Hex,
    path: noteFilePath,
    thumbPath: noteFileThumbPath,
    now: Date.now,
    log,
  });
});
