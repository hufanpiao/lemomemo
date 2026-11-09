// voice-probe 入口（预览专用、一次性；B3 任务单 BE-0、Q1 ①～⑨，R-68）。逻辑在 handler.ts。
//
// 为什么放在 _preview/ 下：同 db-probe——下划线开头的目录不当函数，正式发布（tools/release/publish.ps1）不带；
// 只有 deploy-preview.yml 在产物里生成 supabase/functions/voice-probe/index.ts（一句 import 本文件）并给它 verify_jwt = false，
// 鉴权在函数里自己做（auth.getUser + 写死的白名单）。build/check_backend.py F6 保证没有同名顶层目录、别处不引 _preview/、config.toml 不声明。
// 不碰数据库（Q1 ⑦）：只经 service role 调 private.take_rate 记每天的次数；不进 PREVIEW_AI_FUNCS，不用 fn_ai、fn_vault。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；GEMINI_API_KEY（预览那一把，只经 _shared/ai/gemini.ts 放进 x-goog-api-key 请求头）。
// 日志：只打印 handler 给的 ProbeLog（事件码、mime、字节数、HTTP 状态、耗时），不打印请求、转写、音频、Gemini 返回正文。
// 说明、调用方法和下线步骤：docs/09-路线图/B3-voice-probe探测函数.md
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { GeminiProvider } from '../../_shared/ai/gemini.ts';
import { takeRate, type StoreAdmin } from '../../_shared/ai/store.ts';
import { handle, type ProbeLog } from './handler.ts';

let admin: SupabaseClient | null = null;
function adminClient(): SupabaseClient {
  if (admin) return admin;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('misconfigured');
  admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

const log = (e: ProbeLog): void => {
  // 字段逐个取，不展开别的对象（Q1 ⑥）
  console.log(JSON.stringify({ fn: 'voice-probe', code: e.code, mime: e.mime, bytes: e.bytes, http: e.http, ms: e.ms }));
};

Deno.serve((req) =>
  handle(req, {
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
    now: () => Date.now(),
    clock: () => performance.now(),
    async verify(jwt) {
      const { data, error } = await adminClient().auth.getUser(jwt);
      // 令牌无效、过期、被吊销都返回 error（4xx）→ 当作无效；连不上（没有 status 或 5xx）抛错 → 503
      if (error) {
        const status = (error as { status?: number }).status;
        if (typeof status === 'number' && status >= 400 && status < 500) return null;
        throw new Error('auth_unavailable');
      }
      return data.user?.id ?? null;
    },
    take: (key, limit, windowS) => takeRate(adminClient() as unknown as StoreAdmin, key, limit, windowS),
    provider(model, seen) {
      const key = Deno.env.get('GEMINI_API_KEY');
      if (!key) return null;
      return new GeminiProvider(model, key, async (u, init) => {
        const res = await fetch(u, init);
        seen(res.status);   // 只报状态码，不碰正文和响应头
        return res;
      });
    },
    log,
  })
);
