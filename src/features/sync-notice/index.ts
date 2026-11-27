// 功能 sync-notice：同步冲突、gone 的提示卡
// 对外唯一入口：只导出懒加载的宿主、出卡表白名单（字面量）和类型。只有 app/sync-notice-gate.ts（after-paint 块）用它，
// app/features.ts 不登记，首屏不带（tests/build/first-paint-k8.test.ts 钉住）
import { lazy } from 'react';

/** 提示卡宿主；props 见 SyncNoticeHostProps。gate 对预建的容器 createRoot 后渲染它 */
export const SyncNoticeHost = lazy(() => import('./ui/SyncNoticeHost.tsx'));

/**
 * 出卡表白名单：gate 用它判名单外的表。只许 index.ts 导出字面量，这里是 data/notice-tables.ts 的同一份，
 * __tests__/notice-tables.test.ts 钉住两边一致
 */
export const NOTICE_TABLES = ['events', 'todos', 'anniversaries', 'categories', 'notes', 'todo_items'] as const;
/** 名单里 gone 不出卡、静默丢掉的表（子任务被别的设备删了，本机的勾选、改字直接丢掉）；同 data/notice-tables.ts */
export const GONE_QUIET_TABLES = ['todo_items'] as const;

export type { NoticeTable } from './data/notice-tables.ts';
export type { ConflictNotice, GoneNotice, GoneStatus, Notice, NoticeSnapshot, SyncNoticeHostProps, SyncNoticeStore } from './hooks/notice-types.ts';
