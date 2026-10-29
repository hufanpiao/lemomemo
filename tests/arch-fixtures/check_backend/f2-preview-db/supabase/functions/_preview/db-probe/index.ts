import { withUser } from '../../_shared/db.ts';
// 预览专用的 db-probe 在 PREVIEW_AI_FUNCS 里：经 db.ts 用 fn_ai、读 FN_AI_DB_URL 都不报
export const a = withUser('fn_ai', Deno.env.get('FN_AI_DB_URL'));
export const b = withUser('fn_vault');
