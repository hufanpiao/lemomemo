// D1 的授权白名单：3.3 C（service_role、函数执行权）和 6.2 / 附录 A 末尾的逐表清单（fn_vault、fn_ai）
// 改授权时三处一起改：迁移、架构 3.3 C / 附录 A、这里；D1 双向比对，多一项、少一项都失败

/** 表级授权：'schema.table' → 权限 */
export type TableGrants = Record<string, string[]>;
/** 列级授权：'schema.table:PRIV' → 列（只列表级没给、单独按列给的） */
export type ColumnGrants = Record<string, string[]>;

export const TABLE_GRANTS: Record<'service_role' | 'fn_vault' | 'fn_ai', TableGrants> = {
  // service_role 只核对 private（public 上 Supabase 默认给了全部表级权限，第 86 条不收窄）
  service_role: {
    // INSERT：20261030140000，只给 tools/e2e/preview-login.ts --admin 写 .test 管理员行（R-279，安全说明 S-6）；不给 UPDATE、DELETE
    'private.admins': ['SELECT', 'INSERT'],
    'private.invites': ['SELECT', 'INSERT', 'UPDATE'],
    'private.pending_signups': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.deleted_accounts': ['SELECT', 'INSERT'],
    'private.pending_deletions': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.counters': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.ai_state': ['SELECT', 'INSERT', 'UPDATE'],
    'private.heartbeat': ['SELECT', 'INSERT', 'UPDATE'],
    // private.remind_queue：R-411 迁移 20261113100000 收回（只经 security definer 的 RPC 碰队列）
    'private.user_limits': ['SELECT'],
  },
  fn_vault: {
    'private.counters': ['SELECT', 'INSERT', 'UPDATE'],
    'private.webauthn_challenges': ['SELECT', 'INSERT', 'DELETE'],
    'private.vault': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.vault_credentials': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.device_secrets': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.vault_preview': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.vault_ai': ['SELECT', 'DELETE'],
    'private.note_vectors': ['DELETE'],
    'private.embed_queue': ['DELETE'],
    'private.scan_vault_preview': ['SELECT'],
    'public.notes': ['SELECT', 'INSERT', 'UPDATE'],
    'public.note_images': ['SELECT', 'INSERT', 'UPDATE'],
    'public.note_files': ['SELECT', 'INSERT', 'UPDATE'],
  },
  fn_ai: {
    'private.counters': ['SELECT', 'INSERT', 'UPDATE'],
    'private.heartbeat': ['INSERT', 'UPDATE'],
    'private.user_limits': ['SELECT'],
    'private.vault_ai': ['SELECT', 'INSERT', 'UPDATE'],
    'private.note_vectors': ['SELECT', 'INSERT', 'UPDATE'],
    'private.embed_queue': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.scan_embed_queue': ['SELECT'],
    'private.scan_note_images': ['SELECT'],
    'private.scan_note_files': ['SELECT'],
  },
};

export const COLUMN_GRANTS: Record<'fn_vault' | 'fn_ai', ColumnGrants> = {
  fn_vault: {
    'public.devices:SELECT': ['id', 'user_id', 'deleted_at', 'session_id'],   // 核对草稿密钥的 device_id 和会话
    'private.note_vectors:SELECT': ['user_id', 'note_id', 'image_id'],   // 移进移出删旧向量的 where 要读（20261114200000，B5 store-it 真库实测）
  },
  fn_ai: {
    'private.vault:SELECT': ['user_id', 'pin_epoch'],
    'private.heartbeat:SELECT': ['name', 'at', 'detail'],   // upsert 心跳要读（20261104140000，HEARTBEAT 选项 A）；策略 fn_ai_own 只放自己三个名字
    'public.events:SELECT': ['id', 'user_id', 'title', 'note', 'location', 'deleted_at'],
    'public.todos:SELECT': ['id', 'user_id', 'title', 'note', 'deleted_at'],
    'public.notes:SELECT': ['id', 'user_id', 'title', 'body', 'body_enc', 'enc_key_id', 'is_private', 'category_id', 'deleted_at'],
    'public.note_images:SELECT': ['id', 'user_id', 'note_id', 'bucket', 'path', 'has_thumb', 'mime', 'deleted_at',
      'ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at',
      'bytes'],   // bytes：vault-image 上传按预登记的字节数核对（20261114210000，B5 整块评审第 3 条）
    'public.note_images:UPDATE': ['ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at'],
    'public.note_files:SELECT': ['id', 'user_id', 'note_id', 'kind', 'path', 'has_thumb', 'is_vault', 'name', 'mime', 'bytes',
      'text_excerpt', 'text_enc', 'enc_key_id', 'deleted_at', 'etag', 'check_status', 'ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at',
      'sha256', 'created_at'],   // file-check 核哈希、补扫挑 30 分钟前的行（20261115000000，B4b-1）
    'public.note_files:UPDATE': ['check_status', 'etag', 'ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at'],
  },
};

