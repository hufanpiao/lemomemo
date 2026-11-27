// 冲突提示的出卡表白名单
// • 只有这六张表出冲突卡；名单外的表（settings、devices、note_images、note_files）：conflict 不出卡，gone 由 gate 静默 drop、记 sync_gone_drop
// • todo_items：改标题冲突照常出卡（title 报冲突），勾选、排序在 no_conflict 里不会报；
//   gone 不出“恢复并保留我的修改”卡（为一个勾选框弹卡不值得），由 gate 静默 drop（GONE_QUIET_TABLES）
// • 功能里（字段描述等）用这一份；gate 用 index.ts 里的同一份字面量（只许 index.ts 导出字面量），__tests__/notice-tables.test.ts 钉住两边一致
// • 卡上标题取哪一列（gate 的 titleOf）：分类、纪念日取 name（纪念日没有 title 列），其余取 title
// 纯 TS
export const NOTICE_TABLES = ['events', 'todos', 'anniversaries', 'categories', 'notes', 'todo_items'] as const;
/** 在名单里、但 gone 不出卡、静默丢掉的表；gate 用 index.ts 里的同一份字面量 */
export const GONE_QUIET_TABLES = ['todo_items'] as const;
export type NoticeTable = (typeof NOTICE_TABLES)[number];
