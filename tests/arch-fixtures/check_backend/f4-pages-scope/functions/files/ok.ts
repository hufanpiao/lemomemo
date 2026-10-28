// 对照：/files 用 shared/objstore.ts 和 R2_FILES_*
import { createObjStore } from '../../shared/objstore.ts';
export const x = (env: { R2_FILES_ACCESS_KEY_ID: string }) => createObjStore(env.R2_FILES_ACCESS_KEY_ID);
