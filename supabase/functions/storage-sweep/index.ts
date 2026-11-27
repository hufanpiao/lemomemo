// storage-sweep 入口（架构 3.4、第 6 节 storage-sweep 行）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每天 17:30 UTC（首尔 02:30）由 pg_cron 经 pg_net 调一次（迁移 20261126100000_ops_storage_sweep_usage.sql）。逻辑和测试见 core.ts、tests/functions/storage-sweep.test.ts。
// 数据库只经 supabase-js（service role）读定位列：note_images (id, user_id, note_id, bucket, has_thumb, deleted_at)、
//   note_files (id, user_id, note_id, kind, has_thumb, is_vault, check_status, deleted_at)、anniversaries (id, user_id, avatar_id, deleted_at)、
//   profiles (user_id, avatar_id)（授权登记在 0003、0004、0005 和本批迁移，架构 3.3 C）；写 private.heartbeat。不直连数据库、不读私有表。
// R2 经 _shared/objstore-env.ts（第 6 节 R2 九个函数之一）；backups 桶（Supabase Storage，supabase-js）只列目录、删过期的日期目录里的文件（B7a 收口第 2 条）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；CRON_SECRET；R2_ENDPOINT、R2_FN_ACCESS_KEY_ID、R2_FN_SECRET_ACCESS_KEY、R2_BUCKET_PREFIX（8.4）。
// 版本门：免查（shared/version-gate-list.ts，pg_cron 调、没有客户端版本）。
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { serviceAdminOrNull } from '../_shared/admin.ts';
import { BACKUP_BUCKET } from '../_shared/backup-format.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { writeHeartbeat } from '../_shared/heartbeat.ts';
import { r2FromEnv } from '../_shared/objstore-env.ts';
import { listDir } from '../_shared/storage-list.ts';
import { inChunks } from '../_shared/user-reads.ts';
import { HEARTBEAT, handle, type AnnivRow, type FileRow, type ImageRow, type ProfileRow, type SweepBackups, type SweepStore } from './core.ts';

/** supabase-js 每次请求最长等多久（一轮按页查，每页最多 1000 个键、分 100 个一批） */
const DB_REQUEST_TIMEOUT_MS = 15_000;

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw new Error('db');
  return (r.data ?? []) as T;
}

function makeStore(admin: Admin): SweepStore {
  return {
    images: (ids) => inChunks(ids, async (c) => must<ImageRow[]>(await admin.from('note_images').select('id, user_id, note_id, bucket, has_thumb, deleted_at').in('id', c))),
    files: (ids) => inChunks(ids, async (c) => must<FileRow[]>(await admin.from('note_files').select('id, user_id, note_id, kind, has_thumb, is_vault, check_status, deleted_at').in('id', c))),
    annivs: (ids) => inChunks(ids, async (c) => must<AnnivRow[]>(await admin.from('anniversaries').select('id, user_id, avatar_id, deleted_at').in('id', c))),
    profiles: (ids) => inChunks(ids, async (c) => must<ProfileRow[]>(await admin.from('profiles').select('user_id, avatar_id').in('user_id', c))),
    writeHeartbeat: (detail) => writeHeartbeat(admin, HEARTBEAT, detail),
  };
}

function makeBackups(admin: Admin): SweepBackups {
  const bucket = () => admin.storage.from(BACKUP_BUCKET);
  return {
    async list(dir) {
      return (await listDir(bucket, dir)).map((o) => ({ name: o.name, folder: o.folder }));
    },
    async remove(paths) {
      const { error } = await bucket().remove([...paths]);
      if (error) throw new Error('storage');
    },
  };
}

const log = codeLogger('storage-sweep');

Deno.serve((req) => {
  const admin = serviceAdminOrNull(DB_REQUEST_TIMEOUT_MS);
  return handle(req, {
    cronSecret: Deno.env.get('CRON_SECRET'),
    store: admin ? makeStore(admin) : null,
    r2: r2FromEnv(),   // 没配齐、地址不是 https 等回 null：鉴权之后由 core.ts 回 misconfigured
    backups: admin ? makeBackups(admin) : null,
    now: Date.now,
    log,
  });
});
