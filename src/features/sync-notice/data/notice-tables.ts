// 冲突提示的出卡表白名单（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 4.1，H2）
// • 只有这五张表出卡；名单外的表（settings、devices、note_images、note_files）：conflict 不出卡，gone 由 gate 静默 drop、记 sync_gone_drop
// • 功能里（字段描述等）用这一份；gate 用 index.ts 里的同一份字面量（A27 只许 index.ts 导出字面量），__tests__/notice-tables.test.ts 钉住两边一致
// • 卡上标题取哪一列（gate 的 titleOf）：分类、纪念日取 name，其余取 title（纪念日没有 title 列，方案 3.2 写的“取 title”按实际列名改成 name）
// 纯 TS
export const NOTICE_TABLES = ['events', 'todos', 'anniversaries', 'categories', 'notes'] as const;
export type NoticeTable = (typeof NOTICE_TABLES)[number];
