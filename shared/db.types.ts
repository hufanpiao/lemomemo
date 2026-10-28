// 【临时】数据库类型：由 supabase/tests/offline/gen-db-types.mjs 从 7 个迁移生成（没有 Docker，跑不了 supabase gen types）
// 待 Docker：npx supabase gen types typescript --local --schema public,private > shared/db.types.ts 替换本文件（形状相同，调用方不用改）
// 不要手改：改迁移以后重新生成

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      anniversaries: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; kind: string; name: string; calendar: string; lunar_variant: string; month: number; day: number; is_leap: boolean; year: number | null; remind_offsets: number[] | null; remind_time: string | null; next_date: string | null; after_due: string; archived_at: number | null; push_show_title: boolean | null; remind_at: number | null; notified_for: number | null; snooze_at: number | null; pushed_for: number | null; defer_until: number | null; note: string; created_at: number; updated_at: number; avatar_id: string | null; avatar_bytes: number | null };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; kind: string; name: string; calendar: string; lunar_variant?: string; month: number; day: number; is_leap?: boolean; year?: number | null; remind_offsets?: number[] | null; remind_time?: string | null; next_date?: string | null; after_due?: string; archived_at?: number | null; push_show_title?: boolean | null; remind_at?: number | null; notified_for?: number | null; snooze_at?: number | null; pushed_for?: number | null; defer_until?: number | null; note?: string; created_at: number; updated_at: number; avatar_id?: string | null; avatar_bytes?: number | null };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; kind?: string; name?: string; calendar?: string; lunar_variant?: string; month?: number; day?: number; is_leap?: boolean; year?: number | null; remind_offsets?: number[] | null; remind_time?: string | null; next_date?: string | null; after_due?: string; archived_at?: number | null; push_show_title?: boolean | null; remind_at?: number | null; notified_for?: number | null; snooze_at?: number | null; pushed_for?: number | null; defer_until?: number | null; note?: string; created_at?: number; updated_at?: number; avatar_id?: string | null; avatar_bytes?: number | null };
      };
      api_tokens: {
        Row: { id: string; user_id: string; label: string | null; token_hash: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
        Insert: { id?: string; user_id: string; label?: string | null; token_hash: string; scopes?: string[]; created_at?: string; last_used_at?: string | null; revoked_at?: string | null };
        Update: { id?: string; user_id?: string; label?: string | null; token_hash?: string; scopes?: string[]; created_at?: string; last_used_at?: string | null; revoked_at?: string | null };
      };
      app_config: {
        Row: { id: number; min_client_version: string | null; latest_version: string | null; features: Json; ai: Json; notice: Json | null; limits: Json };
        Insert: { id?: number; min_client_version?: string | null; latest_version?: string | null; features?: Json; ai: Json; notice?: Json | null; limits?: Json };
        Update: { id?: number; min_client_version?: string | null; latest_version?: string | null; features?: Json; ai?: Json; notice?: Json | null; limits?: Json };
      };
      applied_ops: {
        Row: { op_id: string; user_id: string; at: string; result: Json | null };
        Insert: { op_id: string; user_id?: string; at?: string; result?: Json | null };
        Update: { op_id?: string; user_id?: string; at?: string; result?: Json | null };
      };
      categories: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; name: string; color: string | null; sort: number; created_by: string; merged_into: string | null };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; name: string; color?: string | null; sort?: number; created_by?: string; merged_into?: string | null };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; name?: string; color?: string | null; sort?: number; created_by?: string; merged_into?: string | null };
      };
      devices: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; label: string | null; platform: string; push_endpoint: string | null; p256dh: string | null; auth: string | null; app_version: string | null; last_seen_at: string | null; last_push_ok_at: string | null; push_fail_count: number; session_id: string | null; install_id: string | null };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; label?: string | null; platform: string; push_endpoint?: string | null; p256dh?: string | null; auth?: string | null; app_version?: string | null; last_seen_at?: string | null; last_push_ok_at?: string | null; push_fail_count?: number; session_id?: string | null; install_id?: string | null };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; label?: string | null; platform?: string; push_endpoint?: string | null; p256dh?: string | null; auth?: string | null; app_version?: string | null; last_seen_at?: string | null; last_push_ok_at?: string | null; push_fail_count?: number; session_id?: string | null; install_id?: string | null };
      };
      events: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; title: string; date: string; time: string | null; tz: string | null; duration_min: number; project: string; note: string; source: string; raw_text: string; location: string; short: string | null; short_by: string | null; push_show_title: boolean | null; batch_id: string | null; repeat: Json | null; repeat_skip: string[]; remind_min: number | null; remind_days: number | null; remind_at: number | null; notified_for: number | null; snooze_at: number | null; pushed_for: number | null; defer_until: number | null; ai_status: string; created_at: number; updated_at: number };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; title: string; date: string; time?: string | null; tz?: string | null; duration_min?: number; project?: string; note?: string; source?: string; raw_text?: string; location?: string; short?: string | null; short_by?: string | null; push_show_title?: boolean | null; batch_id?: string | null; repeat?: Json | null; repeat_skip?: string[]; remind_min?: number | null; remind_days?: number | null; remind_at?: number | null; notified_for?: number | null; snooze_at?: number | null; pushed_for?: number | null; defer_until?: number | null; ai_status?: string; created_at: number; updated_at: number };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; title?: string; date?: string; time?: string | null; tz?: string | null; duration_min?: number; project?: string; note?: string; source?: string; raw_text?: string; location?: string; short?: string | null; short_by?: string | null; push_show_title?: boolean | null; batch_id?: string | null; repeat?: Json | null; repeat_skip?: string[]; remind_min?: number | null; remind_days?: number | null; remind_at?: number | null; notified_for?: number | null; snooze_at?: number | null; pushed_for?: number | null; defer_until?: number | null; ai_status?: string; created_at?: number; updated_at?: number };
      };
      logs: {
        Row: { id: number; user_id: string; t: number; device: string | null; kind: string | null; act: string | null; src: string | null; coll: string | null; item_id: string | null; fields: string[] | null; code: string | null };
        Insert: { id?: number; user_id?: string; t: number; device?: string | null; kind?: string | null; act?: string | null; src?: string | null; coll?: string | null; item_id?: string | null; fields?: string[] | null; code?: string | null };
        Update: { id?: number; user_id?: string; t?: number; device?: string | null; kind?: string | null; act?: string | null; src?: string | null; coll?: string | null; item_id?: string | null; fields?: string[] | null; code?: string | null };
      };
      note_files: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; note_id: string; kind: string; path: string; has_thumb: boolean; is_vault: boolean; name: string | null; mime: string; bytes: number; sha256: string; pages: number | null; text_excerpt: string | null; name_enc: string | null; text_enc: string | null; dek_enc: string | null; enc_key_id: number | null; etag: string | null; check_status: string; ai_status: string; skip_reason: string | null; ai_desc: string | null; ai_tags: string[]; ai_tries: number; ai_next_at: number | null; created_at: number; updated_at: number };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; note_id: string; kind: string; path: string; has_thumb?: boolean; is_vault?: boolean; name?: string | null; mime: string; bytes: number; sha256: string; pages?: number | null; text_excerpt?: string | null; name_enc?: string | null; text_enc?: string | null; dek_enc?: string | null; enc_key_id?: number | null; etag?: string | null; check_status?: string; ai_status?: string; skip_reason?: string | null; ai_desc?: string | null; ai_tags?: string[]; ai_tries?: number; ai_next_at?: number | null; created_at: number; updated_at: number };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; note_id?: string; kind?: string; path?: string; has_thumb?: boolean; is_vault?: boolean; name?: string | null; mime?: string; bytes?: number; sha256?: string; pages?: number | null; text_excerpt?: string | null; name_enc?: string | null; text_enc?: string | null; dek_enc?: string | null; enc_key_id?: number | null; etag?: string | null; check_status?: string; ai_status?: string; skip_reason?: string | null; ai_desc?: string | null; ai_tags?: string[]; ai_tries?: number; ai_next_at?: number | null; created_at?: number; updated_at?: number };
      };
      note_images: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; note_id: string; bucket: string; path: string; bytes: number; width: number | null; height: number | null; mime: string; taken_at: number | null; has_thumb: boolean; ai_status: string; skip_reason: string | null; ai_desc: string | null; ai_tags: string[]; ai_tries: number; ai_next_at: number | null };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; note_id: string; bucket: string; path: string; bytes: number; width?: number | null; height?: number | null; mime?: string; taken_at?: number | null; has_thumb?: boolean; ai_status?: string; skip_reason?: string | null; ai_desc?: string | null; ai_tags?: string[]; ai_tries?: number; ai_next_at?: number | null };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; note_id?: string; bucket?: string; path?: string; bytes?: number; width?: number | null; height?: number | null; mime?: string; taken_at?: number | null; has_thumb?: boolean; ai_status?: string; skip_reason?: string | null; ai_desc?: string | null; ai_tags?: string[]; ai_tries?: number; ai_next_at?: number | null };
      };
      notes: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; title: string | null; body: string | null; is_private: boolean; body_enc: string | null; enc_key_id: number | null; category_id: string | null; category_source: string; category_seen: boolean; ai_status: string; ai_meta: Json | null; tags: string[]; converted_to: Json | null; source: string; raw_text: string; batch_id: string | null; created_at: number; updated_at: number };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; title?: string | null; body?: string | null; is_private?: boolean; body_enc?: string | null; enc_key_id?: number | null; category_id?: string | null; category_source?: string; category_seen?: boolean; ai_status?: string; ai_meta?: Json | null; tags?: string[]; converted_to?: Json | null; source?: string; raw_text?: string; batch_id?: string | null; created_at: number; updated_at: number };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; title?: string | null; body?: string | null; is_private?: boolean; body_enc?: string | null; enc_key_id?: number | null; category_id?: string | null; category_source?: string; category_seen?: boolean; ai_status?: string; ai_meta?: Json | null; tags?: string[]; converted_to?: Json | null; source?: string; raw_text?: string; batch_id?: string | null; created_at?: number; updated_at?: number };
      };
      profiles: {
        Row: { user_id: string; display_name: string | null; ui_locale: string; tz_mode: string; current_tz: string; current_tz_device: string | null; current_tz_at: string | null; disabled_at: string | null; disabled_reason: string | null; created_at: string; consent_ai_at: string | null; consent_policy_ver: string | null; beta_features: string[] };
        Insert: { user_id: string; display_name?: string | null; ui_locale?: string; tz_mode?: string; current_tz?: string; current_tz_device?: string | null; current_tz_at?: string | null; disabled_at?: string | null; disabled_reason?: string | null; created_at?: string; consent_ai_at?: string | null; consent_policy_ver?: string | null; beta_features?: string[] };
        Update: { user_id?: string; display_name?: string | null; ui_locale?: string; tz_mode?: string; current_tz?: string; current_tz_device?: string | null; current_tz_at?: string | null; disabled_at?: string | null; disabled_reason?: string | null; created_at?: string; consent_ai_at?: string | null; consent_policy_ver?: string | null; beta_features?: string[] };
      };
      settings: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; key: string; value: Json };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; key: string; value: Json };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; key?: string; value?: Json };
      };
      todos: {
        Row: { id: string; user_id: string; rev: number; fv: Json; deleted_at: number | null; undone: boolean; synced_at: string; legacy_id: string | null; title: string; done: boolean; due: string | null; important: boolean; project: string; note: string; source: string; raw_text: string; batch_id: string | null; from_note_id: string | null; from_anniv_id: string | null; short: string | null; short_by: string | null; repeat: Json | null; repeat_skip: string[]; done_at: number; remind_days: number | null; remind_time: string; push_show_title: boolean | null; due_time: string | null; remind_before_min: number | null; remind_at: number | null; notified_for: number | null; snooze_at: number | null; pushed_for: number | null; defer_until: number | null; ai_status: string; created_at: number; updated_at: number };
        Insert: { id: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; title: string; done?: boolean; due?: string | null; important?: boolean; project?: string; note?: string; source?: string; raw_text?: string; batch_id?: string | null; from_note_id?: string | null; from_anniv_id?: string | null; short?: string | null; short_by?: string | null; repeat?: Json | null; repeat_skip?: string[]; done_at?: number; remind_days?: number | null; remind_time?: string; push_show_title?: boolean | null; due_time?: string | null; remind_before_min?: number | null; remind_at?: number | null; notified_for?: number | null; snooze_at?: number | null; pushed_for?: number | null; defer_until?: number | null; ai_status?: string; created_at: number; updated_at: number };
        Update: { id?: string; user_id?: string; rev?: number; fv?: Json; deleted_at?: number | null; undone?: boolean; synced_at?: string; legacy_id?: string | null; title?: string; done?: boolean; due?: string | null; important?: boolean; project?: string; note?: string; source?: string; raw_text?: string; batch_id?: string | null; from_note_id?: string | null; from_anniv_id?: string | null; short?: string | null; short_by?: string | null; repeat?: Json | null; repeat_skip?: string[]; done_at?: number; remind_days?: number | null; remind_time?: string; push_show_title?: boolean | null; due_time?: string | null; remind_before_min?: number | null; remind_at?: number | null; notified_for?: number | null; snooze_at?: number | null; pushed_for?: number | null; defer_until?: number | null; ai_status?: string; created_at?: number; updated_at?: number };
      };
      tombstones: {
        Row: { tbl: string; id: string; user_id: string; deleted_at: string };
        Insert: { tbl: string; id: string; user_id: string; deleted_at?: string };
        Update: { tbl?: string; id?: string; user_id?: string; deleted_at?: string };
      };
    };
    Views: {
    };
    Functions: {
      purge_deleted: { Args: { p_items?: Json }; Returns: number };
      record_consent: { Args: { policy_ver: string; revoke?: boolean }; Returns: undefined };
    };
  };
  private: {
    Tables: {
      admins: {
        Row: { user_id: string };
        Insert: { user_id: string };
        Update: { user_id?: string };
      };
      ai_state: {
        Row: { provider: string; exhausted_until: string | null };
        Insert: { provider: string; exhausted_until?: string | null };
        Update: { provider?: string; exhausted_until?: string | null };
      };
      counters: {
        Row: { key: string; window_start: string; count: number | null };
        Insert: { key: string; window_start: string; count?: number | null };
        Update: { key?: string; window_start?: string; count?: number | null };
      };
      deleted_accounts: {
        Row: { user_id: string; deleted_at: string | null };
        Insert: { user_id: string; deleted_at?: string | null };
        Update: { user_id?: string; deleted_at?: string | null };
      };
      device_secrets: {
        Row: { device_id: string; user_id: string; draft_salt: string; enc_key_id: number; created_at: string };
        Insert: { device_id: string; user_id: string; draft_salt: string; enc_key_id: number; created_at?: string };
        Update: { device_id?: string; user_id?: string; draft_salt?: string; enc_key_id?: number; created_at?: string };
      };
      embed_queue: {
        Row: { kind: string; source_id: string; user_id: string; queued_at: string; tries: number; next_at: string | null; model: string };
        Insert: { kind: string; source_id: string; user_id: string; queued_at?: string; tries?: number; next_at?: string | null; model?: string };
        Update: { kind?: string; source_id?: string; user_id?: string; queued_at?: string; tries?: number; next_at?: string | null; model?: string };
      };
      heartbeat: {
        Row: { name: string; at: string; detail: Json | null };
        Insert: { name: string; at: string; detail?: Json | null };
        Update: { name?: string; at?: string; detail?: Json | null };
      };
      invites: {
        Row: { code_hash: string; created_by: string | null; max_uses: number | null; used_count: number | null; expires_at: string | null; note: string | null };
        Insert: { code_hash: string; created_by?: string | null; max_uses?: number | null; used_count?: number | null; expires_at?: string | null; note?: string | null };
        Update: { code_hash?: string; created_by?: string | null; max_uses?: number | null; used_count?: number | null; expires_at?: string | null; note?: string | null };
      };
      note_vectors: {
        Row: { user_id: string; kind: string; source_id: string; is_vault: boolean; note_id: string | null; image_id: string | null; file_id: string | null; event_id: string | null; todo_id: string | null; model: string; content_hash: string; embedding: string; updated_at: string };
        Insert: { user_id: string; kind: string; source_id: string; is_vault?: boolean; note_id?: string | null; image_id?: string | null; file_id?: string | null; event_id?: string | null; todo_id?: string | null; model: string; content_hash: string; embedding: string; updated_at?: string };
        Update: { user_id?: string; kind?: string; source_id?: string; is_vault?: boolean; note_id?: string | null; image_id?: string | null; file_id?: string | null; event_id?: string | null; todo_id?: string | null; model?: string; content_hash?: string; embedding?: string; updated_at?: string };
      };
      pending_deletions: {
        Row: { user_id: string; requested_at: string; purge_after: string; notice_sent: boolean; purge_started_at: string | null };
        Insert: { user_id: string; requested_at?: string; purge_after: string; notice_sent?: boolean; purge_started_at?: string | null };
        Update: { user_id?: string; requested_at?: string; purge_after?: string; notice_sent?: boolean; purge_started_at?: string | null };
      };
      pending_signups: {
        Row: { email_hash: string; otp_hash: string; tries: number; expires_at: string };
        Insert: { email_hash: string; otp_hash: string; tries?: number; expires_at: string };
        Update: { email_hash?: string; otp_hash?: string; tries?: number; expires_at?: string };
      };
      remind_queue: {
        Row: { table_name: string; id: string };
        Insert: { table_name: string; id: string };
        Update: { table_name?: string; id?: string };
      };
      revoked_sessions: {
        Row: { session_id: string; user_id: string; revoked_at: string };
        Insert: { session_id: string; user_id: string; revoked_at?: string };
        Update: { session_id?: string; user_id?: string; revoked_at?: string };
      };
      table_meta: {
        Row: { tbl: string; system_cols: string[]; no_conflict: string[] };
        Insert: { tbl: string; system_cols: string[]; no_conflict: string[] };
        Update: { tbl?: string; system_cols?: string[]; no_conflict?: string[] };
      };
      user_limits: {
        Row: { user_id: string; media_mb: number | null; media_daily: number | null; search_daily: number | null };
        Insert: { user_id: string; media_mb?: number | null; media_daily?: number | null; search_daily?: number | null };
        Update: { user_id?: string; media_mb?: number | null; media_daily?: number | null; search_daily?: number | null };
      };
      vault: {
        Row: { user_id: string; pin_hash: string; pin_epoch: number; fail_count: number | null; lock_level: number | null; locked_until: string | null; last_reset_at: string | null };
        Insert: { user_id: string; pin_hash: string; pin_epoch?: number; fail_count?: number | null; lock_level?: number | null; locked_until?: string | null; last_reset_at?: string | null };
        Update: { user_id?: string; pin_hash?: string; pin_epoch?: number; fail_count?: number | null; lock_level?: number | null; locked_until?: string | null; last_reset_at?: string | null };
      };
      vault_ai: {
        Row: { kind: string; source_id: string; user_id: string; image_id: string | null; file_id: string | null; desc_enc: string; tags_enc: string; enc_key_id: number; updated_at: string };
        Insert: { kind: string; source_id: string; user_id: string; image_id?: string | null; file_id?: string | null; desc_enc: string; tags_enc: string; enc_key_id: number; updated_at?: string };
        Update: { kind?: string; source_id?: string; user_id?: string; image_id?: string | null; file_id?: string | null; desc_enc?: string; tags_enc?: string; enc_key_id?: number; updated_at?: string };
      };
      vault_credentials: {
        Row: { credential_id: string; user_id: string; public_key: string; sign_count: number; device_label: string | null };
        Insert: { credential_id: string; user_id: string; public_key: string; sign_count?: number; device_label?: string | null };
        Update: { credential_id?: string; user_id?: string; public_key?: string; sign_count?: number; device_label?: string | null };
      };
      vault_preview: {
        Row: { path: string; user_id: string; file_id: string; created_at: string; expires_at: string };
        Insert: { path: string; user_id: string; file_id: string; created_at?: string; expires_at: string };
        Update: { path?: string; user_id?: string; file_id?: string; created_at?: string; expires_at?: string };
      };
      webauthn_challenges: {
        Row: { challenge: string; user_id: string; expires_at: string };
        Insert: { challenge: string; user_id: string; expires_at: string };
        Update: { challenge?: string; user_id?: string; expires_at?: string };
      };
    };
    Views: {
      scan_embed_queue: {
        Row: { kind: string | null; source_id: string | null; model: string | null; user_id: string | null; next_at: string | null };
      };
      scan_note_files: {
        Row: { id: string | null; user_id: string | null; check_status: string | null; ai_status: string | null; ai_next_at: number | null };
      };
      scan_note_images: {
        Row: { id: string | null; user_id: string | null; ai_status: string | null; ai_next_at: number | null };
      };
      scan_vault_preview: {
        Row: { path: string | null; user_id: string | null; expires_at: string | null };
      };
    };
    Functions: {
    };
  };
};

export type Tables<S extends keyof Database, T extends keyof Database[S]['Tables']> = Database[S]['Tables'][T] extends { Row: infer R } ? R : never;
export type TablesInsert<S extends keyof Database, T extends keyof Database[S]['Tables']> = Database[S]['Tables'][T] extends { Insert: infer R } ? R : never;
export type TablesUpdate<S extends keyof Database, T extends keyof Database[S]['Tables']> = Database[S]['Tables'][T] extends { Update: infer R } ? R : never;
