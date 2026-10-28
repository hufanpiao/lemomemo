import { createObjStore } from '../../shared/objstore.ts';
export const x = (env: { R2_FILES_ACCESS_KEY_ID: string }) => createObjStore(env.R2_FILES_ACCESS_KEY_ID);