/**
 * 同步表里客户端可写、却没有长度或取值约束的文本列的豁免名单（D1 第 11c 节，架构 0.47 第 20 条 ③，TC-B1-147）。每项必须写理由；
 * 加了约束以后 D1 会报“从白名单删掉”。fv、repeat 这类不给客户端写的列本来就不在检查范围里（只查 authenticated 有 insert / update 授权的列）。
 * 10-31 D1 查出的 9 列已按架构 0.47 第 20 条补全部加约束（迁移 20261031110000），现在名单为空
 */
export const TEXT_COLS_UNBOUNDED: Readonly<Record<string, string>> = {};

/** private 函数的执行权（3.3 C）。B1 起才建的函数也列在这里：没建时 D1 不报，建了却没授权或授多了才报 */
export const FUNCTION_EXEC: Record<'anon' | 'authenticated' | 'service_role' | 'fn_vault' | 'fn_ai', string[]> = {
  anon: [],   // 迁移 20261112090000：anon 不执行任何 private 函数（private 的 usage 也收回了）；不登录要调的放 public 的 definer（PUBLIC_RPCS_DEFINER）
  authenticated: ['is_active', 'not_password_session', 'report_tz_impl', 'claim_endpoint_impl', 'my_ai_usage_impl', 'record_consent_impl', 'remove_device_impl',
    'devices_session_guard', 'purge_deleted_impl', 'my_sessions_impl', 'touch', 'enqueue_remind', 'row_quota', 'guard_token_revoke',
    'table_meta_of', 'guard_note_image', 'guard_note_file', 'files_authorize_impl', 'media_quota_guard', 'enqueue_anniv_defaults', 'enqueue_embed', 'vault_ai_off',
    'tags_ok',   // tags_ok：B1 迁移 20261031110000，notes.tags 的 check 约束用（写 notes 的三种角色都要能执行）
    'revoke_my_sessions_impl'],   // R-382 迁移 20261111120000
  service_role: ['take_rate', 'session_alive', 'rebind_device_impl', 'long_transactions', 'auth_mail_counts', 'account_usable', 'account_request_deletion', 'account_restore',
    'export_job_start', 'export_job_take', 'db_size_bytes', 'export_size_over', 'tags_ok',
    'invite_claim', 'invite_release',   // B1 迁移 20261031150000（INVITE-late-commit）
    'orphan_auth_users',   // B1 迁移 20261031160000（ORPHAN-alert）：usage-report 数没有 profile 的 auth 用户
    'remind_queue_pop',   // B2 迁移 20261103130000（BE-2）：push-dispatch 第 0 步出队；20261104130000 换成 (int, int, boolean) 租约式（REMIND-queue-crash-loss）
    'remind_queue_finish',   // B2 迁移 20261104130000（REMIND-queue-crash-loss）：第 0 步结尾放回、按租约删
    'remind_queue_stats',   // R-411 迁移 20261113100000：usage-report、心跳读提醒队列积压（只算可用账号）
    'remind_due', 'remind_pushed',   // B2 迁移 20261103140000（BE-2 安全审查必改 1）：push-dispatch 第 1 步到点、resolve 候选的精确判断
    'push_heartbeat_write',   // B2 迁移 20261105140000（REMIND-poison-atomic）：push-dispatch 写心跳，queue_poison 原子累加
    'ai_quota_take', 'ai_quota_refund', 'intake_insert',   // B3 迁移 20261107100000：AI 额度原子预扣、退回；claude-intake 三张表一个事务写完
    'ai_classify_pending',   // B4 迁移 20261110121000（代码审查 11-10 必改 1）：ai-classify 按人取待分类的随手记
    'security_events'],   // R-382 迁移 20261111120000：usage-report 读最近 15 分钟 sfate-capped、pwrevoke-fail 两个计数
  fn_vault: ['purge_vault_impl', 'tags_ok'],
  fn_ai: [],
};

