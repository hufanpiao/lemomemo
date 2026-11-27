// ai-provider：自行更换 AI 服务商（R-494 AI 助手第 4 段；方案 2026-11-22_AI服务商，负责人定方向二按用途选 + 每个人的“我的 AI”）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/ai-provider.test.ts）；不 import _shared/gen（CI unit 不生成 gen）、不 import npm 包。
// 请求、响应、错误码以 shared/schema/ai-provider.ts 为准（index.ts 注入 aiProviderReq 的解析和 TASK_SUPPORT）。
// 顺序：① 只收 POST → ② requireActiveUser → ③ 请求体 ≤ MAX_BODY、过 schema，否则 400 → ④ admin_* 先查 private.admins，不是回 403 not_admin
//   （界面藏起来只是好看，每个动作服务器都再查）→ ⑤ 动作。
// 动作（成功、失败回包的形状都以 shared/schema/ai-provider.ts 为准，前端 zod 逐个钉住）：
//   mine：{admin, project（柠檬记给对话和整理用的那家）, own（自己的密钥：服务商、模型名、后四位、在不在用、最近一次用不了改用柠檬记的时刻和原因；没有为 null）}
//   own_test / admin_test：用填的（或库里存着的）密钥真发一次最小的 JSON 请求（generate），回 {ok, ms} 或 {ok: false, code}；
//     试调前先查同意（aiAllowed，没同意 409 consent_required，TC-B1-15）、每人每分钟 TEST_PER_MIN 次
//   own_use：先试，通了先把记录写进 private.ai_user_keys（改用、清掉“用不了”的提示），再把密钥存进 Vault（ai_ukey_<user_id>）；
//     存 Vault 失败就把记录改回原样（原来没有就删），不留“Vault 里有、表里没有”的孤儿密钥（注销时删 Vault 靠表上的触发器，account-purge 另外兜底）。
//     回 {ok: true, own}；没通回试调结果，什么都不存
//   own_off：改回柠檬记提供的 AI（密钥留着），回 {ok: true}；own_delete：删记录（触发器连 Vault 那条一起删）并再删一次 Vault，删了找不回，回 {ok: true}
//   admin_get：{routes（每项现在由哪家做）, keys（每家存的模型名、后四位、存的时间、has_key 现在有没有能用的项目密钥：Vault 或环境变量）}——任何情况下都不回密钥
//   admin_key：先试，通了先写 app_config.ai.providers（模型名、后四位）和这家正在做的用途的新模型名，再把密钥存进 Vault（ai_key_<服务商>）；
//     存 Vault 失败就把 app_config.ai 写回原样；存好清掉这个实例的密钥缓存（wire.ts 的 forgetProjectKey）。回 {ok: true}
//   admin_route：某项改由哪家做（supportOf 是 yes、这家有模型名和项目密钥），写 app_config.ai.tasks.<用途>，回 {ok: true}。
//     向量（embed）暂不让写：换向量要整库重算，重算流程还没做（回 409 not_supported）
//   联网搜索（负责人 11-23 弹窗：Brave / Tavily，没有模型名）：admin_web_test 真搜一次固定词 WEB_TEST_QUERY（tryWebKey）；
//     admin_web_key 先试，通了先写 app_config.ai.providers.<brave|tavily|naver>（后四位、存的时间），再存 Vault（ai_key_<同名>），失败照样写回原样；
//     admin_web_route {providers} 写 app_config.ai.web（勾了哪几家，负责人 11-25：“每个服务商后面可以单独打勾来框选，选几个就用几个”；对所有人生效）：
//     数组只收四家、去重、按 WEB_PROVIDERS 排、至少一家；新勾上的那家要有能用的密钥（没有 409 not_tested），原来就勾着的照留。
//     admin_get 单独回 web（勾的几家数组，不在 routes 里，独立评审第 9 条；旧的 'multi'、单家字符串经 webPicksOf 换成数组，没配给 DeepSeek + Brave + Naver）。
//     Naver 的密钥存成一个值 id:secret（ai_key_naver）；DeepSeek 搜索用对话那家的 ai_key_deepseek，没有单独的搜索密钥行
//   admin_web_compare（对比用，负责人 11-24：按照3你调查一下，对比一下）：{queries（1～10 条，每条 1～128 字）} 每条让 Brave、Tavily、DeepSeek 搜索
//     用各自存的项目密钥各搜一次（DeepSeek 用对话那家的 ai_key_deepseek），回 {rows: [{query, brave, tavily, deepseek}]}，每家 {ok, ms, results | code}；
//     同意、限速和试调同一套（整批算一次）；什么都不存，联网用哪家不变。逻辑在 compare.ts；试调失败归类在 fail.ts（两边共用）
// 生效：各 AI 函数的 app_config 和项目密钥都按 60 秒缓存（_shared/ai/wire.ts），最长 1 分钟换过去，不用发版；每个人自己的密钥每次现读。
// 日志只记动作和码（A23）：不记密钥、模型名、服务商回的正文。
import type { AuthResult } from '../_shared/auth-result.ts';
import { readJsonCapped } from '../_shared/body.ts';
import { json } from '../_shared/http.ts';
import { utcMinuteKey } from '../_shared/rate-key.ts';
import { GEN_PARAMS } from '../_shared/ai/params.ts';
import { AI_TASKS, capsOf, PROVIDER_NAMES, type AIProvider, type AiTask, type ProviderName, type WebSearcher } from '../_shared/ai/provider.ts';
import { readAiConfig, routeFor, type KeyOwner } from '../_shared/ai/router.ts';
import { WEB_KEY_OWNERS, WEB_PROVIDERS, type WebKeyOwner, type WebProviderName } from '../_shared/ai/websearch.ts';
import { isObj } from '../_shared/obj.ts';
import { webCompare } from './compare.ts';
import { AI_AUTH_STATUS, TEST_TIMEOUT_MS, testFailOf, WEB_AUTH_STATUS, type TestRes } from './fail.ts';

