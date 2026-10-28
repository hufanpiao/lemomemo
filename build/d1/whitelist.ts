// D1 的授权白名单：3.3 C（service_role、函数执行权）和 6.2 / 附录 A 末尾的逐表清单（fn_vault、fn_ai）
// 改授权时三处一起改：迁移、架构 3.3 C / 附录 A、这里；D1 双向比对，多一项、少一项都失败

/** 表级授权：'schema.table' → 权限 */
export type TableGrants = Record<string, string[]>;
/** 列级授权：'schema.table:PRIV' → 列（只列表级没给、单独按列给的） */
export type ColumnGrants = Record<string, string[]>;

export const TABLE_GRANTS: Record<'service_role' | 'fn_vault' | 'fn_ai', TableGrants> = {
  // service_role 只核对 private（public 上 Supabase 默认给了全部表级权限，第 86 条不收窄）
  service_role: {
    'private.admins': ['SELECT'],
    'private.invites': ['SELECT', 'INSERT', 'UPDATE'],
    'private.pending_signups': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.deleted_accounts': ['SELECT', 'INSERT'],
    'private.pending_deletions': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.counters': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    'private.ai_state': ['SELECT', 'INSERT', 'UPDATE'],
    'private.heartbeat': ['SELECT', 'INSERT', 'UPDATE'],
    'private.remind_queue': ['SELECT', 'INSERT', 'DELETE'],
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
  },
  fn_ai: {
    'private.vault:SELECT': ['user_id', 'pin_epoch'],
    'public.events:SELECT': ['id', 'user_id', 'title', 'note', 'location', 'deleted_at'],
    'public.todos:SELECT': ['id', 'user_id', 'title', 'note', 'deleted_at'],
    'public.notes:SELECT': ['id', 'user_id', 'title', 'body', 'body_enc', 'enc_key_id', 'is_private', 'category_id', 'deleted_at'],
    'public.note_images:SELECT': ['id', 'user_id', 'note_id', 'bucket', 'path', 'has_thumb', 'mime', 'deleted_at',
      'ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at'],
    'public.note_images:UPDATE': ['ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at'],
    'public.note_files:SELECT': ['id', 'user_id', 'note_id', 'kind', 'path', 'has_thumb', 'is_vault', 'name', 'mime', 'bytes',
      'text_excerpt', 'text_enc', 'enc_key_id', 'deleted_at', 'etag', 'check_status', 'ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at'],
    'public.note_files:UPDATE': ['check_status', 'etag', 'ai_status', 'skip_reason', 'ai_desc', 'ai_tags', 'ai_tries', 'ai_next_at'],
  },
};

/** private 函数的执行权（3.3 C）。B1 起才建的函数也列在这里：没建时 D1 不报，建了却没授权或授多了才报 */
export const FUNCTION_EXEC: Record<'authenticated' | 'service_role' | 'fn_vault' | 'fn_ai', string[]> = {
  authenticated: ['is_active', 'report_tz_impl', 'claim_endpoint_impl', 'my_ai_usage_impl', 'record_consent_impl', 'remove_device_impl',
    'devices_session_guard', 'purge_deleted_impl', 'my_sessions_impl', 'touch', 'enqueue_remind', 'row_quota', 'guard_token_revoke',
    'table_meta_of', 'guard_note_file', 'files_authorize_impl', 'enqueue_anniv_defaults', 'enqueue_embed', 'vault_ai_off'],
  service_role: ['take_rate', 'session_alive', 'rebind_device_impl', 'long_transactions', 'account_usable'],
  fn_vault: ['purge_vault_impl'],
  fn_ai: [],
};

/** public 里只准有这九个 RPC（3.3 D；0.32 加 files_authorize，只给 /files 函数用），一律 security invoker、只授给 authenticated */
export const PUBLIC_RPCS = ['apply_patch', 'report_tz', 'claim_endpoint', 'remove_device', 'my_ai_usage', 'record_consent', 'my_sessions', 'purge_deleted', 'files_authorize'];

/** 必须有的约束（复合外键、unique (id, user_id)；0.29 续第 81 条、低 3）：表 → pg_get_constraintdef 要匹配的正则 */
export const REQUIRED_CONSTRAINTS: [string, RegExp][] = [
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
  ['private.device_secrets', /^FOREIGN KEY \(device_id, user_id\) REFERENCES (public\.)?devices\(id, user_id\) ON DELETE CASCADE$/],
  ['public.applied_ops', /^PRIMARY KEY \(user_id, op_id\)$/],
  ['public.tombstones', /^PRIMARY KEY \(tbl, id\)$/],
];