/** pg_cron 里动 public / private 数据、却故意不经 private.account_usable 的任务（TC-B0-97 ④；0.29 续第 138 条④“故意不用的”）。
 *  名单外的任务，命令或它调的 private 函数体里必须出现 account_usable。加名单要写原因 */
export const CRON_WITHOUT_USABLE: Record<string, string> = {
  'cleanup-batch': '30 天清理：冷静期里照常清理（0.29 续第 138 条④）',
  'diag-logs-expire': '诊断日志 7 天删：不分账号状态，过期就删，只删 public.diag_logs 自己的旧行（20261111200000）',
  'account-purge': '满 7 天执行注销：要处理的正是冷静期里的账号（account_usable 会把它们全排除）；命令只经 pg_net 调函数、不直接碰表，挑人在函数里（0.38 第 24、46 条）',
};

/** export 必须是 none 的表和桶（TC-B0-93；架构 0.29 续第 83 条（R-184）、续第 121、125、131 条）：
 *  9 张隐私和内部表加 tombstones、pending_deletions 共 11 张；vault-images、vault-files 两个隐私桶 */
export const EXPORT_NONE_TABLES = ['private.vault', 'private.vault_credentials', 'private.device_secrets', 'private.webauthn_challenges',
  'private.note_vectors', 'private.embed_queue', 'private.vault_preview', 'private.counters', 'private.vault_ai',
  'public.tombstones', 'private.pending_deletions'];
export const EXPORT_NONE_BUCKETS = ['vault-images', 'vault-files'];

/** fn_ai 能写的心跳名（private.heartbeat 的策略 fn_ai_own，迁移 20261104140000；架构附录 A）：只放 fn_ai 自己的定时函数。
 *  不放 ai-classify、push-dispatch、account-purge 等 service_role 函数的名字，否则 fn_ai 能替它们刷心跳、掩盖停摆。加名字要新迁移 + 这里 + 附录 A 一起改 */
export const FN_AI_HEARTBEATS = ['ai-embed', 'ai-media', 'file-check'];

/** public 里只准有这 11 个 RPC（3.3 D；0.32 加 files_authorize，只给 /files 函数用；R-382 加 session_fate、revoke_my_sessions）：除 PUBLIC_RPCS_DEFINER 外
 *  一律 security invoker；授给 authenticated、不给 service_role；anon 只准 PUBLIC_RPCS_ANON 里的 */
export const PUBLIC_RPCS = ['apply_patch', 'report_tz', 'claim_endpoint', 'remove_device', 'my_ai_usage', 'record_consent', 'my_sessions', 'purge_deleted', 'files_authorize',
  'session_fate', 'revoke_my_sessions'];
/** 不登录也能调的 public RPC（R-382：登录过期的设备没有可用 JWT，要用 anon key 查会话是不是被吊销） */
export const PUBLIC_RPCS_ANON = ['session_fate'];
/** public 里的 security definer（架构约定 10.7：不登录要调的不放 private，迁移 20261112090000）；其余一律 invoker */
export const PUBLIC_RPCS_DEFINER = ['session_fate'];

/**
 * 必须有的索引（D1 第 7 节）：public 下的索引名 → 理由 + pg_indexes.indexdef 原文（离线 PGlite 实测）。整段比对：
 * 名字在但少了列、换了列序、改成部分索引也报。反例 supabase/tests/d1-fixtures/35、36
 */
