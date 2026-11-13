// 功能 vault：隐私记（B5）。对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、组件和清单引用
// 首屏体积：这个文件经 app/features.ts 进首屏，所以只放 lazy；给别的功能用的几块并成一个导出（VaultParts 按 part 分发），只多一个 lazy
import { lazy } from 'react';

export const routes = [{ name: 'vault', Page: lazy(() => import('./ui/VaultPage.tsx')) }] as const;

/**
 * 随手记列表顶部的入口行、“移到隐私记”、设置 › 隐私记（ui/VaultParts.tsx）。
 * props: { part: 'lockrow' } | { part: 'move'; noteId; onDone(moved: boolean) } | { part: 'settings' }
 */
export const VaultParts = lazy(() => import('./ui/VaultParts.tsx'));

// 数据清单不从这里转出（会把 zod 带进首屏，first-paint-graph.test.ts）：要用的直接引 ./data.manifest.ts 或 shared/manifests/vault.ts
