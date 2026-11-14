// 违规样例：隔两层（mid → next-date → lunar），import、export … from、只写路径的 import 各一处
import { mid } from '../../../shared/logic/mid.ts';
export { mid as again } from '../../../shared/logic/mid';
import '../../../shared/logic/mid.ts';
export const x = mid;