export const REQUIRED_INDEXES: Readonly<Record<string, { why: string; def: string }>> = {
  logs_account_export_idx: {
    why: '0.47 第 22 条 T2：part 取片前查本人 export 发起记录',
    // 普通索引、不是部分索引：PostgREST 传参数，通用计划用不上部分索引（迁移 20261031120000 文件头的实测）
    def: 'CREATE INDEX logs_account_export_idx ON public.logs USING btree (user_id, act, src, code)',
  },
  events_pushed_for_idx: {
    why: 'B2 BE-2 安全审查必改：remind_pushed 按 pushed_for 取 resolve 候选，不再每分钟全表扫（迁移 20261103140000）',
    def: 'CREATE INDEX events_pushed_for_idx ON public.events USING btree (pushed_for) WHERE (pushed_for IS NOT NULL)',
  },
  todos_pushed_for_idx: {
    why: 'B2 BE-2 安全审查必改：remind_pushed 按 pushed_for 取 resolve 候选，不再每分钟全表扫（迁移 20261103140000）',
    def: 'CREATE INDEX todos_pushed_for_idx ON public.todos USING btree (pushed_for) WHERE (pushed_for IS NOT NULL)',
  },
  anniversaries_pushed_for_idx: {
    why: 'B2 BE-2 安全审查必改：remind_pushed 按 pushed_for 取 resolve 候选，不再每分钟全表扫（迁移 20261103140000）',
    def: 'CREATE INDEX anniversaries_pushed_for_idx ON public.anniversaries USING btree (pushed_for) WHERE (pushed_for IS NOT NULL)',
  },
  anniversaries_remind_at_idx: {
    why: 'B2 BE-2 代码审查建议：remind_due 下界按 remind_at 取（events、todos 在 0002 已有，迁移 20261103140000）',
    def: 'CREATE INDEX anniversaries_remind_at_idx ON public.anniversaries USING btree (remind_at) WHERE ((deleted_at IS NULL) AND (remind_at IS NOT NULL))',
  },
  events_snooze_at_idx: {
    why: 'B2 BE-2 代码审查建议：remind_due 下界里的 snooze_at > p_lo 走 BitmapOr（迁移 20261103140000）',
    def: 'CREATE INDEX events_snooze_at_idx ON public.events USING btree (snooze_at) WHERE (snooze_at IS NOT NULL)',
  },
  todos_snooze_at_idx: {
    why: 'B2 BE-2 代码审查建议：remind_due 下界里的 snooze_at > p_lo 走 BitmapOr（迁移 20261103140000）',
    def: 'CREATE INDEX todos_snooze_at_idx ON public.todos USING btree (snooze_at) WHERE (snooze_at IS NOT NULL)',
  },
  anniversaries_snooze_at_idx: {
    why: 'B2 BE-2 代码审查建议：remind_due 下界里的 snooze_at > p_lo 走 BitmapOr（迁移 20261103140000）',
    def: 'CREATE INDEX anniversaries_snooze_at_idx ON public.anniversaries USING btree (snooze_at) WHERE (snooze_at IS NOT NULL)',
  },
  events_defer_until_idx: {
    why: 'B2 BE-2 代码审查建议：remind_due 下界里的 defer_until > p_lo 走 BitmapOr（迁移 20261103140000）',
    def: 'CREATE INDEX events_defer_until_idx ON public.events USING btree (defer_until) WHERE (defer_until IS NOT NULL)',
  },
  todos_defer_until_idx: {
    why: 'B2 BE-2 代码审查建议：remind_due 下界里的 defer_until > p_lo 走 BitmapOr（迁移 20261103140000）',
    def: 'CREATE INDEX todos_defer_until_idx ON public.todos USING btree (defer_until) WHERE (defer_until IS NOT NULL)',
  },
  anniversaries_defer_until_idx: {
    why: 'B2 BE-2 代码审查建议：remind_due 下界里的 defer_until > p_lo 走 BitmapOr（迁移 20261103140000）',
    def: 'CREATE INDEX anniversaries_defer_until_idx ON public.anniversaries USING btree (defer_until) WHERE (defer_until IS NOT NULL)',
  },
};

