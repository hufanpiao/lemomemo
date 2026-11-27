// 违规 F4：/sb 转发层 import 对象存储（Pages Functions 里只有 /files 能用 shared/objstore.ts）
import { createObjStore } from '../../shared/objstore.ts';
export const x = createObjStore;