export const MAX_BODY = 4096;
/** 试调每人每分钟最多几次（含 own_use、admin_key 里的那一次，admin_web_compare 整批算一次；shared/schema 的 rate_limited） */
export const TEST_PER_MIN = 10;

/** 请求体（shared/schema/ai-provider.ts 的 aiProviderReq 解析过的形状；本文件不引 shared） */
export type Req =
  | { action: 'mine' | 'own_off' | 'own_delete' | 'admin_get' }
  | { action: 'own_test' | 'own_use' | 'admin_test' | 'admin_key'; provider: ProviderName; model: string; key?: string | undefined }
  | { action: 'admin_route'; task: AiTask; provider: ProviderName }
  | { action: 'admin_web_test' | 'admin_web_key'; provider: WebKeyOwner; key?: string | undefined }
  | { action: 'admin_web_route'; providers: WebProviderName[] }
  | { action: 'admin_web_compare'; queries: string[] };

/** private.ai_user_keys 一行（fell_back_*：最近一次密钥用不了、改用了柠檬记的，_shared/ai/gate.ts 的 ownFirst 经 wire.ts 写） */
export interface OwnRow {
  provider: ProviderName;
  model: string;
  key_last4: string;
  active: boolean;
  fell_back_at: string | null;
  fell_back_why: 'auth' | 'quota' | null;
}

export interface Deps {
  authenticate(req: Request): Promise<AuthResult<{ userId: string }>>;
  /** aiProviderReq.safeParse（不合格 null） */
  parse(v: unknown): Req | null;
  /** shared/schema 的 supportOf（查 TASK_SUPPORT；表里没有的当 no） */
  support(task: AiTask, p: ProviderName): 'yes' | 'no' | 'later';
  isAdmin(userId: string): Promise<boolean>;
  /** _shared/consent.ts 的 aiAllowed（TC-B1-15：没同意 AI 的人一条都不送；试调虽然只发一句 ping，也照样先查） */
  consent(userId: string): Promise<boolean>;
  rate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** app_config.ai 现读（不走缓存）；出错抛 */
  readAi(): Promise<unknown>;
  /** 整个 app_config.ai 写回；出错抛 */
  writeAi(ai: Record<string, unknown>): Promise<void>;
  /** private.ai_secret_set / get（名字 ai_key_<服务商>、ai_ukey_<user_id>）；key 为 null 是删 */
  secretSet(name: string, key: string | null): Promise<void>;
  secretGet(name: string): Promise<string | null>;
  /** 管理员给全体配的这家的密钥（Vault → 环境变量，wire.ts 的 projectKey） */
  projectKey(p: KeyOwner): Promise<string | undefined>;
  /** 存了新的项目密钥：清掉这个实例里的缓存（wire.ts 的 forgetProjectKey） */
  forgetKey(p: KeyOwner): void;
  /** 建一家联网搜索（websearch.ts 的 makeSearcher）；没密钥、密钥格式不对回 null */
  makeSearcher(p: WebProviderName, key: string): WebSearcher | null;
  ownRead(userId: string): Promise<OwnRow | null>;
  /** 整行写（upsert：同一个人两次同时首存不会撞主键） */
  ownWrite(userId: string, row: OwnRow): Promise<void>;
  ownActive(userId: string, active: boolean): Promise<void>;
  ownDelete(userId: string): Promise<void>;
  /** 建一家的适配器（router.ts 的 makeProvider）；模型名不合法、没密钥回 null */
  make(p: ProviderName, model: string, key: string): AIProvider | null;
  now(): number;
  log(code: string): void;
}

