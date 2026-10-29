// arch-fixture: path=src/platform/supabase/sync-transport.ts expect=boundaries/dependencies rule=A1
// 违规（架构 4.3b、0.38 第 58 条）：platform 不准 import core（同步传输层的类型只引 shared/schema/sync.ts，由 app 层注入给 core）
import type { Outbox } from '../../core/outbox-types.ts';
export type X = Outbox;
