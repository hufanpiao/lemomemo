// vault-image 入口（架构第 6 节 vault-image 行；B5 任务单 S8、S18）：组装依赖，逻辑在 core.ts。
// 在版本门免查名单里（shared/version-gate-list.ts，0.29 续第 77 条），入口不调 versionGate。
// 用到的库对象：service role：private.account_usable、session_alive（经 _shared/auth.ts）、private.take_rate；
//   fn_ai 直连（_shared/db.ts 的 withAiUser，6.2 A2）：private.vault 的 pin_epoch、public.notes（核对是本人没删的隐私记）、public.note_images（读图片行）；
//   SQL 在 store.ts（store-it 拿同一份打真库）。
// R2：vault-images 桶，令牌 R2_FN_*（8.6）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_AI_DB_URL；VAULT_TOKEN_SECRET；R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX。
// 不加 CORS（0.48 第 4 条）。日志只经 _shared/fn-log.ts 记错误码。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AuthError, requireActiveUser } from '../_shared/auth.ts';
import { withAiUser } from '../_shared/db.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { json } from '../_shared/http.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { decodeKey32 } from '../_shared/vault-crypto.ts';
import { vaultTokenChecker } from '../_shared/vault-token.ts';
import { createObjStore } from '../_shared/gen/objstore.ts';
import { VAULT_IMAGE_MAX_BYTES, vaultImageGet, vaultImageKey, vaultImageUploadQuery } from '../_shared/gen/schema/vault.ts';
import { handle, type Obj } from './core.ts';
import { imageMeta, ownsPrivateNote, pinEpoch } from './store.ts';

const log = codeLogger('vault-image');

function makeR2(): Obj | null {
  const endpoint = Deno.env.get('R2_ENDPOINT');
  const accessKeyId = Deno.env.get('R2_FN_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_FN_SECRET_ACCESS_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return createObjStore({
    endpoint, accessKeyId, secretAccessKey, bucketPrefix: Deno.env.get('R2_BUCKET_PREFIX') ?? '',
    fetch: (url, init) => timedFetch(fetch)(url, init as RequestInit), now: () => Date.now(),
  });
}

const R2 = makeR2();
const checkToken = vaultTokenChecker(decodeKey32(Deno.env.get('VAULT_TOKEN_SECRET')), Date.now, (uid) => withAiUser(uid, (tx) => pinEpoch(tx, uid)), log);

Deno.serve((req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const priv = admin.schema('private');
  return handle(req, {
    async authenticate(r) {
      try {
        return { ok: true, user: { userId: (await requireActiveUser(r, admin)).userId } };
      } catch (e) {
        if (e instanceof AuthError) return { ok: false, response: e.toResponse() };
        throw e;
      }
    },
    async takeRate(k, limit, windowS) {
      const { data, error } = await priv.rpc('take_rate', { p_key: k, p_limit: limit, p_window_s: windowS });
      if (error || typeof data !== 'boolean') throw new Error('db');
      return data;
    },
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
    ownsPrivateNote: (uid, noteId) => withAiUser(uid, (tx) => ownsPrivateNote(tx, uid, noteId)),
    image: (uid, imageId) => withAiUser(uid, (tx) => imageMeta(tx, uid, imageId)),
    r2: R2,
    now: Date.now,
    log,
  });
});
