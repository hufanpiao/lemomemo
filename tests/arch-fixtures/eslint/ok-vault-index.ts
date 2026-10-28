// arch-fixture: path=src/features/vault/index.ts expect=none
// 对照（应通过）：懒加载页面 + vault 的 plusAdapter
// plus-adapter.ts 到 B4b 才有；这里借已有的文件当目标，只验证写法（目标不存在时边界规则会报“未知依赖”）
import { lazy } from 'react';

export const routes = [{ name: 'vault', Page: lazy(() => import('./ui/VaultPage.tsx')) }] as const;
export const plusAdapter = () => import('./ui/VaultPage.tsx');
export type VaultRouteName = 'vault';
