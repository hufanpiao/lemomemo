
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "private": {
          Tables: {
            "admins": {
                  Row: {
                    "user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "user_id": string
                  }
                  Update: {
                    "user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ai_state": {
                  Row: {
                    "exhausted_until": string | null,"provider": string
                  }
                  ComputedFields: never
                  Insert: {
                    "exhausted_until"?: string | null,"provider": string
                  }
                  Update: {
                    "exhausted_until"?: string | null,"provider"?: string
                  }
                  Relationships: [
                    
                  ]
                },"counters": {
                  Row: {
                    "count": number | null,"key": string,"window_start": string
                  }
                  ComputedFields: never
                  Insert: {
                    "count"?: number | null,"key": string,"window_start": string
                  }
                  Update: {
                    "count"?: number | null,"key"?: string,"window_start"?: string
                  }
                  Relationships: [
                    
                  ]
                },"deleted_accounts": {
                  Row: {
                    "deleted_at": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "deleted_at"?: string | null,"user_id": string
                  }
                  Update: {
                    "deleted_at"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"device_secrets": {
                  Row: {
                    "created_at": string,"device_id": string,"draft_salt": string,"enc_key_id": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"device_id": string,"draft_salt": string,"enc_key_id": number,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"device_id"?: string,"draft_salt"?: string,"enc_key_id"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"embed_queue": {
                  Row: {
                    "kind": string,"model": string,"next_at": string | null,"queued_at": string,"source_id": string,"tries": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "kind": string,"model"?: string,"next_at"?: string | null,"queued_at"?: string,"source_id": string,"tries"?: number,"user_id": string
                  }
                  Update: {
                    "kind"?: string,"model"?: string,"next_at"?: string | null,"queued_at"?: string,"source_id"?: string,"tries"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"heartbeat": {
                  Row: {
                    "at": string,"detail": Json | null,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "at": string,"detail"?: Json | null,"name": string
                  }
                  Update: {
                    "at"?: string,"detail"?: Json | null,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"invites": {
                  Row: {
                    "code_hash": string,"created_by": string | null,"expires_at": string | null,"max_uses": number | null,"note": string | null,"used_count": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "code_hash": string,"created_by"?: string | null,"expires_at"?: string | null,"max_uses"?: number | null,"note"?: string | null,"used_count"?: number | null
                  }
                  Update: {
                    "code_hash"?: string,"created_by"?: string | null,"expires_at"?: string | null,"max_uses"?: number | null,"note"?: string | null,"used_count"?: number | null
                  }
                  Relationships: [
                    
                  ]
                },"note_vectors": {
                  Row: {
                    "content_hash": string,"embedding": unknown,"event_id": string | null,"file_id": string | null,"image_id": string | null,"is_vault": boolean,"kind": string,"model": string,"note_id": string | null,"source_id": string,"todo_id": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content_hash": string,"embedding": unknown,"event_id"?: string | null,"file_id"?: string | null,"image_id"?: string | null,"is_vault"?: boolean,"kind": string,"model": string,"note_id"?: string | null,"source_id": string,"todo_id"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "content_hash"?: string,"embedding"?: unknown,"event_id"?: string | null,"file_id"?: string | null,"image_id"?: string | null,"is_vault"?: boolean,"kind"?: string,"model"?: string,"note_id"?: string | null,"source_id"?: string,"todo_id"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "note_vectors_file_id_user_id_fkey"
      columns: ["file_id","user_id"]
isOneToOne: false
      referencedRelation: "scan_note_files"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "note_vectors_image_id_user_id_fkey"
      columns: ["image_id","user_id"]
isOneToOne: false
      referencedRelation: "scan_note_images"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"pending_deletions": {
                  Row: {
                    "backups_done_through": string | null,"notice_sent": boolean,"purge_after": string,"purge_started_at": string | null,"requested_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "backups_done_through"?: string | null,"notice_sent"?: boolean,"purge_after": string,"purge_started_at"?: string | null,"requested_at"?: string,"user_id": string
                  }
                  Update: {
                    "backups_done_through"?: string | null,"notice_sent"?: boolean,"purge_after"?: string,"purge_started_at"?: string | null,"requested_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"pending_signups": {
                  Row: {
                    "claimed_code": string | null,"email_hash": string,"expires_at": string,"otp_hash": string,"tries": number
                  }
                  ComputedFields: never
                  Insert: {
                    "claimed_code"?: string | null,"email_hash": string,"expires_at": string,"otp_hash": string,"tries"?: number
                  }
                  Update: {
                    "claimed_code"?: string | null,"email_hash"?: string,"expires_at"?: string,"otp_hash"?: string,"tries"?: number
                  }
                  Relationships: [
                    
                  ]
                },"remind_queue": {
                  Row: {
                    "attempts": number,"claim": string | null,"claimed_at": string | null,"enqueued_at": string,"fresh": boolean,"id": string,"min_ver": number,"prio": number,"table_name": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"claim"?: string | null,"claimed_at"?: string | null,"enqueued_at"?: string,"fresh"?: boolean,"id": string,"min_ver"?: number,"prio"?: number,"table_name": string,"user_id": string
                  }
                  Update: {
                    "attempts"?: number,"claim"?: string | null,"claimed_at"?: string | null,"enqueued_at"?: string,"fresh"?: boolean,"id"?: string,"min_ver"?: number,"prio"?: number,"table_name"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"revoked_sessions": {
                  Row: {
                    "pair_hash": string,"revoked_at": string,"session_id": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "pair_hash": string,"revoked_at"?: string,"session_id"?: string | null,"user_id"?: string | null
                  }
                  Update: {
                    "pair_hash"?: string,"revoked_at"?: string,"session_id"?: string | null,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"table_meta": {
                  Row: {
                    "no_conflict": (string)[],"remind_cols": (string)[],"system_cols": (string)[],"tbl": string
                  }
                  ComputedFields: never
                  Insert: {
                    "no_conflict": (string)[],"remind_cols"?: (string)[],"system_cols": (string)[],"tbl": string
                  }
                  Update: {
                    "no_conflict"?: (string)[],"remind_cols"?: (string)[],"system_cols"?: (string)[],"tbl"?: string
                  }
                  Relationships: [
                    
                  ]
                },"user_limits": {
                  Row: {
                    "media_daily": number | null,"media_mb": number | null,"search_daily": number | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "media_daily"?: number | null,"media_mb"?: number | null,"search_daily"?: number | null,"user_id": string
                  }
                  Update: {
                    "media_daily"?: number | null,"media_mb"?: number | null,"search_daily"?: number | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"vault": {
                  Row: {
                    "fail_count": number | null,"last_reset_at": string | null,"lock_level": number | null,"locked_until": string | null,"pin_epoch": number,"pin_hash": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "fail_count"?: number | null,"last_reset_at"?: string | null,"lock_level"?: number | null,"locked_until"?: string | null,"pin_epoch"?: number,"pin_hash": string,"user_id": string
                  }
                  Update: {
                    "fail_count"?: number | null,"last_reset_at"?: string | null,"lock_level"?: number | null,"locked_until"?: string | null,"pin_epoch"?: number,"pin_hash"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"vault_ai": {
                  Row: {
                    "desc_enc": string,"enc_key_id": number,"file_id": string | null,"image_id": string | null,"kind": string,"source_id": string,"tags_enc": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "desc_enc": string,"enc_key_id": number,"file_id"?: string | null,"image_id"?: string | null,"kind": string,"source_id": string,"tags_enc": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "desc_enc"?: string,"enc_key_id"?: number,"file_id"?: string | null,"image_id"?: string | null,"kind"?: string,"source_id"?: string,"tags_enc"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vault_ai_file_id_user_id_fkey"
      columns: ["file_id","user_id"]
isOneToOne: false
      referencedRelation: "scan_note_files"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "vault_ai_image_id_user_id_fkey"
      columns: ["image_id","user_id"]
isOneToOne: false
      referencedRelation: "scan_note_images"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"vault_credentials": {
                  Row: {
                    "credential_id": string,"device_label": string | null,"public_key": string,"sign_count": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "credential_id": string,"device_label"?: string | null,"public_key": string,"sign_count"?: number,"user_id": string
                  }
                  Update: {
                    "credential_id"?: string,"device_label"?: string | null,"public_key"?: string,"sign_count"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"vault_preview": {
                  Row: {
                    "created_at": string,"expires_at": string,"file_id": string,"path": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"expires_at": string,"file_id": string,"path": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"expires_at"?: string,"file_id"?: string,"path"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"webauthn_challenges": {
                  Row: {
                    "challenge": string,"expires_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "challenge": string,"expires_at": string,"user_id": string
                  }
                  Update: {
                    "challenge"?: string,"expires_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "scan_embed_queue": {
                  Row: {
                    "kind": string | null,"model": string | null,"next_at": string | null,"source_id": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "kind"?: string | null,"model"?: string | null,"next_at"?: string | null,"source_id"?: string | null,"user_id"?: string | null
                         }
                        Update: {
                           "kind"?: string | null,"model"?: string | null,"next_at"?: string | null,"source_id"?: string | null,"user_id"?: string | null
                         }
                        Relationships: [
                    
                  ]
                },"scan_note_files": {
                  Row: {
                    "ai_next_at": number | null,"ai_status": string | null,"check_status": string | null,"id": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "ai_next_at"?: number | null,"ai_status"?: string | null,"check_status"?: string | null,"id"?: string | null,"user_id"?: string | null
                         }
                        Update: {
                           "ai_next_at"?: number | null,"ai_status"?: string | null,"check_status"?: string | null,"id"?: string | null,"user_id"?: string | null
                         }
                        Relationships: [
                    
                  ]
                },"scan_note_images": {
                  Row: {
                    "ai_next_at": number | null,"ai_status": string | null,"id": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "ai_next_at"?: number | null,"ai_status"?: string | null,"id"?: string | null,"user_id"?: string | null
                         }
                        Update: {
                           "ai_next_at"?: number | null,"ai_status"?: string | null,"id"?: string | null,"user_id"?: string | null
                         }
                        Relationships: [
                    
                  ]
                },"scan_vault_preview": {
                  Row: {
                    "expires_at": string | null,"path": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "expires_at"?: string | null,"path"?: string | null,"user_id"?: string | null
                         }
                        Update: {
                           "expires_at"?: string | null,"path"?: string | null,"user_id"?: string | null
                         }
                        Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "account_request_deletion":
{ Args: { "p_user": string }; Returns: string
                           },
"account_restore":
{ Args: { "p_user": string }; Returns: string
                           },
"account_usable":
{ Args: { "p_user": string }; Returns: boolean
                           },
"admin_set_disabled":
{ Args: { "p_on": boolean,"p_user": string }; Returns: undefined
                           },
"ai_classify_pending":
{ Args: { "p_per_user": number,"p_users": number }; Returns: {
              "ai_meta": Json,"body": string,"category_source": string,"id": string,"tags": (string)[],"title": string,"user_id": string
            }[]
                           },
"ai_quota_refund":
{ Args: { "p_key": string }; Returns: undefined
                           },
"ai_quota_take":
{ Args: { "p_key": string,"p_limit": number }; Returns: number
                           },
"auth_mail_counts":
{ Args: Record<PropertyKey, never>; Returns: {
              "auth_1h": number,"auth_24h": number
            }[]
                           },
"claim_endpoint_impl":
{ Args: { "p_auth": string,"p_endpoint": string,"p_label": string,"p_p256dh": string,"p_platform": string }; Returns: Json
                           },
"cleanup_batch":
{ Args: { "p_limit"?: number }; Returns: number
                           },
"db_size_bytes":
{ Args: Record<PropertyKey, never>; Returns: {
              "at": string,"bytes": number
            }[]
                           },
"enqueue_floating":
{ Args: { "p_user": string }; Returns: undefined
                           },
"export_job_start":
{ Args: { "p_export_id": string,"p_mode": string,"p_session": string,"p_user": string }; Returns: string
                           },
"export_job_take":
{ Args: { "p_export_id": string,"p_max": number,"p_mode": string,"p_session": string,"p_ttl_s": number,"p_user": string }; Returns: {
              "parts": number,"started_at": string,"verdict": string
            }[]
                           },
"export_size_over":
{ Args: { "p_budget_ms": number,"p_limit": number,"p_mode": string,"p_user": string }; Returns: number
                           },
"files_authorize_impl":
{ Args: { "p_items": Json,"p_op": string }; Returns: Json
                           },
"intake_insert":
{ Args: { "p_rows": Json,"p_user": string }; Returns: undefined
                           },
"invite_claim":
{ Args: { "p_code_hash": string,"p_email_hash": string,"p_now": string,"p_otp_hash": string }; Returns: string
                           },
"invite_release":
{ Args: { "p_code_hash": string,"p_email_hash": string }; Returns: boolean
                           },
"is_active":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"kill_session":
{ Args: { "p_session": string,"p_user": string }; Returns: undefined
                           },
"long_transactions":
{ Args: Record<PropertyKey, never>; Returns: {
              "app": string,"pid": number,"role": unknown,"xact_start": string
            }[]
                           },
"media_fits":
{ Args: { "p_bytes": number,"p_exclude_image": string,"p_has_thumb": boolean,"p_uid": string }; Returns: boolean
                           },
"media_limit_bytes":
{ Args: { "p_uid": string }; Returns: number
                           },
"media_quota_lock":
{ Args: { "p_uid": string }; Returns: undefined
                           },
"media_row_bytes":
{ Args: { "p_bytes": number,"p_has_thumb": boolean }; Returns: number
                           },
"media_used":
{ Args: { "p_exclude_image": string,"p_uid": string }; Returns: number
                           },
"my_ai_usage_impl":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"my_sessions_impl":
{ Args: Record<PropertyKey, never>; Returns: {
              "orphan_count": number,"orphan_last_at": string,"signed_out_device_ids": (string)[]
            }[]
                           },
"not_password_session":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"orphan_auth_users":
{ Args: Record<PropertyKey, never>; Returns: {
              "latest_at": string,"orphans": number
            }[]
                           },
"purge_deleted_impl":
{ Args: { "p_items"?: Json }; Returns: number
                           },
"purge_vault_impl":
{ Args: { "p_items"?: Json,"p_user": string }; Returns: number
                           },
"push_endpoint_ok":
{ Args: { "p": string }; Returns: boolean
                           },
"push_heartbeat_write":
{ Args: { "p_detail": Json,"p_poison": number }; Returns: number
                           },
"push_keys_ok":
{ Args: { "auth": string,"p256dh": string }; Returns: boolean
                           },
"rebind_device_impl":
{ Args: { "p_device": string,"p_new_session": string,"p_old_session": string,"p_user": string }; Returns: undefined
                           },
"record_consent_impl":
{ Args: { "p_revoke"?: boolean,"p_ver": string }; Returns: undefined
                           },
"remind_due":
{ Args: { "p_hi": number,"p_limit": number,"p_lo": number,"p_per_user": number }; Returns: {
              "due_at": number,"id": string,"table_name": string,"user_id": string
            }[]
                           },
"remind_enqueue":
{ Args: { "p_fresh": boolean,"p_id": string,"p_min_ver": number,"p_scope": string,"p_tn": string,"p_user": string }; Returns: undefined
                           },
"remind_pushed":
{ Args: { "p_hi": number,"p_limit": number,"p_lo": number,"p_per_user": number }; Returns: {
              "id": string,"pushed_for": number,"table_name": string,"user_id": string
            }[]
                           },
"remind_queue_finish":
{ Args: { "p_claim": string,"p_done"?: Json,"p_release": Json }; Returns: undefined
                           },
"remind_queue_pop":
{ Args: { "p_lease_s": number,"p_limit": number,"p_per_user"?: number,"p_poison"?: number,"p_retry": boolean,"p_ver"?: number }; Returns: {
              "claim": string,"fresh": boolean,"id": string,"prio": number,"table_name": string,"user_id": string
            }[]
                           },
"remind_queue_stats":
{ Args: Record<PropertyKey, never>; Returns: {
              "batch_items": number,"oldest_user_wait_s": number,"user_items": number
            }[]
                           },
"remind_reset":
{ Args: { "n": Json,"o": Json,"p_tn": string }; Returns: Json
                           },
"remove_device_impl":
{ Args: { "p_device": string }; Returns: undefined
                           },
"report_tz_impl":
{ Args: { "p_device": string,"p_platform": string,"p_tz": string }; Returns: string
                           },
"require_live_session":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"revoke_my_sessions_impl":
{ Args: { "p_include_current": boolean }; Returns: number
                           },
"revoke_session":
{ Args: { "p_session": string,"p_user": string }; Returns: undefined
                           },
"security_events":
{ Args: Record<PropertyKey, never>; Returns: {
              "pw_revoke_failed": number,"sfate_capped": number
            }[]
                           },
"session_alive":
{ Args: { "p_session": string }; Returns: boolean
                           },
"session_pair_hash":
{ Args: { "p_session": string,"p_user": string }; Returns: string
                           },
"table_meta_of":
{ Args: { "p_tbl": string }; Returns: {
              "no_conflict": (string)[],"system_cols": (string)[]
            }[]
                           },
"tags_ok":
{ Args: { "p": (string)[] }; Returns: boolean
                           },
"take_rate":
{ Args: { "p_key": string,"p_limit": number,"p_window_s": number }; Returns: boolean
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "anniversaries": {
                  Row: {
                    "after_due": string,"archived_at": number | null,"avatar_bytes": number | null,"avatar_id": string | null,"calendar": string,"created_at": number,"day": number,"defer_until": number | null,"deleted_at": number | null,"fv": NonNullable<Json>,"id": string,"is_leap": boolean,"kind": string,"lunar_variant": string,"month": number,"name": string,"next_date": string | null,"note": string,"notified_for": number | null,"push_show_title": boolean | null,"pushed_for": number | null,"remind_at": number | null,"remind_offsets": (number)[] | null,"remind_time": string | null,"rev": number,"snooze_at": number | null,"synced_at": string,"undone": boolean,"updated_at": number,"user_id": string,"year": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "after_due"?: string,"archived_at"?: number | null,"avatar_bytes"?: number | null,"avatar_id"?: string | null,"calendar": string,"created_at": number,"day": number,"defer_until"?: number | null,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id": string,"is_leap"?: boolean,"kind": string,"lunar_variant"?: string,"month": number,"name": string,"next_date"?: string | null,"note"?: string,"notified_for"?: number | null,"push_show_title"?: boolean | null,"pushed_for"?: number | null,"remind_at"?: number | null,"remind_offsets"?: (number)[] | null,"remind_time"?: string | null,"rev"?: number,"snooze_at"?: number | null,"synced_at"?: string,"undone"?: boolean,"updated_at": number,"user_id"?: string,"year"?: number | null
                  }
                  Update: {
                    "after_due"?: string,"archived_at"?: number | null,"avatar_bytes"?: number | null,"avatar_id"?: string | null,"calendar"?: string,"created_at"?: number,"day"?: number,"defer_until"?: number | null,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id"?: string,"is_leap"?: boolean,"kind"?: string,"lunar_variant"?: string,"month"?: number,"name"?: string,"next_date"?: string | null,"note"?: string,"notified_for"?: number | null,"push_show_title"?: boolean | null,"pushed_for"?: number | null,"remind_at"?: number | null,"remind_offsets"?: (number)[] | null,"remind_time"?: string | null,"rev"?: number,"snooze_at"?: number | null,"synced_at"?: string,"undone"?: boolean,"updated_at"?: number,"user_id"?: string,"year"?: number | null
                  }
                  Relationships: [
                    
                  ]
                },"api_tokens": {
                  Row: {
                    "created_at": string,"id": string,"label": string | null,"last_used_at": string | null,"revoked_at": string | null,"scopes": (string)[],"token_hash": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"label"?: string | null,"last_used_at"?: string | null,"revoked_at"?: string | null,"scopes"?: (string)[],"token_hash": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"label"?: string | null,"last_used_at"?: string | null,"revoked_at"?: string | null,"scopes"?: (string)[],"token_hash"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"app_config": {
                  Row: {
                    "ai": NonNullable<Json>,"features": NonNullable<Json>,"id": number,"latest_version": string | null,"limits": NonNullable<Json>,"min_client_version": string | null,"notice": Json | null
                  }
                  ComputedFields: never
                  Insert: {
                    "ai": NonNullable<Json>,"features"?: NonNullable<Json>,"id"?: number,"latest_version"?: string | null,"limits"?: NonNullable<Json>,"min_client_version"?: string | null,"notice"?: Json | null
                  }
                  Update: {
                    "ai"?: NonNullable<Json>,"features"?: NonNullable<Json>,"id"?: number,"latest_version"?: string | null,"limits"?: NonNullable<Json>,"min_client_version"?: string | null,"notice"?: Json | null
                  }
                  Relationships: [
                    
                  ]
                },"applied_ops": {
                  Row: {
                    "at": string,"op_id": string,"result": Json | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "at"?: string,"op_id": string,"result"?: Json | null,"user_id"?: string
                  }
                  Update: {
                    "at"?: string,"op_id"?: string,"result"?: Json | null,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"categories": {
                  Row: {
                    "color": string | null,"created_by": string,"deleted_at": number | null,"fv": NonNullable<Json>,"id": string,"merged_into": string | null,"name": string,"rev": number,"sort": number,"synced_at": string,"undone": boolean,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_by"?: string,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id": string,"merged_into"?: string | null,"name": string,"rev"?: number,"sort"?: number,"synced_at"?: string,"undone"?: boolean,"user_id"?: string
                  }
                  Update: {
                    "color"?: string | null,"created_by"?: string,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id"?: string,"merged_into"?: string | null,"name"?: string,"rev"?: number,"sort"?: number,"synced_at"?: string,"undone"?: boolean,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"devices": {
                  Row: {
                    "app_version": string | null,"auth": string | null,"created_at": string,"deleted_at": number | null,"fv": NonNullable<Json>,"id": string,"install_id": string | null,"label": string | null,"last_push_ok_at": string | null,"last_seen_at": string | null,"p256dh": string | null,"platform": string,"push_endpoint": string | null,"push_fail_count": number,"rev": number,"session_id": string | null,"synced_at": string,"undone": boolean,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "app_version"?: string | null,"auth"?: string | null,"created_at"?: string,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id": string,"install_id"?: string | null,"label"?: string | null,"last_push_ok_at"?: string | null,"last_seen_at"?: string | null,"p256dh"?: string | null,"platform": string,"push_endpoint"?: string | null,"push_fail_count"?: number,"rev"?: number,"session_id"?: string | null,"synced_at"?: string,"undone"?: boolean,"user_id"?: string
                  }
                  Update: {
                    "app_version"?: string | null,"auth"?: string | null,"created_at"?: string,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id"?: string,"install_id"?: string | null,"label"?: string | null,"last_push_ok_at"?: string | null,"last_seen_at"?: string | null,"p256dh"?: string | null,"platform"?: string,"push_endpoint"?: string | null,"push_fail_count"?: number,"rev"?: number,"session_id"?: string | null,"synced_at"?: string,"undone"?: boolean,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"diag_logs": {
                  Row: {
                    "app_version": string | null,"body": string,"sent_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "app_version"?: string | null,"body": string,"sent_at"?: string,"user_id"?: string
                  }
                  Update: {
                    "app_version"?: string | null,"body"?: string,"sent_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"events": {
                  Row: {
                    "ai_status": string,"batch_id": string | null,"created_at": number,"date": string,"defer_until": number | null,"deleted_at": number | null,"duration_min": number,"fv": NonNullable<Json>,"id": string,"location": string,"note": string,"notified_for": number | null,"project": string,"push_show_title": boolean | null,"pushed_for": number | null,"raw_text": string,"remind_at": number | null,"remind_days": number | null,"remind_min": number | null,"repeat": Json | null,"repeat_skip": (string)[],"rev": number,"short": string | null,"short_by": string | null,"snooze_at": number | null,"source": string,"synced_at": string,"time": string | null,"title": string,"tz": string | null,"undone": boolean,"updated_at": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_status"?: string,"batch_id"?: string | null,"created_at": number,"date": string,"defer_until"?: number | null,"deleted_at"?: number | null,"duration_min"?: number,"fv"?: NonNullable<Json>,"id": string,"location"?: string,"note"?: string,"notified_for"?: number | null,"project"?: string,"push_show_title"?: boolean | null,"pushed_for"?: number | null,"raw_text"?: string,"remind_at"?: number | null,"remind_days"?: number | null,"remind_min"?: number | null,"repeat"?: Json | null,"repeat_skip"?: (string)[],"rev"?: number,"short"?: string | null,"short_by"?: string | null,"snooze_at"?: number | null,"source"?: string,"synced_at"?: string,"time"?: string | null,"title": string,"tz"?: string | null,"undone"?: boolean,"updated_at": number,"user_id"?: string
                  }
                  Update: {
                    "ai_status"?: string,"batch_id"?: string | null,"created_at"?: number,"date"?: string,"defer_until"?: number | null,"deleted_at"?: number | null,"duration_min"?: number,"fv"?: NonNullable<Json>,"id"?: string,"location"?: string,"note"?: string,"notified_for"?: number | null,"project"?: string,"push_show_title"?: boolean | null,"pushed_for"?: number | null,"raw_text"?: string,"remind_at"?: number | null,"remind_days"?: number | null,"remind_min"?: number | null,"repeat"?: Json | null,"repeat_skip"?: (string)[],"rev"?: number,"short"?: string | null,"short_by"?: string | null,"snooze_at"?: number | null,"source"?: string,"synced_at"?: string,"time"?: string | null,"title"?: string,"tz"?: string | null,"undone"?: boolean,"updated_at"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"logs": {
                  Row: {
                    "act": string | null,"code": string | null,"coll": string | null,"device": string | null,"fields": (string)[] | null,"id": number,"item_id": string | null,"kind": string | null,"src": string | null,"t": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "act"?: string | null,"code"?: string | null,"coll"?: string | null,"device"?: string | null,"fields"?: (string)[] | null,"id"?: number,"item_id"?: string | null,"kind"?: string | null,"src"?: string | null,"t": number,"user_id"?: string
                  }
                  Update: {
                    "act"?: string | null,"code"?: string | null,"coll"?: string | null,"device"?: string | null,"fields"?: (string)[] | null,"id"?: number,"item_id"?: string | null,"kind"?: string | null,"src"?: string | null,"t"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"note_files": {
                  Row: {
                    "ai_desc": string | null,"ai_next_at": number | null,"ai_status": string,"ai_tags": (string)[],"ai_tries": number,"bytes": number,"check_status": string,"created_at": number,"dek_enc": string | null,"deleted_at": number | null,"enc_key_id": number | null,"etag": string | null,"fv": NonNullable<Json>,"has_thumb": boolean,"id": string,"is_vault": boolean,"kind": string,"mime": string,"name": string | null,"name_enc": string | null,"note_id": string,"pages": number | null,"path": string,"rev": number,"sha256": string,"skip_reason": string | null,"synced_at": string,"text_enc": string | null,"text_excerpt": string | null,"undone": boolean,"updated_at": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_desc"?: string | null,"ai_next_at"?: number | null,"ai_status"?: string,"ai_tags"?: (string)[],"ai_tries"?: number,"bytes": number,"check_status"?: string,"created_at": number,"dek_enc"?: string | null,"deleted_at"?: number | null,"enc_key_id"?: number | null,"etag"?: string | null,"fv"?: NonNullable<Json>,"has_thumb"?: boolean,"id": string,"is_vault"?: boolean,"kind": string,"mime": string,"name"?: string | null,"name_enc"?: string | null,"note_id": string,"pages"?: number | null,"path": string,"rev"?: number,"sha256": string,"skip_reason"?: string | null,"synced_at"?: string,"text_enc"?: string | null,"text_excerpt"?: string | null,"undone"?: boolean,"updated_at": number,"user_id"?: string
                  }
                  Update: {
                    "ai_desc"?: string | null,"ai_next_at"?: number | null,"ai_status"?: string,"ai_tags"?: (string)[],"ai_tries"?: number,"bytes"?: number,"check_status"?: string,"created_at"?: number,"dek_enc"?: string | null,"deleted_at"?: number | null,"enc_key_id"?: number | null,"etag"?: string | null,"fv"?: NonNullable<Json>,"has_thumb"?: boolean,"id"?: string,"is_vault"?: boolean,"kind"?: string,"mime"?: string,"name"?: string | null,"name_enc"?: string | null,"note_id"?: string,"pages"?: number | null,"path"?: string,"rev"?: number,"sha256"?: string,"skip_reason"?: string | null,"synced_at"?: string,"text_enc"?: string | null,"text_excerpt"?: string | null,"undone"?: boolean,"updated_at"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "note_files_note_id_user_id_fkey"
      columns: ["note_id","user_id"]
isOneToOne: false
      referencedRelation: "notes"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"note_images": {
                  Row: {
                    "ai_desc": string | null,"ai_next_at": number | null,"ai_status": string,"ai_tags": (string)[],"ai_tries": number,"bucket": string,"bytes": number,"deleted_at": number | null,"fv": NonNullable<Json>,"has_thumb": boolean,"height": number | null,"id": string,"mime": string,"note_id": string,"path": string,"rev": number,"skip_reason": string | null,"synced_at": string,"taken_at": number | null,"undone": boolean,"user_id": string,"width": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_desc"?: string | null,"ai_next_at"?: number | null,"ai_status"?: string,"ai_tags"?: (string)[],"ai_tries"?: number,"bucket": string,"bytes": number,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"has_thumb"?: boolean,"height"?: number | null,"id": string,"mime"?: string,"note_id": string,"path": string,"rev"?: number,"skip_reason"?: string | null,"synced_at"?: string,"taken_at"?: number | null,"undone"?: boolean,"user_id"?: string,"width"?: number | null
                  }
                  Update: {
                    "ai_desc"?: string | null,"ai_next_at"?: number | null,"ai_status"?: string,"ai_tags"?: (string)[],"ai_tries"?: number,"bucket"?: string,"bytes"?: number,"deleted_at"?: number | null,"fv"?: NonNullable<Json>,"has_thumb"?: boolean,"height"?: number | null,"id"?: string,"mime"?: string,"note_id"?: string,"path"?: string,"rev"?: number,"skip_reason"?: string | null,"synced_at"?: string,"taken_at"?: number | null,"undone"?: boolean,"user_id"?: string,"width"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "note_images_note_id_user_id_fkey"
      columns: ["note_id","user_id"]
isOneToOne: false
      referencedRelation: "notes"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"notes": {
                  Row: {
                    "ai_meta": Json | null,"ai_status": string,"batch_id": string | null,"body": string | null,"body_enc": string | null,"category_id": string | null,"category_seen": boolean,"category_source": string,"converted_to": Json | null,"created_at": number,"deleted_at": number | null,"enc_key_id": number | null,"fv": NonNullable<Json>,"id": string,"is_private": boolean,"raw_text": string,"rev": number,"source": string,"synced_at": string,"tags": (string)[],"title": string | null,"undone": boolean,"updated_at": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_meta"?: Json | null,"ai_status"?: string,"batch_id"?: string | null,"body"?: string | null,"body_enc"?: string | null,"category_id"?: string | null,"category_seen"?: boolean,"category_source"?: string,"converted_to"?: Json | null,"created_at": number,"deleted_at"?: number | null,"enc_key_id"?: number | null,"fv"?: NonNullable<Json>,"id": string,"is_private"?: boolean,"raw_text"?: string,"rev"?: number,"source"?: string,"synced_at"?: string,"tags"?: (string)[],"title"?: string | null,"undone"?: boolean,"updated_at": number,"user_id"?: string
                  }
                  Update: {
                    "ai_meta"?: Json | null,"ai_status"?: string,"batch_id"?: string | null,"body"?: string | null,"body_enc"?: string | null,"category_id"?: string | null,"category_seen"?: boolean,"category_source"?: string,"converted_to"?: Json | null,"created_at"?: number,"deleted_at"?: number | null,"enc_key_id"?: number | null,"fv"?: NonNullable<Json>,"id"?: string,"is_private"?: boolean,"raw_text"?: string,"rev"?: number,"source"?: string,"synced_at"?: string,"tags"?: (string)[],"title"?: string | null,"undone"?: boolean,"updated_at"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notes_category_id_user_id_fkey"
      columns: ["category_id","user_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "beta_features": (string)[],"consent_ai_at": string | null,"consent_policy_ver": string | null,"created_at": string,"current_tz": string,"current_tz_at": string | null,"current_tz_device": string | null,"disabled_at": string | null,"disabled_reason": string | null,"display_name": string | null,"tz_mode": string,"ui_locale": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "beta_features"?: (string)[],"consent_ai_at"?: string | null,"consent_policy_ver"?: string | null,"created_at"?: string,"current_tz"?: string,"current_tz_at"?: string | null,"current_tz_device"?: string | null,"disabled_at"?: string | null,"disabled_reason"?: string | null,"display_name"?: string | null,"tz_mode"?: string,"ui_locale"?: string,"user_id": string
                  }
                  Update: {
                    "beta_features"?: (string)[],"consent_ai_at"?: string | null,"consent_policy_ver"?: string | null,"created_at"?: string,"current_tz"?: string,"current_tz_at"?: string | null,"current_tz_device"?: string | null,"disabled_at"?: string | null,"disabled_reason"?: string | null,"display_name"?: string | null,"tz_mode"?: string,"ui_locale"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"settings": {
                  Row: {
                    "deleted_at": number | null,"fv": NonNullable<Json>,"id": string,"key": string,"rev": number,"synced_at": string,"undone": boolean,"user_id": string,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id": string,"key": string,"rev"?: number,"synced_at"?: string,"undone"?: boolean,"user_id"?: string,"value": NonNullable<Json>
                  }
                  Update: {
                    "deleted_at"?: number | null,"fv"?: NonNullable<Json>,"id"?: string,"key"?: string,"rev"?: number,"synced_at"?: string,"undone"?: boolean,"user_id"?: string,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"todos": {
                  Row: {
                    "ai_status": string,"batch_id": string | null,"created_at": number,"defer_until": number | null,"deleted_at": number | null,"done": boolean,"done_at": number,"due": string | null,"due_time": string | null,"from_anniv_id": string | null,"from_note_id": string | null,"fv": NonNullable<Json>,"id": string,"important": boolean,"note": string,"notified_for": number | null,"project": string,"push_show_title": boolean | null,"pushed_for": number | null,"raw_text": string,"remind_at": number | null,"remind_before_min": number | null,"remind_days": number | null,"remind_time": string,"repeat": Json | null,"repeat_skip": (string)[],"rev": number,"short": string | null,"short_by": string | null,"snooze_at": number | null,"source": string,"synced_at": string,"title": string,"undone": boolean,"updated_at": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_status"?: string,"batch_id"?: string | null,"created_at": number,"defer_until"?: number | null,"deleted_at"?: number | null,"done"?: boolean,"done_at"?: number,"due"?: string | null,"due_time"?: string | null,"from_anniv_id"?: string | null,"from_note_id"?: string | null,"fv"?: NonNullable<Json>,"id": string,"important"?: boolean,"note"?: string,"notified_for"?: number | null,"project"?: string,"push_show_title"?: boolean | null,"pushed_for"?: number | null,"raw_text"?: string,"remind_at"?: number | null,"remind_before_min"?: number | null,"remind_days"?: number | null,"remind_time"?: string,"repeat"?: Json | null,"repeat_skip"?: (string)[],"rev"?: number,"short"?: string | null,"short_by"?: string | null,"snooze_at"?: number | null,"source"?: string,"synced_at"?: string,"title": string,"undone"?: boolean,"updated_at": number,"user_id"?: string
                  }
                  Update: {
                    "ai_status"?: string,"batch_id"?: string | null,"created_at"?: number,"defer_until"?: number | null,"deleted_at"?: number | null,"done"?: boolean,"done_at"?: number,"due"?: string | null,"due_time"?: string | null,"from_anniv_id"?: string | null,"from_note_id"?: string | null,"fv"?: NonNullable<Json>,"id"?: string,"important"?: boolean,"note"?: string,"notified_for"?: number | null,"project"?: string,"push_show_title"?: boolean | null,"pushed_for"?: number | null,"raw_text"?: string,"remind_at"?: number | null,"remind_before_min"?: number | null,"remind_days"?: number | null,"remind_time"?: string,"repeat"?: Json | null,"repeat_skip"?: (string)[],"rev"?: number,"short"?: string | null,"short_by"?: string | null,"snooze_at"?: number | null,"source"?: string,"synced_at"?: string,"title"?: string,"undone"?: boolean,"updated_at"?: number,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"tombstones": {
                  Row: {
                    "deleted_at": string,"id": string,"tbl": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "deleted_at"?: string,"id": string,"tbl": string,"user_id": string
                  }
                  Update: {
                    "deleted_at"?: string,"id"?: string,"tbl"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "apply_patch":
{ Args: { "p_base_rev": number,"p_id": string,"p_op_id": string,"p_own_revs"?: (number)[],"p_patch": Json,"p_table": string }; Returns: Json
                           },
"claim_endpoint":
{ Args: { "auth": string,"endpoint": string,"label": string,"p256dh": string,"platform": string }; Returns: Json
                           },
"files_authorize":
{ Args: { "p_items": Json,"p_op": string }; Returns: Json
                           },
"my_ai_usage":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"my_sessions":
{ Args: Record<PropertyKey, never>; Returns: {
              "orphan_count": number,"orphan_last_at": string,"signed_out_device_ids": (string)[]
            }[]
                           },
"purge_deleted":
{ Args: { "p_items"?: Json }; Returns: number
                           },
"record_consent":
{ Args: { "policy_ver": string,"revoke"?: boolean }; Returns: undefined
                           },
"remove_device":
{ Args: { "p_device_id": string }; Returns: undefined
                           },
"report_tz":
{ Args: { "device_id": string,"platform": string,"tz": string }; Returns: string
                           },
"revoke_my_sessions":
{ Args: { "p_include_current": boolean }; Returns: number
                           },
"session_fate":
{ Args: { "p_pair": string }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "private": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
