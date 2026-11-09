// MOTION-IMPL 对照：注释里写的引入不算
// import { m } from 'motion/react';
/* const x = import('motion'); export { m } from 'framer-motion'; import './motion-impl.tsx'; */
import { useState } from 'react';
// 下一行解析到样例根目录外（另一个样例里的实现文件）：跳过、不中断
import { ListImpl } from '../../../../../motion-impl-bad/src/motion/list-impl.tsx';
export const Note = [useState, ListImpl];
