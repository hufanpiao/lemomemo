// app 层拿同步传输层的入口：分层规则不让 app 直接引 platform/supabase，经这里转出
// 实现在 supabase/sync-transport.ts（不 import core）；app/sync-wiring.ts 把它注入 core 的 createSync
export { createSupabaseTransport, type SupabaseSyncTransport } from './supabase/sync-transport.ts';
// 日志批量上传也经这里转出
export { createLogUploader, type LogRow, type LogUploadResult } from './supabase/log-upload.ts';
