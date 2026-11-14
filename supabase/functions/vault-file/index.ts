// vault-file 入口（架构 5.13 第 11 点、第 6 节 vault-file 行；B4b-1）：组装依赖，逻辑在 core.ts，SQL 在 store.ts。
// 两种调用：客户端带 JWT + x-vault-token 的 upload / list / get / remove / restore / ms_preview，只带 JWT 就行的 ms_preview_end（审查第 4 条，理由见 core.ts 的 enter）；
//   pg_cron 带 x-cron-secret 的 {action: sweep}（迁移 20261115010000：每分钟有过期登记才调、每 10 分钟无条件调）。
//   cron 请求没有用户 JWT，所以 config.toml 的 [functions.vault-file] verify_jwt = false，其余动作在 core 里自己 requireActiveUser。
// 版本门：不进免查名单（upload 写同步表 note_files，旧版不该写；理由写在 shared/schema/vault-file.ts 文件头）；
//   带 x-cron-secret 的请求（sweep，没有客户端版本）跳过版本门，密钥由 core 的 cronGate 核（同 file-check）。
// 用到的库对象：
//   • fn_vault 直连（_shared/db.ts 的 withVaultUser / withVaultScan，store.ts）：private.vault 的 pin_epoch、public.notes、public.note_files、
//     private.vault_preview、private.scan_vault_preview；
//   • service role（supabase-js）：private.account_usable、session_alive（经 _shared/auth.ts）、private.take_rate、app_config（版本门）、
//     private.heartbeat（心跳 vault-file-sweep）、Storage 的 vault-preview 桶（写明文预览、签名、删、列）。
// R2：vault-files 桶，令牌 R2_FN_*（8.6）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY；FN_VAULT_DB_URL；VAULT_KEY、VAULT_TOKEN_SECRET；CRON_SECRET；
//   R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX。
// 不加 CORS（0.48 第 4 条）。日志只经 _shared/fn-log.ts 记错误码（F13：本目录不准出现 console.）。
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { withVaultScan, withVaultUser } from '../_shared/db.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { json } from '../_shared/http.ts';
import { timedFetch } from '../_shared/net.ts';
import { r2FromEnv } from '../_shared/objstore-env.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';
import { decodeKey32 } from '../_shared/vault-crypto.ts';
import { CIPHER_TYPE } from '../_shared/vault-files.ts';
import { pinEpoch } from '../_shared/vault-epoch.ts';
import { vaultTokenChecker } from '../_shared/vault-token.ts';
import { versionGate } from '../_shared/version-gate.ts';
import { sanitizeFileName } from '../_shared/gen/logic/files/file-name.ts';
import { sniffFile, zipBombCheck } from '../_shared/gen/logic/files/file-sniff.ts';
import { inflateRaw } from '../_shared/gen/logic/files/inflate.ts';
import { FILE_MAX_BYTES } from '../_shared/gen/logic/files/limits.ts';
import { noteFilePath, noteFileThumbPath } from '../_shared/gen/logic/files/media-path.ts';
import { DOC_TYPES, type DocKind } from '../_shared/gen/manifests/attachments.ts';
import {
  VAULT_FILE_HEARTBEAT, VAULT_FILE_RATE_PER_MIN, VAULT_FILE_THUMB_MAX_BYTES, VAULT_FILE_UPLOAD_MAX_BODY, VAULT_PREVIEW_RATE_PER_HOUR,
  VAULT_PREVIEW_TTL_S, vaultFileMeta, vaultFileRequest,
} from '../_shared/gen/schema/vault-file.ts';
import { handle, type Preview, type Rules, type Store } from './core.ts';
import { expiredPreviews, fileOf, filesOf, insertFile, previewsOf, privateNote, registerPreview, setDeleted, unregisterPreviews } from './store.ts';

const log = codeLogger('vault-file');
const R2 = r2FromEnv();
const MASTER = decodeKey32(Deno.env.get('VAULT_KEY'));
const checkToken = vaultTokenChecker(decodeKey32(Deno.env.get('VAULT_TOKEN_SECRET')), Date.now, (uid) => withVaultUser(uid, (tx) => pinEpoch(tx, uid)), log);

const PREVIEW_BUCKET = 'vault-preview';
const SIGN_PREFIX = `/storage/v1/object/sign/${PREVIEW_BUCKET}/`;
const PREVIEW_NAME = /^[0-9a-f]{32}\.pptx$/;
const asKind = (k: string) => k as DocKind;
// 先落到显式类型再 Object.entries：发布脚本第 1 步就跑 check_backend，那时 _shared/gen 还没生成，导入的类型看不出来会报 F7（11-14 publish-run 测试红）
const DOC_TYPE_MAP: Readonly<Record<string, string>> = DOC_TYPES;
const DOC_MIME = new Map<string, string>(Object.entries(DOC_TYPE_MAP));   // kind 已经过 vaultFileMeta / 库里的 check，这里只换类型

