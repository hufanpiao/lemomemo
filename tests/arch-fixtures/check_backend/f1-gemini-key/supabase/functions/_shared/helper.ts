// 违规 F1：共用模块读 GEMINI_API_KEY、import wire.ts
export const k = Deno.env.get('GEMINI_API_KEY');
export { gateDeps } from './ai/wire.ts';
