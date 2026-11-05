// 自动生成，不要手改（build/gen_manifests_snapshot.mjs，B2 FA-6 ③）：shared/manifests 经 defineManifest 校验后的结果。
// 改了 shared/manifests 或 shared/schema/manifest.ts 以后跑 node build/gen_manifests_snapshot.mjs
/* eslint-disable max-lines -- 生成的数据，行数随清单走 */
import type { Manifest } from '../../shared/schema/manifest.ts';

export const manifestSnapshot: readonly Manifest[] = [
  {
    "feature": "core",
    "owner": "core",
    "tables": [
      {
        "name": "profiles",
        "schema": "public",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [
          "display_name",
          "ui_locale",
          "tz_mode"
        ],
        "insertOnly": [],
        "updateOnly": [
          "display_name",
          "ui_locale",
          "tz_mode"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "settings",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "key",
          "value",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "key"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [],
        "noConflict": [
          "value"
        ],
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "devices",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "label",
          "platform",
          "app_version",
          "last_seen_at",
          "install_id",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "platform",
          "install_id"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": true,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [
          "last_push_ok_at",
          "push_fail_count",
          "created_at"
        ],
        "noConflict": [
          "last_seen_at",
          "app_version"
        ],
        "rebuildable": true,
        "exportOmitCols": [
          "push_endpoint",
          "p256dh",
          "auth",
          "session_id"
        ]
      },
      {
        "name": "tombstones",
        "schema": "public",
        "sync": "tombstone",
        "realtime": true,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "api_tokens",
        "schema": "public",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [
          "revoked_at"
        ],
        "insertOnly": [],
        "updateOnly": [
          "revoked_at"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "applied_ops",
        "schema": "public",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [
          "op_id",
          "result"
        ],
        "insertOnly": [
          "op_id",
          "result"
        ],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "logs",
        "schema": "public",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [
          "t",
          "device",
          "kind",
          "act",
          "src",
          "coll",
          "item_id",
          "fields",
          "code"
        ],
        "insertOnly": [
          "t",
          "device",
          "kind",
          "act",
          "src",
          "coll",
          "item_id",
          "fields",
          "code"
        ],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "app_config",
        "schema": "public",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [
          "id",
          "min_client_version",
          "latest_version",
          "notice"
        ],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "keep-id-only",
        "noUserData": true,
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "admins",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "invites",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "keep-id-only",
        "userLookup": {
          "by": "column",
          "col": "created_by"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "pending_signups",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "explicit",
        "userLookup": {
          "by": "emailHash",
          "col": "email_hash"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "webauthn_challenges",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "deleted_accounts",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "keep-id-only",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "pending_deletions",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "revoked_sessions",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "counters",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "explicit",
        "userLookup": {
          "by": "keyPattern",
          "col": "key",
          "pattern": "%:<user>:%"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "ai_state",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "keep-id-only",
        "noUserData": true,
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "heartbeat",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "keep-id-only",
        "noUserData": true,
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "remind_queue",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "explicit",
        "userLookup": {
          "by": "rowRef",
          "tableCol": "table_name",
          "idCol": "id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "user_limits",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "table_meta",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "keep-id-only",
        "noUserData": true,
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [
      {
        "name": "backups",
        "store": "supabase",
        "limits": {
          "fileSizeLimit": 52428800,
          "allowedMimeTypes": [
            "application/gzip"
          ]
        },
        "pathPrefix": "<date>/<user_id>/",
        "pathPattern": "^\\d{4}-\\d{2}-\\d{2}/[0-9a-f-]{36}/[a-z_]+(\\.\\d+)?\\.json\\.gz$",
        "backup": "none",
        "export": "none",
        "countsToQuota": false,
        "orphanSweep": null,
        "userLookup": {
          "by": "pathPattern",
          "level": 2
        }
      }
    ],
    "recordKinds": [],
    "settingsKeys": [
      "ui.*",
      "cal.*",
      "remind.*",
      "ai.*",
      "desk.*",
      "layout.*"
    ],
    "usageReport": {
      "rows": true,
      "buckets": true
    },
    "extraEmbedSources": []
  },
  {
    "feature": "calendar",
    "owner": "feature",
    "tables": [
      {
        "name": "events",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "title",
          "date",
          "time",
          "tz",
          "duration_min",
          "project",
          "note",
          "source",
          "raw_text",
          "location",
          "short",
          "short_by",
          "push_show_title",
          "batch_id",
          "remind_min",
          "remind_days",
          "notified_for",
          "snooze_at",
          "created_at",
          "updated_at",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "created_at"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [
          "pushed_for",
          "defer_until",
          "ai_status",
          "remind_at"
        ],
        "noConflict": [
          "notified_for",
          "snooze_at",
          "updated_at"
        ],
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [],
    "recordKinds": [
      {
        "kind": "event",
        "table": "events",
        "flag": "event",
        "ai": {
          "parse": true,
          "intent": true
        },
        "plusResult": true,
        "vector": {
          "fk": "event_id"
        }
      }
    ],
    "settingsKeys": [],
    "ai": {
      "sendsToAI": true,
      "functions": [
        "ai-parse",
        "ai-voice",
        "ai-embed"
      ],
      "vectors": {
        "events": [
          "title",
          "note",
          "location"
        ]
      }
    },
    "usageReport": {
      "rows": true,
      "buckets": false
    },
    "extraEmbedSources": []
  },
  {
    "feature": "todos",
    "owner": "feature",
    "tables": [
      {
        "name": "todos",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "title",
          "done",
          "due",
          "important",
          "project",
          "note",
          "source",
          "raw_text",
          "batch_id",
          "from_note_id",
          "from_anniv_id",
          "short",
          "short_by",
          "done_at",
          "remind_days",
          "remind_time",
          "due_time",
          "remind_before_min",
          "push_show_title",
          "notified_for",
          "snooze_at",
          "created_at",
          "updated_at",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "created_at"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [
          "pushed_for",
          "defer_until",
          "ai_status",
          "remind_at"
        ],
        "noConflict": [
          "notified_for",
          "snooze_at",
          "updated_at"
        ],
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [],
    "recordKinds": [
      {
        "kind": "todo",
        "table": "todos",
        "flag": "todo",
        "ai": {
          "parse": true,
          "intent": true
        },
        "plusResult": true,
        "vector": {
          "fk": "todo_id"
        }
      }
    ],
    "settingsKeys": [],
    "ai": {
      "sendsToAI": true,
      "functions": [
        "ai-parse",
        "ai-voice",
        "ai-embed"
      ],
      "vectors": {
        "todos": [
          "title",
          "note"
        ]
      }
    },
    "usageReport": {
      "rows": true,
      "buckets": false
    },
    "extraEmbedSources": []
  },
  {
    "feature": "notes",
    "owner": "feature",
    "tables": [
      {
        "name": "categories",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "name",
          "color",
          "sort",
          "created_by",
          "merged_into",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [],
        "noConflict": [
          "sort"
        ],
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "notes",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "title",
          "body",
          "is_private",
          "category_id",
          "category_source",
          "category_seen",
          "tags",
          "converted_to",
          "source",
          "raw_text",
          "batch_id",
          "created_at",
          "updated_at",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "is_private",
          "created_at"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "vaultRows": {
          "flag": "is_private",
          "cipherCols": [
            "body_enc",
            "enc_key_id"
          ],
          "plainColsMustBeNull": [
            "title",
            "body",
            "raw_text",
            "tags",
            "ai_meta",
            "converted_to"
          ],
          "neutralCols": [
            "id",
            "user_id",
            "rev",
            "fv",
            "deleted_at",
            "undone",
            "synced_at",
            "is_private",
            "category_id",
            "category_source",
            "category_seen",
            "ai_status",
            "source",
            "batch_id",
            "created_at",
            "updated_at"
          ]
        },
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [
          "ai_status",
          "ai_meta"
        ],
        "noConflict": [
          "updated_at"
        ],
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "note_images",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "note_id",
          "bucket",
          "path",
          "bytes",
          "width",
          "height",
          "mime",
          "taken_at",
          "has_thumb",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "note_id",
          "bucket",
          "path",
          "bytes",
          "width",
          "height",
          "mime",
          "taken_at",
          "has_thumb"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "vaultRows": {
          "flag": "bucket = 'vault-images'",
          "cipherCols": [],
          "plainColsMustBeNull": [
            "taken_at",
            "ai_desc",
            "ai_tags"
          ],
          "neutralCols": [
            "id",
            "user_id",
            "rev",
            "fv",
            "deleted_at",
            "undone",
            "synced_at",
            "note_id",
            "bucket",
            "path",
            "bytes",
            "width",
            "height",
            "mime",
            "has_thumb",
            "ai_status",
            "skip_reason",
            "ai_tries",
            "ai_next_at"
          ]
        },
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [
          "ai_status",
          "skip_reason",
          "ai_desc",
          "ai_tags",
          "ai_tries",
          "ai_next_at"
        ],
        "noConflict": [],
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [
      {
        "name": "images",
        "store": "r2",
        "limits": {
          "fileSizeLimit": 2097152,
          "allowedMimeTypes": [
            "image/webp"
          ]
        },
        "pathPrefix": "<user_id>/",
        "pathPattern": "^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\\.t)?\\.webp$",
        "backup": "weekly-s3",
        "export": "zip",
        "countsToQuota": true,
        "orphanSweep": {
          "after": "24 hours",
          "table": "note_images",
          "col": "path"
        },
        "userLookup": {
          "by": "pathPattern",
          "level": 1
        }
      }
    ],
    "recordKinds": [
      {
        "kind": "note",
        "table": "notes",
        "flag": "note",
        "ai": {
          "parse": true,
          "intent": true
        },
        "plusResult": true,
        "vector": {
          "fk": "note_id"
        }
      },
      {
        "kind": "image",
        "table": "note_images",
        "flag": "note",
        "ai": {
          "parse": false,
          "intent": false
        },
        "plusResult": true,
        "vector": {
          "fk": "image_id"
        }
      }
    ],
    "settingsKeys": [
      "notes.*"
    ],
    "ai": {
      "sendsToAI": true,
      "functions": [
        "ai-classify",
        "ai-media",
        "ai-embed"
      ],
      "vectors": {
        "notes": [
          "title",
          "body",
          "body_enc",
          "category_id",
          "is_private"
        ],
        "note_images": [
          "ai_desc",
          "ai_tags"
        ]
      }
    },
    "usageReport": {
      "rows": true,
      "buckets": true
    },
    "extraEmbedSources": []
  },
  {
    "feature": "attachments",
    "owner": "feature",
    "tables": [
      {
        "name": "note_files",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "note_id",
          "kind",
          "path",
          "has_thumb",
          "name",
          "mime",
          "bytes",
          "sha256",
          "pages",
          "text_excerpt",
          "created_at",
          "updated_at",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "note_id",
          "kind",
          "path",
          "has_thumb",
          "mime",
          "bytes",
          "sha256",
          "pages",
          "text_excerpt",
          "created_at"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "vaultRows": {
          "flag": "is_vault",
          "cipherCols": [
            "name_enc",
            "text_enc",
            "dek_enc",
            "enc_key_id"
          ],
          "plainColsMustBeNull": [
            "name",
            "text_excerpt",
            "ai_desc",
            "ai_tags"
          ],
          "neutralCols": [
            "id",
            "user_id",
            "rev",
            "fv",
            "deleted_at",
            "undone",
            "synced_at",
            "note_id",
            "kind",
            "path",
            "has_thumb",
            "is_vault",
            "mime",
            "bytes",
            "sha256",
            "pages",
            "etag",
            "check_status",
            "ai_status",
            "skip_reason",
            "ai_tries",
            "ai_next_at",
            "created_at",
            "updated_at"
          ]
        },
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [
          "ai_status",
          "skip_reason",
          "ai_desc",
          "ai_tags",
          "ai_tries",
          "ai_next_at",
          "check_status",
          "etag"
        ],
        "noConflict": [
          "updated_at"
        ],
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [
      {
        "name": "files",
        "store": "r2",
        "limits": {
          "fileSizeLimit": 10485760,
          "allowedMimeTypes": [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.ms-word.document.macroEnabled.12",
            "application/vnd.ms-excel.sheet.macroEnabled.12",
            "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
            "image/webp"
          ]
        },
        "pathPrefix": "<user_id>/",
        "pathPattern": "^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\\.(pdf|docx|xlsx|pptx|docm|xlsm|pptm|doc|xls|ppt)|\\.t\\.webp)$",
        "backup": "weekly-s3",
        "export": "zip",
        "countsToQuota": true,
        "orphanSweep": {
          "after": "24 hours",
          "table": "note_files",
          "col": "path"
        },
        "userLookup": {
          "by": "pathPattern",
          "level": 1
        }
      }
    ],
    "recordKinds": [
      {
        "kind": "file",
        "table": "note_files",
        "flag": "note",
        "ai": {
          "parse": false,
          "intent": false
        },
        "plusResult": true,
        "vector": {
          "fk": "file_id"
        }
      }
    ],
    "settingsKeys": [],
    "ai": {
      "sendsToAI": true,
      "functions": [
        "ai-media",
        "ai-embed"
      ],
      "vectors": {
        "note_files": [
          "ai_desc",
          "ai_tags",
          "name",
          "text_excerpt"
        ]
      }
    },
    "usageReport": {
      "rows": true,
      "buckets": true
    },
    "extraEmbedSources": []
  },
  {
    "feature": "anniv",
    "owner": "feature",
    "tables": [
      {
        "name": "anniversaries",
        "schema": "public",
        "sync": true,
        "realtime": true,
        "localCache": "plain",
        "clientWritable": [
          "id",
          "kind",
          "name",
          "calendar",
          "lunar_variant",
          "month",
          "day",
          "is_leap",
          "year",
          "remind_offsets",
          "remind_time",
          "after_due",
          "push_show_title",
          "notified_for",
          "snooze_at",
          "note",
          "created_at",
          "updated_at",
          "avatar_id",
          "avatar_bytes",
          "deleted_at",
          "undone"
        ],
        "insertOnly": [
          "id",
          "created_at"
        ],
        "updateOnly": [
          "deleted_at",
          "undone"
        ],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": true,
        "backup": "json",
        "export": "json",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "systemCols": [
          "pushed_for",
          "defer_until",
          "remind_at",
          "next_date",
          "archived_at"
        ],
        "noConflict": [
          "notified_for",
          "snooze_at",
          "updated_at"
        ],
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [
      {
        "name": "images",
        "store": "r2",
        "pathPrefix": "<user_id>/anniv/",
        "pathPattern": "^[0-9a-f-]{36}/anniv/[0-9a-f-]{36}/[0-9a-f-]{36}\\.webp$",
        "backup": "weekly-s3",
        "export": "zip",
        "countsToQuota": true,
        "orphanSweep": {
          "after": "24 hours",
          "table": "anniversaries",
          "col": "avatar_id"
        },
        "userLookup": {
          "by": "pathPattern",
          "level": 1
        }
      }
    ],
    "recordKinds": [
      {
        "kind": "anniv",
        "table": "anniversaries",
        "flag": "anniv",
        "ai": {
          "parse": true,
          "intent": false
        },
        "plusResult": false,
        "vector": null
      }
    ],
    "settingsKeys": [
      "anniv.*"
    ],
    "usageReport": {
      "rows": true,
      "buckets": false
    },
    "extraEmbedSources": []
  },
  {
    "feature": "vault",
    "owner": "core",
    "tables": [
      {
        "name": "vault",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "vault_credentials",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "device_secrets",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "vault_ai",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "json",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "vault_preview",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [
      {
        "name": "vault-images",
        "store": "r2",
        "limits": {
          "fileSizeLimit": 2097152,
          "allowedMimeTypes": [
            "image/webp"
          ]
        },
        "pathPrefix": "<user_id>/",
        "pathPattern": "^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\\.t)?\\.webp$",
        "backup": "weekly-s3",
        "export": "none",
        "countsToQuota": true,
        "orphanSweep": {
          "after": "24 hours",
          "table": "note_images",
          "col": "path"
        },
        "userLookup": {
          "by": "pathPattern",
          "level": 1
        }
      },
      {
        "name": "vault-files",
        "store": "r2",
        "limits": {
          "fileSizeLimit": 10551296,
          "allowedMimeTypes": [
            "application/octet-stream"
          ]
        },
        "pathPrefix": "<user_id>/",
        "pathPattern": "^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\\.(pdf|docx|xlsx|pptx|docm|xlsm|pptm|doc|xls|ppt)|\\.t\\.webp)$",
        "backup": "weekly-s3",
        "export": "none",
        "countsToQuota": true,
        "orphanSweep": {
          "after": "24 hours",
          "table": "note_files",
          "col": "path"
        },
        "userLookup": {
          "by": "pathPattern",
          "level": 1
        }
      },
      {
        "name": "vault-preview",
        "store": "supabase",
        "limits": {
          "fileSizeLimit": 10485760,
          "allowedMimeTypes": [
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          ]
        },
        "pathPrefix": "",
        "pathPattern": "^[0-9a-f]{32}\\.pptx$",
        "backup": "none",
        "export": "none",
        "countsToQuota": false,
        "orphanSweep": null,
        "maxLifetime": "link_ttl + 1 minute",
        "userLookup": {
          "by": "registry",
          "table": "private.vault_preview",
          "col": "user_id"
        }
      }
    ],
    "recordKinds": [],
    "settingsKeys": [
      "vault.*"
    ],
    "usageReport": {
      "rows": true,
      "buckets": true
    },
    "extraEmbedSources": []
  },
  {
    "feature": "search",
    "owner": "core",
    "tables": [
      {
        "name": "note_vectors",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      },
      {
        "name": "embed_queue",
        "schema": "private",
        "sync": false,
        "realtime": false,
        "localCache": "none",
        "clientWritable": [],
        "insertOnly": [],
        "updateOnly": [],
        "anonReadable": [],
        "clientDelete": false,
        "softDelete": false,
        "backup": "none",
        "export": "none",
        "onAccountDelete": "cascade",
        "userLookup": {
          "by": "column",
          "col": "user_id"
        },
        "rebuildable": true,
        "exportOmitCols": []
      }
    ],
    "buckets": [],
    "recordKinds": [],
    "settingsKeys": [],
    "usageReport": {
      "rows": true,
      "buckets": false
    },
    "extraEmbedSources": [
      "private.vault_ai"
    ]
  }
];