const RULES: Rules = {
  parse(v) {
    const p = vaultFileRequest.safeParse(v);
    return p.success ? p.data : null;
  },
  parseMeta(v) {
    const p = vaultFileMeta.safeParse(v);
    return p.success ? p.data : null;
  },
  sniff: (b) => sniffFile(b, inflateRaw),
  bomb: (b) => zipBombCheck(b, inflateRaw),
  sanitizeName: (raw, kind) => sanitizeFileName(raw, asKind(kind)),
  mime: (kind) => DOC_MIME.get(kind) ?? CIPHER_TYPE,   // kind 已经过 vaultFileMeta；Map 取值，不用方括号（check_backend F7）
  fileKey: (uid, noteId, id, kind) => noteFilePath(uid, noteId, id, asKind(kind)),
  thumbKey: noteFileThumbPath,
  maxBytes: FILE_MAX_BYTES,
  thumbMaxBytes: VAULT_FILE_THUMB_MAX_BYTES,
  uploadMaxBody: VAULT_FILE_UPLOAD_MAX_BODY,
  ratePerMin: VAULT_FILE_RATE_PER_MIN,
  previewPerHour: VAULT_PREVIEW_RATE_PER_HOUR,
  previewTtlS: VAULT_PREVIEW_TTL_S,
};

const store = (admin: SupabaseClient): Store => ({
  privateNote: (uid, noteId) => withVaultUser(uid, (tx) => privateNote(tx, uid, noteId)),
  file: (uid, id) => withVaultUser(uid, (tx) => fileOf(tx, uid, id)),
  files: (uid, noteId) => withVaultUser(uid, (tx) => filesOf(tx, uid, noteId)),
  insert: (uid, row) => withVaultUser(uid, (tx) => insertFile(tx, uid, row, noteFilePath(uid, row.note_id, row.id, asKind(row.kind)))),
  setDeleted: (uid, id, at) => withVaultUser(uid, (tx) => setDeleted(tx, uid, id, at)),
  previews: (uid) => withVaultUser(uid, (tx) => previewsOf(tx, uid)),
  register: (uid, path, fileId, expiresAt) => withVaultUser(uid, (tx) => registerPreview(tx, uid, path, fileId, expiresAt)),
  unregister: (uid, paths) => withVaultUser(uid, (tx) => unregisterPreviews(tx, uid, paths)),
  expired: () => withVaultScan((tx) => expiredPreviews(tx)),
  async heartbeat(detail) {
    const { error } = await admin.schema('private').from('heartbeat')
      .upsert({ name: VAULT_FILE_HEARTBEAT, at: new Date().toISOString(), detail }, { onConflict: 'name' });
    if (error) throw new Error('heartbeat');
  },
});

const preview = (admin: SupabaseClient): Preview => {
  const bucket = () => admin.storage.from(PREVIEW_BUCKET);
  return {
    async put(path, body, opts) {
      const { error } = await bucket().upload(path, body, { contentType: opts.contentType, cacheControl: '0', upsert: false });
      if (error) throw new Error('preview_put');
    },
    async sign(path, ttlS) {
      const { data, error } = await bucket().createSignedUrl(path, ttlS);
      if (error || !data?.signedUrl) throw new Error('preview_sign');
      const u = new URL(data.signedUrl);
      if (!u.pathname.startsWith(SIGN_PREFIX)) throw new Error('preview_sign');
      return `/sb${u.pathname}${u.search}`;   // 同源经 /sb 转发（0.32 起 /sb 存储只放行这一段的 GET）
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await bucket().remove([...paths]);
      if (error) throw new Error('preview_remove');
    },
    async list() {
      const { data, error } = await bucket().list('', { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } });
      if (error) throw new Error('preview_list');
      return (data ?? []).filter((o) => PREVIEW_NAME.test(o.name) && typeof o.created_at === 'string')
        .map((o) => ({ name: o.name, created_at: Date.parse(o.created_at as string) }));
    },
  };
};

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  // cron 的 sweep 没有客户端版本；只有客户端那几支过版本门（带了 x-cron-secret 却不是 sweep 的，core 照样要 JWT；版本门不是鉴权边界）
  if (!req.headers.get('x-cron-secret')) {
    const blocked = await versionGate('vault-file', req, async (signal) => {
      const { data, error } = await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle();
      if (error) throw new Error('db');
      return data?.min_client_version ?? null;
    });
    if (blocked) return blocked;
  }
  return handle(req, {
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    takeRate: rpcTakeRate(admin),
    checkToken,
    cronSecret: Deno.env.get('CRON_SECRET'),
    master: MASTER,
    rules: RULES,
    store: store(admin),
    r2: R2,
    preview: preview(admin),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    now: Date.now,
    log,
  });
});