const ownOut = (r: OwnRow) => {
  const at = r.fell_back_at === null ? NaN : Date.parse(r.fell_back_at);
  return {
    provider: r.provider, model: r.model, last4: r.key_last4, active: r.active,
    fell_back: Number.isFinite(at) && r.fell_back_why !== null ? { at, why: r.fell_back_why } : null,
  };
};

const userKeyName = (uid: string) => `ai_ukey_${uid}`;
const projectKeyName = (p: KeyOwner) => `ai_key_${p}`;

/** 联网搜索试调的搜索词（固定一句，不带任何用户内容） */
export const WEB_TEST_QUERY = 'weather';

/**
 * 联网搜索试调：真搜一次，回 {ok, ms} 或固定词（11-23）。401 / 403 / 422 当密钥不对（Brave 认不出密钥回 422 SUBSCRIPTION_TOKEN_INVALID、Tavily 回 401），
 * quota、timeout 照搜索结果，连不上 net，其余 error
 */
export async function tryWebKey(deps: Pick<Deps, 'makeSearcher' | 'now'>, p: WebKeyOwner, key: string): Promise<TestRes> {
  const s = deps.makeSearcher(p, key);
  if (!s) return { ok: false, code: 'auth' };
  const t0 = deps.now();
  const r = await s.search({ query: WEB_TEST_QUERY, lang: 'zh', timeoutMs: TEST_TIMEOUT_MS });
  return r.ok ? { ok: true, ms: Math.max(0, deps.now() - t0) } : testFailOf(r, WEB_AUTH_STATUS, false);
}

