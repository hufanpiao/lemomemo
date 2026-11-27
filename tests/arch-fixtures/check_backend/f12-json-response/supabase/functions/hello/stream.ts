// F12 对照：流式响应、引共用的 json 都不报
import { json } from '../_shared/http.ts';

export const stream = (s: ReadableStream<Uint8Array>) => new Response(s, { status: 200 });
export const ok = () => json(200, { ok: true });
