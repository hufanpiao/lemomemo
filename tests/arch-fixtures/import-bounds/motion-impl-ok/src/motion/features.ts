// MOTION-IMPL 对照：features.ts 的 import type、export type … from 和 import('./motion-impl.tsx') 不报
import type { FeatureBundle } from 'motion/react';
export type { MotionProps } from 'motion/react';
import type { AppearImpl } from './appear-impl.tsx';
export type B = FeatureBundle | typeof AppearImpl;
export const load = () => import('./motion-impl.tsx');
const name = 'react';
export const dyn = (x: string) => import(`motion/${x}${name}`);
