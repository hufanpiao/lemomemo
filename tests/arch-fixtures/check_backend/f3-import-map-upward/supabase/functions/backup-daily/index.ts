// 违规 F3（S3）：package.json "imports" 的通配别名 #gen/* → ./_shared/gen/obj*.ts，#gen/store 展开就是 objstore.ts（spec 里没有 objstore 字样）
import { createObjStore } from '#gen/store';
export const x = createObjStore;
