// 公共词典的 t，中韩两份静态带上（首屏瘦身 D，11-17 从 i18n.ts 拆出）：给服务器（supabase/functions/push-dispatch）、SW（src/sw/push.ts）和测试用。
// 网页不许引这份文件：i18n.ts 一静态引 zh.ts、ko.ts，两份词典就都进了首屏（rolldown 的 INEFFECTIVE_DYNAMIC_IMPORT），网页用 i18n.ts 的 sharedT
import { createT } from './i18n.ts';
import { ko } from './ko.ts';
import { zh } from './zh.ts';

/** 公共词典的 t */
export const t = createT({ zh, ko });
