// ai-parse 入口（架构第 6 节 ai-parse 行；B3 任务单 BE-4）：组装依赖、入口处查版本门，逻辑在 core.ts。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；GEMINI_API_KEY（8.4，经 _shared/ai/wire.ts 只放请求头）。
// 用到的库对象：private.account_usable、private.session_alive（经 _shared/auth.ts）、profiles、settings、app_config（同意、开关、配置、版本门）、
//   private.counters、private.take_rate、private.ai_state、logs（经 _shared/ai/store.ts）。不直连数据库（不在 6.2 的名单里），不碰 R2。
// 不加 CORS（0.48 第 4 条）：浏览器经 /sb 同源调用。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AuthError, requireActiveUser } from '../_shared/auth.ts';
import { parseWithAI } from '../_shared/ai/parse-with-ai.ts';
import { gateDeps, isValidTz } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { aiParseRequest, checkDefaultDay, normLocale, normProjects } from '../_shared/gen/schema/ai.ts';
import { versionGate } from '../_shared/version-gate.ts';
import { handle, json } from './core.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';

const log = (code: string) => console.error(`ai-parse: ${code}`);

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  const blocked = await versionGate('ai-parse', req, async (signal) => {
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
    logic: {
      parseRequest: (b) => {
        const p = aiParseRequest.safeParse(b);
        return p.success ? { ok: true, value: p.data } : { ok: false };
      },
      normLocale,
      normProjects,
      isValidTz,
      checkDefaultDay: (v, now, tz) => checkDefaultDay(v, now, tz),
      parseWithAI,
    },
  });
});
