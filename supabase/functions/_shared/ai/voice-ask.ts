// 语音提问的次数（R-495）：一问只算 1 次。ai-voice 转写时照常扣 1 次并记一次“发放”；紧接着的 ai-chat 答成后消费一次发放，退回转写那 1 次。
// 只转写不提问没有消费，退不到次数；每人每天最多退 VOICE_ASK_FREE 次。ai-voice、ai-chat 共用这一份。
import { pacificDate } from './gate.ts';

export const VOICE_ASK_FREE = 50;
/** 发放只当计数用：上限给得远超每日次数，take_rate 永远放行 */
export const VOICE_ISSUED_LIMIT = 1_000_000;
export const voiceIssuedKey = (userId: string, ms: number): string => `voice-ask:${userId}:${pacificDate(ms)}`;
export const voiceUsedKey = (userId: string, ms: number): string => `voice-used:${userId}:${pacificDate(ms)}`;
