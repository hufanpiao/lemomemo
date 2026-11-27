// 功能 smart-search：查找（关键词先出、意思相近随后补上）
// 对外唯一入口：只导出懒加载的组件和打开面板的加载器；别的功能只能 import 这个文件
// 没有自己的页面（routes 空），不在 app/features.ts 登记（同 attachments）：只有“＋”那一块（features/plus，首屏画完才下载）引这个文件，
//   这里的东西都不进首屏
// • 随手记、待办、日历三页也引这个文件（只拿懒加载的 PullSearch）；三页都不在首屏
import { lazy } from 'react';

export const routes = [] as const;

/**
 * 查找面板的挂载点 + 电脑 Ctrl+K（ui/FindHost.tsx）。features/plus 的 TypeBarPreload 挂一份。没有 props
 */
export const FindHost = lazy(() => import('./ui/FindHost.tsx'));

/**
 * 打开查找面板的函数在 hooks/find-open.ts：openFind(q, from)，q 是输入框里先放的字（打字条交过来的查询），from 记进运行日志；
 * openAssist(req)：“＋”判成查找、总结、取消、改期、完成时打开结果层（内容类查找仍是查找面板，带“总结一下 / 改成记下”页脚）。
 * 函数不能直接从这里导出（入口只导出懒加载组件），用加载器拿（同 plus 的 loadTypeBar）；FindHost 那一块已经静态带着它，打字条那边调用时通常已在内存里
 */
export const loadFindOpen = () => import('./hooks/find-open.ts');

/**
 * 提示条下面那一行“也帮你找了一下：N 条 ›”（ui/AssistPeek.tsx）：features/plus 的 SavedNotice 在模糊先保存了的时候挂。
 * props: { ask（shared/logic/parse/assist.ts 的 AssistAsk）; exclude: 刚保存的这一批的 id; undoSaved(): 撤销这一批 }
 */
export const AssistPeek = lazy(() => import('./ui/AssistPeek.tsx'));

/**
 * 下拉搜索（ui/PullSearch.tsx）：随手记、待办、日历页列表滚到顶再往下拉，标题下面露出的扁搜索框；露出时才挂、才下载。
 * 不管在哪一页，都一起查日程、待办、随手记，结果混在一起列、不分组。
 * 挂在 kit PullSlot 的 search={(part) => …} 里（part：'head' 搜索框、条数和结果，'foot' 结果下面的“用 AI 按意思找”）。
 * props: { part; pull: kit 的 usePullReveal(页名) 的返回值; scope: 'note' | 'todo' | 'event'（哪一页，只进日志）;
 *   own?: { kind, open(id) }：本页这一类的结果怎么打开（页面自己管只读拦截、抽屉），别的类按类换页 }
 */
export const PullSearch = lazy(() => import('./ui/PullSearch.tsx'));
