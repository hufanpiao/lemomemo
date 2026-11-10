// 对照：voice-probe 准读 GEMINI_API_KEY（预览那一把）；违规 F1：预览专用函数不准 import wire.ts
export const k = Deno.env.get('GEMINI_API_KEY');
export { gateDeps } from '../../_shared/ai/wire.ts';
