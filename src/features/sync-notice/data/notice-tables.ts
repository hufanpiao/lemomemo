// 冲突提示的出卡表白名单（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.1，H2）
// • 只有这六张表出冲突卡；名单外的表（settings、devices、note_images、note_files）：conflict 不出卡，gone 由 gate 静默 drop、记 sync_gone_drop
// • todo_items（R-350 方案 5.6 第 2 条，11-13 后端评审转来）：改标题冲突照常出卡（2.5：title 报冲突），勾选、排序在 no_conflict 里不会报；
//   gone 不出“恢复并保留我的修改”卡（4 第 7 条：为一个勾选框弹卡不值得），由 gate 静默 drop（GONE_QUIET_TABLES）
// • 功能里（字段描述等）用这一份；gate 用 index.ts 里的同一份字面量（A27 只许 index.ts 导出字面量），__tests__/notice-tables.test.ts 钉住两边一致
// • 卡上标题取哪一列（gate 的 titleOf）：分类、纪念日取 name，其余取 title（纪念日没有 title 列，方案 3.2 写的“取 title”按实际列名改成 name）
// 纯 TS
export const NOTICE_TABLES = ['events', 'todos', 'anniversaries', 'categories', 'notes', 'todo_items'] as const;
/** 在名单里、但 gone 不出卡、静默丢掉的表（R-350 方案 4 第 7 条）；gate 用 index.ts 里的同一份字面量 */
export const GONE_QUIET_TABLES = ['todo_items'] as const;
export type NoticeTable = (typeof NOTICE_TABLES)[number];
