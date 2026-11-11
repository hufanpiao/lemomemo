// 自动生成，不要手改（build/gen_manifests_snapshot.mjs，11-05 首屏瘦身）：完整快照 manifests.gen.ts 里每张表的 name、schema、sync、rebuildable，
// 顺序同 allTables（清单顺序、表顺序）。首屏建本机仓（cache-schema.ts 的 syncStores）只要这几项
import type { ManifestTable } from '../../shared/schema/manifest.ts';

export type SyncTableLite = Pick<ManifestTable, 'name' | 'schema' | 'sync' | 'rebuildable'>;

export const syncTableSnapshot: readonly SyncTableLite[] = [
  {
    "name": "profiles",
    "schema": "public",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "settings",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "devices",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "tombstones",
    "schema": "public",
    "sync": "tombstone",
    "rebuildable": true
  },
  {
    "name": "api_tokens",
    "schema": "public",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "applied_ops",
    "schema": "public",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "logs",
    "schema": "public",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "diag_logs",
    "schema": "public",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "app_config",
    "schema": "public",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "admins",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "invites",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "pending_signups",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "webauthn_challenges",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "deleted_accounts",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "pending_deletions",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "revoked_sessions",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "counters",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "ai_state",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "heartbeat",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "remind_queue",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "user_limits",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "table_meta",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "events",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "todos",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "categories",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "notes",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "note_images",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "note_files",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "anniversaries",
    "schema": "public",
    "sync": true,
    "rebuildable": true
  },
  {
    "name": "vault",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "vault_credentials",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "device_secrets",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "vault_ai",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "vault_preview",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "note_vectors",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  },
  {
    "name": "embed_queue",
    "schema": "private",
    "sync": false,
    "rebuildable": true
  }
];
