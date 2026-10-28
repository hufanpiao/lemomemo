// arch-fixture: path=src/app/router.ts expect=none
// 对照组（0.31 第 3 条）：router.ts 引 react、shared、motion/index.ts 都可以；react-dom 只为 flushSync（UI-4 M-2）
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { FeatureFlag } from '../../shared/logic/flags.ts';
import { transition } from '../motion/index.ts';
export const x = [useSyncExternalStore, transition, flushSync];
export type F = FeatureFlag;
