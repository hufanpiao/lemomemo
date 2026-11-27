// backup-daily 入口（架构第 10 节、第 6 节 backup-daily 行）：cron 函数，鉴权是 x-cron-secret（config.toml 关了网关的 verify_jwt，F9）。
// 每天首尔 00:30 由 pg_cron 调 private.backup_dispatch('start') 给每个可用账号各发一次，02:30 再补跑一次没做完的（'retry'），
// publish.ps1 改库前发 'publish'（迁移 20261126130000）；一个人的数据一段写不完时，本函数自己带 x-cron-secret 调自己接着写（core.ts 文件头“分段”）。
// 逻辑和测试见 core.ts、tests/edge/backup-daily.test.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；CRON_SECRET。
// 用到的库对象：private.account_usable（经 _shared/auth.ts）、private.take_rate、private.heartbeat；清单里 backup: 'json' 的表（service role 只读）；
//   隐私记四张表和 AI 长期记忆经 private.backup_read（只读函数，service role 没有这几张表的表级权限）；
//   backups 桶（Supabase Storage，supabase-js）。不直连数据库，不碰 R2。
// 版本门：免查（shared/version-gate-list.ts，pg_cron 调、没有客户端版本）。
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { serviceAdminOrNull } from '../_shared/admin.ts';
import { isUsable } from '../_shared/auth.ts';
import { background } from '../_shared/background.ts';
import { codeLogger } from '../_shared/fn-log.ts';
import { allManifests } from '../_shared/gen/manifests/index.ts';
import { writeHeartbeat } from '../_shared/heartbeat.ts';
import { timedFetch } from '../_shared/net.ts';
import { listDir, STORAGE_LIST_LIMIT } from '../_shared/storage-list.ts';
import { rpcTakeRate } from '../_shared/take-rate.ts';
import { BACKUP_BUCKET, backupTablesOf, HEARTBEAT, handle, type BackupFiles, type BackupStore } from './core.ts';

/** 一页最多几 MB，给宽一点 */
const DB_REQUEST_TIMEOUT_MS = 20_000;
/** 发下一段：等到下一段写完它自己那一段、回了响应为止（下一段的下一段在它的后台发，不算在这里） */
const NEXT_TIMEOUT_MS = 60_000;

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

const TABLES = backupTablesOf(allManifests);
const log = codeLogger('backup-daily');

function makeStore(admin: Admin): BackupStore {
  const priv = admin.schema('private');
  return {
    async readPage(t, userId, after, limit) {
      if (t.rpc) {
        const { data, error } = await priv.rpc('backup_read', { p_table: t.name, p_user: userId, p_after: after, p_limit: limit });
        if (error || !Array.isArray(data)) throw new Error('db');
        return data as Record<string, unknown>[];
      }
      const base = (t.schema === 'private' ? priv : admin).from(t.name).select('*').eq(t.lookupCol, userId);
      const q = after === null ? base : base.gt(t.keyCol, after);
      const { data, error } = await q.order(t.keyCol, { ascending: true }).limit(limit);
      if (error || !Array.isArray(data)) throw new Error('db');
      return data as Record<string, unknown>[];
    },
    writeHeartbeat: (detail) => writeHeartbeat(admin, HEARTBEAT, detail),
    takeRate: rpcTakeRate(admin),
  };
}

function makeFiles(admin: Admin): BackupFiles {
  const bucket = () => admin.storage.from(BACKUP_BUCKET);
  return {
    async list(dir) {
      // 文件夹（id 为 null）这一层不该有，不算文件
      return (await listDir(bucket, dir)).filter((o) => !o.folder).map((o) => ({ name: o.name, updatedAt: o.updatedAt }));
    },
    async read(path) {
      const { data, error } = await bucket().download(path);
      if (error) {
        // 不存在（404）回 null；别的错误照抛（不能把读不到当成“没有”）
        const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status;
        if (String(status) === '404' || /not.?found/i.test(error.message)) return null;
        throw new Error('storage');
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(paths) {
      for (let i = 0; i < paths.length; i += STORAGE_LIST_LIMIT) {
        const { error } = await bucket().remove(paths.slice(i, i + STORAGE_LIST_LIMIT));
        if (error) throw new Error('storage');
      }
    },
    async upload(path, body, opts) {
      const { error } = await bucket().upload(path, body, { contentType: opts.contentType, upsert: true, cacheControl: 'no-store' });
      if (error) throw new Error('storage');
    },
    async create(path, body, opts) {
      // 不覆盖（x-upsert: false）：已经有了时 Storage 回 HTTP 400、正文 statusCode "409"、code KeyAlreadyExists
      // （本机 lemo-e2e 实测；文档错误码表写 409、上传指南写 400，两种都认）。同一个名字同时上传 6 份只建成 1 份
      const { error } = await bucket().upload(path, body, { contentType: opts.contentType, upsert: false, cacheControl: 'no-store' });
      if (!error) return true;
      const e = error as { statusCode?: unknown; code?: unknown };
      if (String(e.statusCode) === '409' || e.code === 'KeyAlreadyExists') return false;
      throw new Error('storage');
    },
  };
}

/** SUPABASE_URL 的项目 ref（https://<ref>.supabase.co）；本机（http://kong:8000 一类）取主机名 */
function projectOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') ? host.split('.')[0] ?? null : host;
  } catch {
    return null;
  }
}

Deno.serve((req) => {
  const admin = serviceAdminOrNull(DB_REQUEST_TIMEOUT_MS);
  const cronSecret = Deno.env.get('CRON_SECRET');
  const base = Deno.env.get('SUPABASE_URL');
  const project = projectOf(base);
  const post = timedFetch(fetch, NEXT_TIMEOUT_MS);
  return handle(req, {
    cronSecret,
    store: admin ? makeStore(admin) : null,
    files: admin ? makeFiles(admin) : null,
    tables: TABLES,
    async isUsable(userId) {
      if (!admin) throw new Error('misconfigured');
      return (await isUsable(admin, userId)).ok;
    },
    async next(body) {
      if (!base || !cronSecret) throw new Error('misconfigured');
      const r = await post(`${base}/functions/v1/backup-daily`, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-region': 'ap-northeast-2', 'x-cron-secret': cronSecret },
        body: JSON.stringify(body),
      });
      await r.body?.cancel();
      return r.status;
    },
    background,
    now: Date.now,
    log,
    ...(project ? { project } : {}),
  });
});