/** 把一段 SQL 原文变成整段精确匹配的正则：特殊字符转义，空白处允许任意空白（pg_get_constraintdef 的换行、缩进因版本而异） */
const exactSql = (sql: string) => new RegExp(`^${sql.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}$`);
const NOTICE_VER_RE = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[1-9][0-9]?)?$'::text";
const noticeVerKey = (k: string) => `(("left"((notice ->> '${k}'::text), 10) || lpad(substr((notice ->> '${k}'::text), 12), 2, '0'::text)) COLLATE "C")`;
/** R-273（迁移 20261030130000_core_notice_ver_order.sql）：app_config_notice_ver_order 的 pg_get_constraintdef 原文（离线 PGlite 实测）。
 *  整段精确匹配：比较符换掉、只比日期不比后缀、去掉格式守卫、改成字符串比（不补两位）等“改宽”都对不上，D1 报“缺约束”。
 *  改约束时在比 20261030130000 更晚的迁移里整段照写，并同步改这里；反例见 supabase/tests/d1-fixtures/29_notice_ver_order_loose.psql、
 *  tests/build/d1-notice-ver-order.test.ts */
export const NOTICE_VER_ORDER_DEF = `CHECK ( CASE
  WHEN (((notice ->> 'min_consent_ver'::text) ~ ${NOTICE_VER_RE}) AND ((notice ->> 'policy_ver'::text) ~ ${NOTICE_VER_RE}))
  THEN (${noticeVerKey('min_consent_ver')} <= ${noticeVerKey('policy_ver')})
  ELSE NULL::boolean END)`;

/** 必须有的约束（复合外键、unique (id, user_id)；0.29 续第 81 条、低 3）：表 → pg_get_constraintdef 要匹配的正则；
 *  第三项可选，缺约束时报这个可读名字（不写就报正则原文） */
export const REQUIRED_CONSTRAINTS: [string, RegExp, string?][] = [
  ['public.app_config', exactSql(NOTICE_VER_ORDER_DEF), 'app_config_notice_ver_order（R-273：min_consent_ver 不能晚于 policy_ver）'],
  ['public.events', /^UNIQUE \(id, user_id\)$/],
  ['public.todos', /^UNIQUE \(id, user_id\)$/],
  ['public.categories', /^UNIQUE \(id, user_id\)$/],
  ['public.notes', /^UNIQUE \(id, user_id\)$/],
  ['public.note_images', /^UNIQUE \(id, user_id\)$/],
  ['public.note_files', /^UNIQUE \(id, user_id\)$/],
  ['public.devices', /^UNIQUE \(id, user_id\)$/],
  ['public.notes', /^FOREIGN KEY \(category_id, user_id\) REFERENCES (public\.)?categories\(id, user_id\) ON DELETE SET NULL \(category_id\)$/],
  ['public.note_images', /^FOREIGN KEY \(note_id, user_id\) REFERENCES (public\.)?notes\(id, user_id\) ON DELETE CASCADE$/],
  ['public.note_files', /^FOREIGN KEY \(note_id, user_id\) REFERENCES (public\.)?notes\(id, user_id\) ON DELETE CASCADE$/],
  ['public.todo_items', /^FOREIGN KEY \(todo_id, user_id\) REFERENCES (public\.)?todos\(id, user_id\) ON DELETE CASCADE$/],   // R-350（20261113170000）：子任务挂不到别人的待办上
  ['private.device_secrets', /^FOREIGN KEY \(device_id, user_id\) REFERENCES (public\.)?devices\(id, user_id\) ON DELETE CASCADE$/],
  ['public.applied_ops', /^PRIMARY KEY \(user_id, op_id\)$/],
  ['public.tombstones', /^PRIMARY KEY \(tbl, id\)$/],
];
