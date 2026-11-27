// 对照：预览专用函数 r2-probe 在 PREVIEW_FUNCS、PREVIEW_R2_FUNCS 里，可以经 _shared/gen/objstore.ts 用 R2、读 R2_*
import { createObjStore } from '../../_shared/gen/objstore.ts';
import { steps } from './probe.ts';
export const x = [createObjStore, steps, Deno.env.get('R2_BUCKET_PREFIX')];
