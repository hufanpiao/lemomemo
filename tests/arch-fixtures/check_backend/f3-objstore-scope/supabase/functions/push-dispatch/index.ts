// 违规 F3（TC-B0-35）：九个函数以外 import 了 objstore
import { createObjStore } from '../_shared/gen/objstore.ts';
export const x = createObjStore;
