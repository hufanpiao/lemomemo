// smart-search 共用的两个常量（查找面板、下拉搜索都用；R-437 评审第 12 条从 useFind.ts 挪出来，免得只为一个数引整个 useFind）
// • SEM_DEBOUNCE_MS：停下来多久才按意思找、才记一次查找日志、才把条数写进读屏播报
// • SEARCH_Q_MAX：查询最多几个字（服务器 note-search 同一个上限，定义在 shared/schema/search.ts）
export const SEM_DEBOUNCE_MS = 400;
export { SEARCH_Q_MAX } from '../../../../shared/schema/search.ts';
