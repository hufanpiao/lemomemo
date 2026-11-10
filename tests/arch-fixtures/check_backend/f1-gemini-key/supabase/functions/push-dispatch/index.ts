// 违规 F1：名单外的函数 import wire.ts、自己读 GEMINI_API_KEY
import { gateDeps } from '../_shared/ai/wire.ts';
export const k = [gateDeps, Deno.env.get('GEMINI_API_KEY')];
