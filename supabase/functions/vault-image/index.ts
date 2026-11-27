// vault-image 入口（架构第 6 节 vault-image 行；B5 任务单 S8、S18）：组装依赖，逻辑在 core.ts。
// 在版本门免查名单里（shared/version-gate-list.ts，0.29 续第 77 条），入口不调 versionGate。
// 用到的库对象：service role：private.account_usable、session_alive（经 _shared/auth.ts）、private.take_rate；
//   fn_ai 直连（_shared/db.ts 的 withAiUser，6.2 A2）：private.vault 的 pin_epoch、public.note_images（读预登记的图片行）；
//   SQL 在 store.ts（store-it 拿同一份打真库）。
// R2：vault-images 桶，令牌 R2_FN_*（8.6）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL；VAULT_TOKEN_SECRET；R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX。
// 不加 CORS（0.48 第 4 条）。日志只经 _shared/fn-log.ts 记错误码。
import { serviceAdmin } from '../_shared/admin.ts';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { withAiUser } from '../_shared/db.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { r2FromEnv } from '../_shared/objstore-env.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { decodeKey32 } from '../_shared/vault-crypto.ts';
import { pinEpoch } from '../_shared/vault-epoch.ts';
import { vaultTokenChecker } from '../_shared/vault-token.ts';
import { VAULT_IMAGE_MAX_BYTES, vaultImageGet, vaultImageKey, vaultImageUploadQuery } from '../_shared/gen/schema/vault.ts';
import { handle } from './core.ts';
import { imageMeta } from './store.ts';

const log = codeLogger('vault-image');

const R2 = r2FromEnv();
const checkToken = vaultTokenChecker(decodeKey32(Deno.env.get('VAULT_TOKEN_SECRET')), Date.now, (uid) => withAiUser(uid, (tx) => pinEpoch(tx, uid)), log);

Deno.serve((req) => {
  const admin = serviceAdmin(log);
  if (admin instanceof Response) return admin;
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    takeRate: rpcTakeRate(admin),
    checkToken,
    parseUpload(q) {
      const p = vaultImageUploadQuery.safeParse(q);
      return p.success ? p.data : null;
    },
    parseGet(v) {
      const p = vaultImageGet.safeParse(v);
      return p.success ? p.data : null;
    },
    imageKey: vaultImageKey,
    maxBytes: VAULT_IMAGE_MAX_BYTES,
    image: (uid, imageId) => withAiUser(uid, (tx) => imageMeta(tx, uid, imageId)),
    r2: R2,
    now: Date.now,
    log,
  });
});
