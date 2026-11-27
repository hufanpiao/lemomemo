// 核心清单（3.5 第 5 点）：账号、配置、限流、同步和运行的基础设施；不随某个功能删除
import { defineManifest, type ManifestTableInput } from '../schema/manifest.ts';
import { BY_USER, SOFT_DELETE_COLS, UUID_RE } from './_common.ts';

const priv = { schema: 'private', sync: false, realtime: false, localCache: 'none', clientWritable: [], softDelete: false } satisfies Partial<ManifestTableInput>;

export const core = defineManifest({
  feature: 'core',
  owner: 'core',
  tables: [
    { name: 'profiles', schema: 'public', sync: false, realtime: false, localCache: 'none',   // 存 meta，不走增量（P-22）
      clientWritable: ['display_name', 'ui_locale', 'tz_mode', 'avatar_id', 'avatar_bytes'],   // R-384：我的头像两列（迁移 20261115080000）
      updateOnly: ['display_name', 'ui_locale', 'tz_mode', 'avatar_id', 'avatar_bytes'],
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
    { name: 'diag_logs', schema: 'public', sync: false, realtime: false, localCache: 'none',   // 诊断日志一键发送（20261111200000）：每人一行、新发的覆盖旧的，7 天删
      clientWritable: ['sent_at', 'app_version', 'body'],
      softDelete: false, backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
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
    // R-382（架构 4.1a 第 4 点，安全审 M5）：注销不删吊销记录，外键 set null 把 user_id、session_id 置空，只留 pair_hash、revoked_at；
    //   maxLifetime：保留到这次登录彻底失效、并且满 30 天——revoked_at 满 30 天、并且会话已不在 auth.sessions 才由每日清理删（cleanup_batch B1 c；
    //   安全审 M1：会话还在的不删，否则 session_alive 会把被吊销的会话当成活的）
    { ...priv, name: 'revoked_sessions', backup: 'none', export: 'none', onAccountDelete: 'keep-id-only', userLookup: BY_USER, maxLifetime: '30 days' },
    { ...priv, name: 'counters', backup: 'none', export: 'none', onAccountDelete: 'explicit',
      userLookup: { by: 'keyPattern', col: 'key', pattern: '%:<user>:%' } },
    { ...priv, name: 'ai_state', backup: 'none', export: 'none', onAccountDelete: 'keep-id-only', noUserData: true },
    // R-494 迁移 20261123090000：每个人自己的 AI 密钥记录（服务商、模型名、后四位；密钥本身在 Vault，删行时触发器一起删），不导出、不备份
    { ...priv, name: 'ai_user_keys', backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    // R-495 长期记忆：不同步、只经 ai-memory、ai-chat；账号导出由 account/export.ts 的 AI_MEMORIES_EXPORT 单独带上本人没删的。
    //   负责人 11-26 定“加进备份”：backup-daily 经 private.backup_read 读（迁移 20261126130000，服务器角色不给表级权限），整行都备（含 norm、grams、deleted_at，恢复后搜索照旧）
    { ...priv, name: 'ai_memories', backup: 'json', export: 'json', exportOmitCols: ['norm', 'grams', 'deleted_at'], exportLiveOnly: true, onAccountDelete: 'cascade', userLookup: BY_USER },
    { ...priv, name: 'heartbeat', backup: 'none', export: 'none', onAccountDelete: 'keep-id-only', noUserData: true },
    { ...priv, name: 'remind_queue', backup: 'none', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },   // R-411 迁移 20261113100000 起带 user_id 外键级联
    { ...priv, name: 'user_limits', backup: 'json', export: 'none', onAccountDelete: 'cascade', userLookup: BY_USER },
    { ...priv, name: 'table_meta', backup: 'none', export: 'none', onAccountDelete: 'keep-id-only', noUserData: true },
  ],
  buckets: [
    { name: 'backups', store: 'supabase', limits: { fileSizeLimit: 52428800, allowedMimeTypes: ['application/gzip'] },
      pathPrefix: '<date>/<user_id>/', pathPattern: '^\\d{4}-\\d{2}-\\d{2}/[0-9a-f-]{36}/[a-z_]+(\\.\\d+)?\\.json\\.gz$',
      backup: 'none', export: 'none', countsToQuota: false, orphanSweep: null,
      userLookup: { by: 'pathPattern', level: 2 } },   // 0.29 续第 84 条：按第二级目录找人
    // 吉祥物 #2（迁移 20261123120000）：只有管理员能读，不含用户数据，不备份、不导出
    { name: 'mascot-private', store: 'supabase', limits: { fileSizeLimit: 1048576, allowedMimeTypes: ['application/x-rive'] },
      pathPrefix: '', pathPattern: '^2\\.riv$', backup: 'none', export: 'none', countsToQuota: false, orphanSweep: null, noUserData: true },
    // R-384 我的头像：images 桶的 <user_id>/me/ 段（桶归 notes）；100 KB、算进存储额度，孤儿按 profiles.avatar_id 清（迁移 20261115080000）
    { name: 'images', store: 'r2', pathPrefix: '<user_id>/me/', maxBytes: 102400, pathPattern: `^${UUID_RE}/me/${UUID_RE}\\.webp$`,
      backup: 'weekly-s3', export: 'zip', countsToQuota: true,
      orphanSweep: { after: '24 hours', table: 'profiles', col: 'avatar_id' }, userLookup: { by: 'pathPattern', level: 1 } },
  ],
  // cal.* 归日历（calendar.ts，MANIFEST-settings-prefix，架构 3.5 第 5 点：各功能声明自己用到的键前缀）
  settingsKeys: ['ui.*', 'remind.*', 'ai.*', 'desk.*', 'layout.*'],
  usageReport: { rows: true, buckets: true },
});
