// claude-intake 入口（架构 5.7、第 6 节 claude-intake 行；B3 任务单 BE-5）：组装依赖，逻辑在 core.ts。
// 网关不验 JWT（config.toml verify_jwt = false）：鉴权按 Authorization 里连接码的 SHA-256 查 api_tokens（check_backend.py F9 核对）。
// 版本门免查 POST（shared/version-gate-list.ts，caller client：add.ps1 经 /sb 调；只收 POST，所以不接 versionGate）。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；GEMINI_API_KEY（有 text 且本机规则没把握时，经 _shared/ai/wire.ts）。
// 用到的库对象：api_tokens（按 token_hash 查、写 last_used_at）、private.account_usable（经 isUsable）、private.take_rate、profiles、
//   events、todos（读本人的 project 去重；只 insert 新行）、anniversaries（只 insert）、settings、app_config（同意、开关、配置）、
//   private.counters、private.ai_state、logs（经 _shared/ai/store.ts）。不直连数据库，不碰 R2。不加 CORS（0.48 第 4 条）。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { isUsable } from '../_shared/auth.ts';
import { parseWithAI } from '../_shared/ai/parse-with-ai.ts';
import { logIntakeFail, type StoreAdmin } from '../_shared/ai/store.ts';
import { gateDeps, isValidTz } from '../_shared/ai/wire.ts';
import { aiAllowed } from '../_shared/consent.ts';
import { todayOf } from '../_shared/gen/core/date.ts';
import { captureRow } from '../_shared/gen/logic/capture-map.ts';
import { arrangeHint, confidence, parseSplit, recurHint } from '../_shared/gen/logic/parse/index.ts';
import { checkParseOutput, normLocale, AI_PROJECTS_MAX } from '../_shared/gen/schema/ai.ts';
import { handle, json, StoreError, type Row, type TokenRow } from './core.ts';
import { timedFetch } from '../_shared/net.ts';
import { STORE_TIMEOUT_MS } from '../_shared/store-timeout.ts';

const log = (code: string) => console.error(`claude-intake: ${code}`);

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    log('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, STORE_TIMEOUT_MS) } });
  return handle(req, {
    gate: gateDeps(admin, log, (userId) => aiAllowed(admin, userId)),
    uuid: () => crypto.randomUUID(),
    logic: {
      parseSplit: (text, now, tz, locale, projects, opts) => parseSplit(text, now, tz, locale, projects, { features: [...opts.features] }),
      confidence: (r) => confidence(r as Parameters<typeof confidence>[0]),
      checkParseOutput,
      parseWithAI,
      captureRow: (item, ctx) => captureRow(item, ctx) as Row | null,
      todayOf, recurHint, arrangeHint,
      normLocale,
      isValidTz,
    },
    store: {
      async findToken(hash) {
        const { data, error } = await admin.from('api_tokens').select('id, user_id, scopes, created_at, revoked_at').eq('token_hash', hash).maybeSingle();
        if (error) throw new Error('db');
        return (data as TokenRow | null) ?? null;
      },
      async usable(userId) {
        return (await isUsable(admin, userId)).ok;
      },
      async takeRate(k, limit, windowS) {
        const { data, error } = await admin.schema('private').rpc('take_rate', { p_key: k, p_limit: limit, p_window_s: windowS });
        if (error) throw new Error('db');
        return data === true;
      },
      async profile(userId) {
        const { data, error } = await admin.from('profiles').select('current_tz, ui_locale').eq('user_id', userId).maybeSingle();
        if (error) throw new Error('db');
        return data as { current_tz: string; ui_locale: string } | null;
      },
      async projects(userId) {
        const names = new Set<string>();
        for (const t of ['events', 'todos'] as const) {
          const { data, error } = await admin.from(t).select('project').eq('user_id', userId).is('deleted_at', null).neq('project', '')
            .order('updated_at', { ascending: false }).limit(200);
          if (error) throw new Error('db');
          for (const r of (data ?? []) as { project: string }[]) if (names.size < AI_PROJECTS_MAX) names.add(r.project);
        }
        return [...names];
      },
      async insertAll(userId, rows) {
        // 只新增（TC-B3-20）：private.intake_insert 只 insert，行里不准带 user_id，由参数给
        const { error, status } = await admin.schema('private').rpc('intake_insert', { p_user: userId, p_rows: rows });
        if (error) throw new StoreError(status);
      },
      async touchToken(tokenId, at) {
        const { error, status } = await admin.from('api_tokens').update({ last_used_at: new Date(at).toISOString() }).eq('id', tokenId);
        if (error) throw new StoreError(status);
      },
      logFail: (userId, code, fields) => logIntakeFail(admin as unknown as StoreAdmin, userId, code, fields, Date.now()),
    },
  });
});
