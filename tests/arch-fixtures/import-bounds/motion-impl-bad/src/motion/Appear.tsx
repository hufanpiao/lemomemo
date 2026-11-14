// MOTION-IMPL 违规样例：门面静态引 motion/react（第 2 行），静态引实现文件（第 3 行）
import { m } from 'motion/react';
import { ListImpl } from './list-impl.tsx';
export const Appear = [m, ListImpl];
