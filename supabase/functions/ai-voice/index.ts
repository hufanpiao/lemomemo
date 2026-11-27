// ai-voice 入口（架构第 6 节 ai-voice 行、5.11；B3 任务单 BE-4）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；GEMINI_API_KEY（经 _shared/ai/wire.ts 只放请求头）。
// 用到的库对象同 ai-parse。不直连数据库，不碰 R2，不写 Storage。不加 CORS（0.48 第 4 条）。
import { serviceAdmin } from '../_shared/admin.ts';
import { authResult, requireActiveUser } from '../_shared/auth.ts';
import { voiceWithAI } from '../_shared/ai/parse-with-ai.ts';
import { logVoiceFail, type StoreAdmin } from '../_shared/ai/store.ts';
import { transcribeAudio } from '../_shared/ai/transcribe.ts';
import { chatFeatures, gateDeps, isValidTz } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { AI_AUDIO_MAX_BYTES, audioType, checkDefaultDay, normLocale, normProjects, type AiItem, type IntentChecked } from '../_shared/gen/schema/ai.ts';
import { VOICE_WANT_TRANSCRIPT } from '../_shared/gen/schema/chat.ts';
import { appConfigMinLoader, versionGate } from '../_shared/version-gate.ts';
import { handle } from './core.ts';

// ai-voice 整个目录禁 console（eslint no-console，A23：录音函数一个字都不往日志打）；错误码不打印。
// 失败分支由 core.ts 经 logFail 写进 logs 表（固定错误码、HTTP 状态、类型名、字节数区间）；校验没过的原因由 settle 写进 logs 表
const log = (_code: string): void => {};

Deno.serve(async (req) => {
  const admin = serviceAdmin(log);
  if (admin instanceof Response) return admin;
  const blocked = await versionGate('ai-voice', req, appConfigMinLoader(admin));
  if (blocked) return blocked;
  // 泛型写明：deno 会把 I 推成意图联合里的一支（tsc 不会），写死就不靠推断
  return handle<AiItem, IntentChecked>(req, {
    ...gateDeps(admin, log, (userId) => aiAllowed(admin, userId), 'stt'),
    // 语音提问是 AI 助手的一部分：这个人没开 AI 助手就在门上挡下，不调服务商、不扣次数（R-495）
    ...(req.headers.get('x-want') === VOICE_WANT_TRANSCRIPT ? { features: chatFeatures(admin) } : {}),
    authenticate: (r) => authResult(() => requireActiveUser(r, admin)),
    logic: { maxAudio: AI_AUDIO_MAX_BYTES, audioType, normLocale, normProjects, isValidTz, checkDefaultDay: (v, now, tz) => checkDefaultDay(v, now, tz), voiceWithAI, transcribe: transcribeAudio, wantTranscript: VOICE_WANT_TRANSCRIPT },
    logFail: (userId, code, fields) => logVoiceFail(admin as unknown as StoreAdmin, userId, code, fields, Date.now()),
  });
});
