// parseWithAI、recordWithAI、voiceWithAI 的正式绑定（架构第 7 节签名；B3 任务单 BE-1；B4b-3 加意图）：校验用 _shared/gen/ 里复制过来的 shared/schema/ai.ts。
// ai-parse（parseWithAI）、ai-voice（voiceWithAI）、claude-intake（recordWithAI）的 index.ts 和评测 tests/ai/run.ts（recordWithAI；
// 跑之前先执行和部署同一个复制步骤 build/copy_shared.mjs）import 这里。逻辑在 parse-core.ts（不引 gen，Vitest 直接测）。
import { checkDefaultDay, checkParseOutput, checkVoiceOutput, type AiItem, type IntentChecked } from '../gen/schema/ai.ts';
import { makeParseWithAI } from './parse-core.ts';

export const { parseWithAI, recordWithAI, voiceWithAI } = makeParseWithAI<AiItem, IntentChecked>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
export type { ParseInput, VoiceInput, ParseFail, ParseOk } from './parse-core.ts';
