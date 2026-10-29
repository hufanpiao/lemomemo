// app 层拿同步传输层的入口（架构 4.3b、0.38 第 58 条）：分层规则不让 app 直接引 platform/supabase，经这里转出
// 实现在 platform/supabase/sync-transport.ts（不 import core）；app/sync-wiring.ts 把它交给 core 的 createSync（依赖注入）
export { createSupabaseTransport, type SupabaseSyncTransport } from './supabase/sync-transport.ts';
