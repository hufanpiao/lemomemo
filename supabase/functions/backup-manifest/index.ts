// backup-manifest 入口（架构第 6 节 backup-manifest 行、第 10 节）：负责人本机的 tools/backup/pull.ps1 经 https://lemomemo.com/sb/functions/v1/backup-manifest 调，
// 带 Authorization: Bearer <BACKUP_PULL_TOKEN>，不带 JWT（config.toml 关了网关的 verify_jwt；check_backend F9 的 BEARER_SECRET_FUNCTIONS 名单）。
// 逻辑和测试见 core.ts、tests/edge/backup-manifest.test.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；BACKUP_PULL_TOKEN（8.4，负责人本机凭据管理器里存同一个值，只有这个函数读）。
// 用到的库对象：backups 桶（列目录、签名）、private.deleted_accounts（只读）、private.take_rate、private.heartbeat（写 backup-pull 一行）。不直连数据库，不碰 R2。
// 版本门：免查（shared/version-gate-list.ts，脚本调用、没有客户端版本）。
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { serviceAdminOrNull } from '../_shared/admin.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { writeHeartbeat } from '../_shared/heartbeat.ts';
import { listDir } from '../_shared/storage-list.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { BACKUP_BUCKET, HEARTBEAT, handle, type ManifestStore } from './core.ts';

const SIGN_BATCH = 100;

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function makeStore(admin: Admin): ManifestStore {
  const bucket = () => admin.storage.from(BACKUP_BUCKET);
  return {
    list: (dir) => listDir(bucket, dir),
    async sign(paths, expiresInS) {
      const out: string[] = [];
      for (let i = 0; i < paths.length; i += SIGN_BATCH) {
        const { data, error } = await bucket().createSignedUrls(paths.slice(i, i + SIGN_BATCH), expiresInS);
        if (error || !Array.isArray(data)) throw new Error('storage');
        for (const r of data) {
          if (r.error || !r.signedUrl) throw new Error('storage');
          out.push(r.signedUrl);
        }
      }
      return out;
    },
    async deletedAccounts() {
      const { data, error } = await admin.schema('private').from('deleted_accounts').select('user_id, deleted_at').order('deleted_at');
      if (error || !Array.isArray(data)) throw new Error('db');
      return data as { user_id: string; deleted_at: string | null }[];
    },
    takeRate: rpcTakeRate(admin),
    writeHeartbeat: (detail) => writeHeartbeat(admin, HEARTBEAT, detail),
  };
}

const log = codeLogger('backup-manifest');

Deno.serve((req) => {
  const admin = serviceAdminOrNull();
  return handle(req, {
    pullToken: Deno.env.get('BACKUP_PULL_TOKEN'),
    store: admin ? makeStore(admin) : null,
    now: Date.now,
    log,
  });
});
