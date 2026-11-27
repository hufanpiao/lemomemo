// 功能 ai-chat：AI 助手对话
// 对外唯一入口：只导出懒加载的挂载点和打开抽屉的加载器；别的功能只能 import 这个文件
// 没有自己的页面（routes 空），不在 app/features.ts 登记（同 smart-search）：只有“＋”那一块（features/plus，首屏画完才下载）引这个文件，这里的东西都不进首屏
import { lazy } from 'react';

export const routes = [] as const;

/** 抽屉的挂载点（ui/ChatHost.tsx）。features/plus 的 TypeBarPreload 挂一份。没有 props */
export const ChatHost = lazy(() => import('./ui/ChatHost.tsx'));

/**
 * 打开抽屉的函数在 hooks/chat-open.ts：openChat({ask, from, record, onAnswered})：ask 是这一句（抽屉挂上就问），
 * record(raw) 用完卡上的“改成记下”，onAnswered() 这一句有了服务器答复（plus 清草稿）。
 * 函数不能直接从这里导出，用加载器拿（同 smart-search 的 loadFindOpen）
 */
export const loadChatOpen = () => import('./hooks/chat-open.ts');
