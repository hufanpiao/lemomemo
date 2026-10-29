// 核心清单（3.5 第 5 点）：账号、配置、限流、同步和运行的基础设施；不随某个功能删除
import { defineManifest, type ManifestTableInput } from '../schema/manifest.ts';
import { BY_USER, SOFT_DELETE_COLS } from './_common.ts';

const priv = { schema: 'private', sync: false, realtime: false, localCache: 'none', clientWritable: [], softDelete: false } satisfies Partial<ManifestTableInput>;

export const core = defineManifest({
  feature: 'core',
  owner: 'core',
  tables: [
    { name: 'profiles', schema: 'public', sync: false, realtime: false, localCache: 'none',   // 存 meta，不走增量（P-22）
      clientWritable: ['display_name', 'ui_locale', 'tz_mode'], updateOnly: ['display_name', 'ui_locale', 'tz_mode'],
      softDelete: false, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER, rebuildable: true },
    { name: 'settings', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'key', 'value', ...SOFT_DELETE_COLS], insertOnly: ['id', 'key'], updateOnly: [...SOFT_DELETE_COLS],
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      systemCols: [], noConflict: ['value'] },
    { name: 'devices', schema: 'public', sync: true, realtime: true, localCache: 'plain',
      clientWritable: ['id', 'label', 'platform', 'app_version', 'last_seen_at', 'install_id', ...SOFT_DELETE_COLS],
      insertOnly: ['id', 'platform', 'install_id'], updateOnly: [...SOFT_DELETE_COLS], clientDelete: true,
      softDelete: true, backup: 'json', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER,
      systemCols: ['last_push_ok_at', 'push_fail_count', 'created_at'], noConflict: ['last_seen_at', 'app_version'],   // created_at：B1 迁移 20261029192000 加（0.38 第 8 条）
      exportOmitCols: ['push_endpoint', 'p256dh', 'auth', 'session_id'] },   // 导出不带推送订阅的密钥和会话 id（K3 安全审查低 8）
    { name: 'tombstones', schema: 'public', sync: 'tombstone', realtime: true, localCache: 'none', clientWritable: [],
      softDelete: false, backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { name: 'api_tokens', schema: 'public', sync: false, realtime: false, localCache: 'none',   // 连接码页打开时现查
      clientWritable: ['revoked_at'], updateOnly: ['revoked_at'],
      softDelete: false, backup: 'json', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { name: 'applied_ops', schema: 'public', sync: false, realtime: false, localCache: 'none',
      clientWritable: ['op_id', 'result'], insertOnly: ['op_id', 'result'],
      softDelete: false, backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { name: 'logs', schema: 'public', sync: false, realtime: false, localCache: 'none',   // 只上传
      clientWritable: ['t', 'device', 'kind', 'act', 'src', 'coll', 'item_id', 'fields', 'code'],
      insertOnly: ['t', 'device', 'kind', 'act', 'src', 'coll', 'item_id', 'fields', 'code'],
      softDelete: false, backup: 'none', export: 'json', onAccountDelete: 'cascade', userLookup: BY_USER },
    { name: 'app_config', schema: 'public', sync: false, realtime: false, localCache: 'none', clientWritable: [],
      anonReadable: ['id', 'min_client_version', 'latest_version', 'notice'],
      softDelete: false, backup: 'json', export: 'none', onAccountDelete: 'keep-id-only', noUserData: true },
    { ...priv, name: 'admins', backup: 'json', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { ...priv, name: 'invites', backup: 'json', export: 'none', onAccountDelete: 'keep-id-only',   // created_by 置空，邀请码行留着
      userLookup: { by: 'column', col: 'created_by' } },
    { ...priv, name: 'pending_signups', backup: 'none', export: 'none', onAccountDelete: 'explicit',
      userLookup: { by: 'emailHash', col: 'email_hash' } },
    { ...priv, name: 'webauthn_challenges', backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { ...priv, name: 'deleted_accounts', backup: 'json', export: 'none', onAccountDelete: 'keep-id-only', userLookup: BY_USER },
    { ...priv, name: 'pending_deletions', backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { ...priv, name: 'revoked_sessions', backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { ...priv, name: 'counters', backup: 'none', export: 'none', onAccountDelete: 'explicit',
      userLookup: { by: 'keyPattern', col: 'key', pattern: '%:<user>:%' } },
    { ...priv, name: 'ai_state', backup: 'none', export: 'none', onAccountDelete: 'keep-id-only', noUserData: true },
    { ...priv, name: 'heartbeat', backup: 'none', export: 'none', onAccountDelete: 'keep-id-only', noUserData: true },
    { ...priv, name: 'remind_queue', backup: 'none', export: 'none', onAccountDelete: 'explicit',
      userLookup: { by: 'rowRef', tableCol: 'table_name', idCol: 'id' } },
    { ...priv, name: 'user_limits', backup: 'json', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { ...priv, name: 'table_meta', backup: 'none', export: 'none', onAccountDelete: 'keep-id-only', noUserData: true },
  ],
  buckets: [
    { name: 'backups', store: 'supabase', limits: { fileSizeLimit: 52428800, allowedMimeTypes: ['application/gzip'] },
      pathPrefix: '<date>/<user_id>/', pathPattern: '^\\d{4}-\\d{2}-\\d{2}/[0-9a-f-]{36}/[a-z_]+(\\.\\d+)?\\.json\\.gz$',
      backup: 'none', export: 'none', countsToQuota: false, orphanSweep: null,
      userLookup: { by: 'pathPattern', level: 2 } },   // 0.29 续第 84 条：按第二级目录找人
  ],
  settingsKeys: ['ui.*', 'cal.*', 'remind.*', 'ai.*', 'desk.*', 'layout.*'],
  usageReport: { rows: true, buckets: true },
});
