// MOTION-IMPL 违规样例：index.ts 里动态引 motion/react（第 2 行）、动态引实现文件（第 3 行，只准 features.ts 这么写）
export const loadMotion = () => import('motion/react');
export const loadImpl = () => import('./motion-impl.tsx');
