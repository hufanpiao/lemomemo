// 功能 sync-notice：同步冲突、gone 的提示卡（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的宿主、出卡表白名单（字面量）和类型。只有 app/sync-notice-gate.ts（after-paint 块）用它，
// app/features.ts 不登记，首屏不带（tests/build/first-paint-k8.test.ts 钉住）
import { lazy } from 'react';

/** 提示卡宿主；props 见 SyncNoticeHostProps。gate 对预建的容器 createRoot 后渲染它 */
export const SyncNoticeHost = lazy(() => import('./ui/SyncNoticeHost.tsx'));

/**
 * 出卡表白名单（方案 4.1，H2）：gate 用它判名单外的表。A27 只许 index.ts 导出字面量，这里是 data/notice-tables.ts 的同一份，
 * __tests__/notice-tables.test.ts 钉住两边一致
 */
export const NOTICE_TABLES = ['events', 'todos', 'anniversaries', 'categories', 'notes'] as const;

export type { NoticeTable } from './data/notice-tables.ts';
export type { ConflictNotice, GoneNotice, GoneStatus, Notice, NoticeSnapshot, SyncNoticeHostProps, SyncNoticeStore } from './hooks/notice-types.ts';
