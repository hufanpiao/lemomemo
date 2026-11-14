// 功能 smart-search：查找（关键词先出、意思相近随后补上；B4b-2，架构 5.13 第 6 点、5.14 第 1、3 点；线框 s12、sFind）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的组件和打开面板的加载器；别的功能只能 import 这个文件
// 没有自己的页面（routes 空），不在 app/features.ts 登记（同 attachments）：只有“＋”那一块（features/plus，首屏画完才下载）引这个文件，
//   这里的东西都不进首屏
import { lazy } from 'react';

export const routes = [] as const;

/**
 * 查找面板的挂载点 + 电脑 Ctrl+K（ui/FindHost.tsx）。features/plus 的 TypeBarPreload 挂一份。没有 props
 */
export const FindHost = lazy(() => import('./ui/FindHost.tsx'));

/**
 * 打开查找面板的函数在 hooks/find-open.ts：openFind(q, from)，q 是输入框里先放的字（打字条交过来的查询），from 记进运行日志。
 * 函数不能直接从这里导出（A27），用加载器拿（同 plus 的 loadTypeBar）；FindHost 那一块已经静态带着它，打字条那边调用时通常已在内存里
 */
export const loadFindOpen = () => import('./hooks/find-open.ts');

/**
 * 提示条下面那一行“也帮你找了一下：N 条 ›”（B4b-3，ui/AssistPeek.tsx）：features/plus 的 SavedNotice 在模糊先保存了的时候挂。
 * props: { ask（shared/logic/parse/assist.ts 的 AssistAsk）; exclude: 刚保存的这一批的 id; undoSaved(): 撤销这一批 }
 */
export const AssistPeek = lazy(() => import('./ui/AssistPeek.tsx'));
