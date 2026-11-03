// 违规①：非测试文件用 import … from 引测试文件
import { U } from './helper.test.ts';
export const n = U.length;
