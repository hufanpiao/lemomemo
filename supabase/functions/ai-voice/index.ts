// ai-voice 入口（架构第 6 节 ai-voice 行、5.11；B3 任务单 BE-4）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；GEMINI_API_KEY（经 _shared/ai/wire.ts 只放请求头）。
// 用到的库对象同 ai-parse。不直连数据库，不碰 R2，不写 Storage。不加 CORS（0.48 第 4 条）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AuthError, requireActiveUser } from '../_shared/auth.ts';
import { voiceWithAI } from '../_shared/ai/parse-with-ai.ts';
import { logVoiceFail, type StoreAdmin } from '../_shared/ai/store.ts';
import { gateDeps, isValidTz } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { AI_AUDIO_MAX_BYTES, checkDefaultDay, normLocale, normProjects } from '../_shared/gen/schema/ai.ts';
import { versionGate } from '../_shared/version-gate.ts';
import { handle, json } from './core.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';

// ai-voice 整个目录禁 console（eslint no-console，A23：录音函数一个字都不往日志打）；错误码不打印。
// 失败分支由 core.ts 经 logFail 写进 logs 表（固定错误码、HTTP 状态、类型名、字节数区间）；校验没过的原因由 settle 写进 logs 表
const log = (_code: string): void => {};

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const blocked = await versionGate('ai-voice', req, async (signal) => {
    const { data, error } = await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle();
    if (error) throw new Error('db');
    return data?.min_client_version ?? null;
  });
  if (blocked) return blocked;
  return handle(req, {
    ...gateDeps(admin, log, (userId) => aiAllowed(admin, userId)),
    async authenticate(r) {
      try {
        return { ok: true, user: await requireActiveUser(r, admin) };
      } catch (e) {
        if (e instanceof AuthError) return { ok: false, response: e.toResponse() };
        throw e;
      }
    },
    logic: { maxAudio: AI_AUDIO_MAX_BYTES, normLocale, normProjects, isValidTz, checkDefaultDay: (v, now, tz) => checkDefaultDay(v, now, tz), voiceWithAI },
    logFail: (userId, code, fields) => logVoiceFail(admin as unknown as StoreAdmin, userId, code, fields, Date.now()),
  });
});