/** 试调：一次最小的 JSON 请求；失败按状态码归成固定词 */
export async function tryKey(deps: Pick<Deps, 'make' | 'now'>, p: ProviderName, model: string, key: string): Promise<TestRes> {
  const prov = deps.make(p, model, key);
  if (!prov) return { ok: false, code: 'model' };
  const t0 = deps.now();
  const r = await prov.generate({
    system: 'Reply with a JSON object {"ok": true}.',
    parts: [{ text: 'ping' }],
    schema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
    params: GEN_PARAMS,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  return r.ok ? { ok: true, ms: Math.max(0, deps.now() - t0) } : testFailOf(r, AI_AUTH_STATUS, true);
}

/**
 * 存项目密钥（admin_key、admin_web_key 共用，独立评审第 10 条）：先写配置（providers.<p> = entry 加 last4、saved_at，再并上 more 算出的别的字段），
 * 再写 Vault；Vault 写不进就把配置写回原样（见文件头）。没贴新密钥（用库里那把试的）只更新配置、last4 照旧
 */
async function saveProjectKey(
  deps: Deps, act: string, p: KeyOwner, newKey: string | undefined, entry: Record<string, unknown>, more: (ai: Record<string, unknown>) => Record<string, unknown> = () => ({}),
): Promise<void> {
  const ai = await readAiObj(deps);
  const providers = {
    ...(isObj(ai['providers']) ? ai['providers'] : {}),
    [p]: { ...entry, last4: newKey ? newKey.slice(-4) : keyInfo(ai, p).last4, saved_at: deps.now() },
  };
  await deps.writeAi({ ...ai, providers, ...more(ai) });
  if (!newKey) return;
  try {
    await deps.secretSet(projectKeyName(p), newKey);
  } catch (e) {
    await deps.writeAi(ai).catch(() => deps.log(`${act} rollback_failed`));
    throw e;
  }
  deps.forgetKey(p);
}

type KeyInfo = { model: string | null; last4: string | null; saved_at: number | null };

/** 某项有没有能用的项目密钥（Vault 里管理员存的，或 Gemini 的环境变量）；读出错当没有 */
const hasKey = async (deps: Pick<Deps, 'projectKey'>, p: KeyOwner): Promise<boolean> => (await deps.projectKey(p).catch(() => undefined)) !== undefined;

/** app_config.ai.providers.<p> 读出来（格式不对当没有）；gemini 没存过模型名时用顶层 model */
function keyInfo(ai: Record<string, unknown>, p: KeyOwner): KeyInfo {
  const all = isObj(ai['providers']) ? ai['providers'] : {};
  const hit = Object.hasOwn(all, p) ? all[p] : undefined;
  const o = isObj(hit) ? hit : {};
  const model = typeof o['model'] === 'string' ? o['model'] : p === 'gemini' && typeof ai['model'] === 'string' ? ai['model'] : null;
  return {
    model,
    last4: typeof o['last4'] === 'string' ? o['last4'] : null,
    saved_at: typeof o['saved_at'] === 'number' ? o['saved_at'] : null,
  };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const uid = auth.user.userId;
  const raw = await readJsonCapped(req, MAX_BODY);
  if (raw === 'too_large') return json(413, { error: 'too_large' });
  const body = deps.parse(raw);
  if (!body) return json(400, { error: 'bad_request' });
  try {
    return await run(deps, uid, body);
  } catch {
    deps.log(`${body.action} try_later`);
    return json(503, { error: 'try_later' });
  }
}

async function run(deps: Deps, uid: string, body: Req): Promise<Response> {
  const admin = await deps.isAdmin(uid);
  if (body.action.startsWith('admin_') && !admin) {
    deps.log(`${body.action} not_admin`);
    return json(403, { error: 'not_admin' });
  }
  // 试调前的两道：没同意 AI 回 409 consent_required（不发请求）；每人每分钟 TEST_PER_MIN 次
  const blockTry = async (): Promise<Response | null> => {
    if (!(await deps.consent(uid))) return json(409, { error: 'consent_required' });
    if (!(await deps.rate(utcMinuteKey('ai-provider', uid, deps.now()), TEST_PER_MIN, 60))) return json(429, { error: 'rate_limited' });
    return null;
  };
  switch (body.action) {
    case 'mine': {
      const own = await deps.ownRead(uid);
      const r = routeFor(readAiConfig(await deps.readAi()), 'chat');
      // images：这个人对话现在用的那家（开着自己的密钥就是他那家，对话四家都能接管）收不收图；前端据此藏不藏输入条的“＋”（独立评审第 4 条）
      const chatBy = own?.active ? own.provider : (r?.provider ?? null);
      return json(200, { admin, project: r?.provider ?? null, own: own ? ownOut(own) : null, images: chatBy !== null && capsOf(chatBy).imageIn });
    }
    case 'own_off':
      await deps.ownActive(uid, false);
      deps.log('own_off ok');
      return json(200, { ok: true });
    case 'own_delete':
      await deps.ownDelete(uid);
      await deps.secretSet(userKeyName(uid), null);
      deps.log('own_delete ok');
      return json(200, { ok: true });
    case 'own_test':
    case 'own_use': {
      if (deps.support('chat', body.provider) !== 'yes') return json(409, { error: 'not_supported' });
      const own = await deps.ownRead(uid);
      const key = body.key ?? (own && own.provider === body.provider ? await deps.secretGet(userKeyName(uid)) : null);
      if (!key) return json(409, { error: 'no_key' });
      const blocked = await blockTry();
      if (blocked) return blocked;
      const t = await tryKey(deps, body.provider, body.model, key);
      deps.log(`${body.action} ${body.provider} ${t.ok ? 'ok' : t.code}`);
      if (body.action === 'own_test' || !t.ok) return json(200, t);
      const row: OwnRow = {
        provider: body.provider, model: body.model, key_last4: body.key ? body.key.slice(-4) : (own?.key_last4 ?? ''), active: true, fell_back_at: null, fell_back_why: null,
      };
      // 先写行、再写 Vault（见文件头）：Vault 写不进就把行改回原样
      await deps.ownWrite(uid, row);
      if (body.key) {
        try {
          await deps.secretSet(userKeyName(uid), body.key);
        } catch (e) {
          await (own ? deps.ownWrite(uid, own) : deps.ownDelete(uid)).catch(() => deps.log('own_use rollback_failed'));
          throw e;
        }
      }
      return json(200, { ok: true, own: ownOut(row) });
    }
    case 'admin_get': {
      const ai = await readAiObj(deps);
      const cfg = readAiConfig(ai);
      // routes 只有三项 AI 用途；联网不归 AI 服务商，单独一个 web（独立评审第 9 条）
      const routes = Object.fromEntries(AI_TASKS.map((t) => [t, routeFor(cfg, t)?.provider ?? null]));
      const owners: readonly KeyOwner[] = [...PROVIDER_NAMES, ...WEB_KEY_OWNERS];
      const keys = Object.fromEntries(await Promise.all(owners.map(async (p) => [p, { ...keyInfo(ai, p), has_key: await hasKey(deps, p) }] as const)));
      return json(200, { routes, web: cfg.web, keys });
    }
    case 'admin_web_test':
    case 'admin_web_key': {
      const key = body.key ?? (await deps.projectKey(body.provider));
      if (!key) return json(409, { error: 'no_key' });
      const blocked = await blockTry();
      if (blocked) return blocked;
      const t = await tryWebKey(deps, body.provider, key);
      deps.log(`${body.action} ${body.provider} ${t.ok ? 'ok' : t.code}`);
      if (body.action === 'admin_web_test' || !t.ok) return json(200, t);
      await saveProjectKey(deps, body.action, body.provider, body.key, {});
      return json(200, { ok: true });
    }
    case 'admin_web_compare': {
      // 对比用（负责人 11-24：按照3你调查一下，对比一下）：和试调同一套同意、限速（整批算一次）
      const blocked = await blockTry();
      if (blocked) return blocked;
      return webCompare(deps, body.queries);
    }
    case 'admin_web_route': {
      // 勾了哪几家（负责人 11-25）：只认四家、去重、按 WEB_PROVIDERS 排，至少一家；新勾上的那家要有能用的密钥（存的时候已试通），
      // 原来就勾着、后来密钥被删的可以留着（搜索时自动跳过，websearch-mix.ts 的 webFor）
      const picks = WEB_PROVIDERS.filter((p) => body.providers.includes(p));
      if (picks.length === 0) return json(400, { error: 'bad_request' });
      const ai = await readAiObj(deps);
      const before = readAiConfig(ai).web;
      const added = picks.filter((p) => !before.includes(p));
      if (!(await Promise.all(added.map((p) => hasKey(deps, p)))).every(Boolean)) return json(409, { error: 'not_tested' });
      await deps.writeAi({ ...ai, web: picks });
      deps.log(`admin_web_route ${picks.join('+')}`);
      return json(200, { ok: true });
    }
    case 'admin_test':
    case 'admin_key': {
      const key = body.key ?? (await deps.projectKey(body.provider));
      if (!key) return json(409, { error: 'no_key' });
      const blocked = await blockTry();
      if (blocked) return blocked;
      const t = await tryKey(deps, body.provider, body.model, key);
      deps.log(`${body.action} ${body.provider} ${t.ok ? 'ok' : t.code}`);
      if (body.action === 'admin_test' || !t.ok) return json(200, t);
      const { provider: p, model } = body;
      // 这家正在做的用途跟着换成新模型名；顶层（没单独配的用途沿用的那家）是这家时，顶层模型名一起换
      await saveProjectKey(deps, body.action, p, body.key, { model }, (ai) => {
        const tasks = { ...(isObj(ai['tasks']) ? ai['tasks'] : {}) };
        for (const k of AI_TASKS) {
          const r = tasks[k];
          if (isObj(r) && r['provider'] === p) tasks[k] = { provider: p, model };
        }
        const top = typeof ai['provider'] === 'string' ? ai['provider'] : 'gemini';
        return { tasks, ...(top === p ? { model } : {}) };
      });
      return json(200, { ok: true });
    }
    case 'admin_route': {
      // 向量暂不让换（见文件头）；其余看能力表
      if (body.task === 'embed' || deps.support(body.task, body.provider) !== 'yes') return json(409, { error: 'not_supported' });
      const ai = await readAiObj(deps);
      const info = keyInfo(ai, body.provider);
      if (!info.model || !(await hasKey(deps, body.provider))) return json(409, { error: 'not_tested' });
      const tasks = { ...(isObj(ai['tasks']) ? ai['tasks'] : {}), [body.task]: { provider: body.provider, model: info.model } };
      await deps.writeAi({ ...ai, tasks });
      deps.log(`admin_route ${body.task} ${body.provider}`);
      return json(200, { ok: true });
    }
  }
}

async function readAiObj(deps: Pick<Deps, 'readAi'>): Promise<Record<string, unknown>> {
  const ai = await deps.readAi();
  return isObj(ai) ? { ...ai } : {};
}
