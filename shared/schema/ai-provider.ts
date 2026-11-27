// ai-provider 函数的请求和响应（R-494 AI 助手第 4 段：自行更换 AI 服务商；方案 2026-11-22_AI服务商 方向二 + “我的 AI”）。前后端共用这一份。A20：字符串里不放汉字。
// 负责人定的（11-22 弹窗）：管理员页按用途分开选（对话和整理 / 联网搜索 / 录音转文字 / 向量搜索）；先接 OpenAI、Claude、DeepSeek（加原来的 Gemini 共四家）；
//   每个人也能用自己的密钥（用自己密钥的不占每天 50 次）；同意页改泛称并重新同意。
// • 一个函数、按 action 分：人人能调的 mine / own_test / own_use / own_off / own_delete；只有管理员（private.admins）能调的 admin_get / admin_test / admin_key / admin_route，
//   别人调一律 403 not_admin（界面藏起来只是好看，服务器每一步都再查）。
//   11-23 起联网搜索换成 Brave / Tavily（负责人弹窗）：管理员另有 admin_web_test / admin_web_key / admin_web_route 三个动作（没有模型名）；
//   11-24 起加 DeepSeek、Naver；11-25 起 admin_web_route 改成四家各自打勾（providers 数组，DEFAULT_WEB_PICKS）。
//   11-24 对比用（负责人：按照3你调查一下，对比一下）：admin_web_compare 让 Brave、Tavily、DeepSeek 搜索各搜一次同一批问题，只回结果、不存。
// • 密钥只走一趟：手机 → 函数 → Supabase Vault；任何响应都不带密钥，只带后四位（last4）。
// • 试调：用填的模型和密钥真发一次最小请求，回 ok 和耗时；不通回固定的 TEST_FAIL_CODES（不带服务商原文）。存密钥前一定先试通（服务器自己再试，不信前端）。
import { z } from 'zod';

export const AI_PROVIDER_FN = 'ai-provider';

/** 四家服务商（和 supabase/functions/_shared/ai/provider.ts 的 PROVIDER_NAMES 一致，tests 钉住） */
export const AI_PROVIDERS = ['gemini', 'claude', 'openai', 'deepseek'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/**
 * 联网搜索的四家（负责人 11-23 弹窗：不用谷歌搜索接地，改接 Brave、Tavily；11-24：DeepSeek + Brave + Naver 同时搜、AI 汇总，三家都挂退 Tavily）。
 * 和 supabase/functions/_shared/ai/websearch.ts 的 WEB_PROVIDERS 一致，tests 钉住。联网不归四家 AI 服务商；密钥只有管理员配（自带密钥不管联网）
 */
export const WEB_PROVIDERS = ['deepseek', 'brave', 'naver', 'tavily'] as const;
export type AiWebName = (typeof WEB_PROVIDERS)[number];
/**
 * 有自己搜索密钥的三家（管理员页“密钥”卡各一行，存 admin_web_key；和 websearch.ts 的 WEB_KEY_OWNERS、迁移 20261124130000 的 private.ai_key_name_ok 一致）。
 * DeepSeek 搜索复用对话那家的密钥（负责人 11-24：不新建密钥），在“密钥”卡的 DeepSeek 那一行
 */
export const WEB_KEY_OWNERS = ['brave', 'tavily', 'naver'] as const;
export type WebKeyOwnerName = (typeof WEB_KEY_OWNERS)[number];
/** 管理员页“密钥”那组的七行：四家 AI 服务商 + 三家联网搜索 */
export const KEY_OWNERS = [...AI_PROVIDERS, ...WEB_KEY_OWNERS] as const;
export type KeyOwnerName = (typeof KEY_OWNERS)[number];
/** 这家是只做联网搜索、存自己搜索密钥的那三家（没有模型名，存密钥走 admin_web_*） */
export const isWebKeyOwner = (v: unknown): v is WebKeyOwnerName => typeof v === 'string' && (WEB_KEY_OWNERS as readonly string[]).includes(v);
/** Naver 的密钥：Client ID 和 Client Secret 用一个冒号连成一个值（两段都不含冒号；和 websearch.ts 的 NAVER_KEY_RE 一致，tests 钉住） */
export const NAVER_KEY_RE = /^([\x21-\x39\x3b-\x7e]+):([\x21-\x39\x3b-\x7e]+)$/;

/**
 * 联网搜索勾了哪几家（负责人 11-25：“每个服务商后面可以单独打勾来框选，选几个就用几个”）：WEB_PROVIDERS 里勾几家（至少一家），勾了几家就同时搜几家，
 * 约 3 秒不等慢的、去重合并交给 AI 汇总；勾的全挂退没勾的里有密钥的一家（Tavily 在先）。
 * 只有管理员改（admin_web_route），写 app_config.ai.web（数组），对所有人生效；没设置过是 DEFAULT_WEB_PICKS。和 websearch.ts 的 DEFAULT_WEB_PICKS 一致，tests 钉住
 */
export const DEFAULT_WEB_PICKS = ['deepseek', 'brave', 'naver'] as const;

/**
 * 联网搜索对比（对比用，负责人 11-24：按照3你调查一下，对比一下）：admin_web_compare 让这三家各搜一次同一批问题（回包形状固定这三家）。
 * 和 websearch.ts 的 COMPARE_WEB 一致，tests 钉住
 */
export const WEB_COMPARE_PROVIDERS = ['brave', 'tavily', 'deepseek'] as const;
/** 一次最多几条问题、每条最多几个字（DeepSeek 搜索的 query 上限 128） */
export const WEB_COMPARE_MAX = 10;
export const WEB_COMPARE_QUERY_MAX = 128;
/** 每条结果的摘要截到几个字（和 ai-provider/core.ts 的 COMPARE_SNIPPET_MAX 一致，tests 钉住） */
export const WEB_COMPARE_SNIPPET_MAX = 120;

/**
 * 交给 AI 服务商的三项用途：chat 对话和整理（含“＋”整理、总结、分类）、stt 录音转文字、embed 向量搜索（和后端 provider.ts 的 AI_TASKS 一致）。
 * 联网搜索不在这里（独立评审第 9 条）：它由联网搜索那几家做（WEB_PROVIDERS），管理员页单独一行、admin_get 单独回 web
 */
export const AI_ROUTE_TASKS = ['chat', 'stt', 'embed'] as const;
export type AiRouteTask = (typeof AI_ROUTE_TASKS)[number];

/**
 * 四家 AI 服务商每项现在能不能做（方案第 5 节查过官方文档；11-23 第 4 段实际接上的）：
 * yes 能选；no 这家没有这项（界面写“没有这项”）；later 这家有、柠檬记还没接（界面写“还没接上”）。
 * • 录音转文字：OpenAI 是另一个接口（gpt-transcribe），还没接；Claude、DeepSeek 没有。
 * • 向量：换向量要整库重算（方案“换向量要重算”），重算流程还没做，先只有 Gemini；Claude 没有，DeepSeek 文档里没有。
 */
export const TASK_SUPPORT: Readonly<Record<AiRouteTask, Readonly<Record<AiProviderName, 'yes' | 'no' | 'later'>>>> = {
  chat: { gemini: 'yes', claude: 'yes', openai: 'yes', deepseek: 'yes' },
  stt: { gemini: 'yes', claude: 'no', openai: 'later', deepseek: 'no' },
  embed: { gemini: 'yes', claude: 'no', openai: 'later', deepseek: 'no' },
};

/**
 * 用自己的密钥时，哪几项改由自己的那家做（负责人 11-22“自带密钥四项都能用”：这家能做的都用它）。
 * 现在实际接上的：对话和整理（四家都行）、录音转文字（这家能做时）。联网由柠檬记配的搜索服务做、向量等重算流程做好再加（界面照这里写“其余仍由柠檬记的 AI 做”）。
 */
export const OWN_KEY_TASKS: readonly AiRouteTask[] = ['chat', 'stt'];
/** 查 TASK_SUPPORT：只取自有属性（check_backend F7；表里没有的当 no） */
export function supportOf(task: AiRouteTask, p: AiProviderName): 'yes' | 'no' | 'later' {
  const row = Object.hasOwn(TASK_SUPPORT, task) ? TASK_SUPPORT[task] : undefined;
  if (!row) return 'no';
  return Object.hasOwn(row, p) ? row[p] : 'no';
}
export const ownCovers = (p: AiProviderName): AiRouteTask[] => OWN_KEY_TASKS.filter((t) => supportOf(t, p) === 'yes');

/** 试调不通的原因（固定词）：auth 密钥不对（401/403）、model 模型名不存在（404）、quota 余额或额度用完（402/429）、timeout 10 秒没回、net 连不上、error 其他 */
export const TEST_FAIL_CODES = ['auth', 'model', 'quota', 'timeout', 'net', 'error'] as const;
export type TestFailCode = (typeof TEST_FAIL_CODES)[number];

/** 函数自己的错误码（另有共用的 bad_request、method_not_allowed、unauthorized 等，见 invite-admin.ts 的说明） */
export const AI_PROVIDER_ERROR_CODES = [
  'not_admin',     // 403  admin_* 动作，调用者不在 private.admins 里
  'not_tested',    // 409  admin_route：这家还没存好模型名或项目密钥（存密钥时已试通）
  'not_supported', // 409  admin_route / own_use：这家做不了这项（TASK_SUPPORT 不是 yes）；admin_route 的向量暂不让换（换向量要整库重算，流程还没做）
  'no_key',        // 409  own_test / own_use / admin_test 没带密钥、库里也没有
  'consent_required', // 409  试调（own_test / own_use / admin_test / admin_key / admin_web_test / admin_web_key）和 admin_web_compare 前查同意：没同意 AI 不发（TC-B1-15）
  'rate_limited',  // 429  试调每人每分钟 10 次（admin_web_compare 整批算一次）
  'try_later',     // 503  数据库或 Vault 暂时不通
] as const;
export type AiProviderErrorCode = (typeof AI_PROVIDER_ERROR_CODES)[number];

/** 模型名：字母数字和 . _ - :（和后端 _shared/ai/compat.ts 的 MODEL_RE、迁移里 ai_user_keys.model 的 check 同一口径，tests/edge/ai-adapters.test.ts 钉住），1～64 个字 */
export const MODEL_NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** 密钥：8～300 个可见 ASCII 字符（不收空格、换行：贴进来的前后空白由前端先去掉） */
export const API_KEY_RE = /^[\x21-\x7e]{8,300}$/;
/** 后四位：密钥最后 4 个字符（界面写“••••a1B2”） */
export const last4Of = (key: string): string => key.slice(-4);

const provider = z.enum(AI_PROVIDERS);
const webKeyOwner = z.enum(WEB_KEY_OWNERS);
/** 勾的几家：只收四家、不重复、至少一家 */
const webPicks = z.array(z.enum(WEB_PROVIDERS)).min(1).max(WEB_PROVIDERS.length).refine((xs) => new Set(xs).size === xs.length);
const model = z.string().regex(MODEL_NAME_RE);
const key = z.string().regex(API_KEY_RE);

export const aiProviderReq = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('mine') }),
  /** key 不带：用库里存着的那把（换模型名时不用重贴） */
  z.strictObject({ action: z.literal('own_test'), provider, model, key: key.optional() }),
  /** 先试，通了才存并改用（前端在“确定改用”以后发） */
  z.strictObject({ action: z.literal('own_use'), provider, model, key: key.optional() }),
  /** 改回柠檬记提供的 AI（密钥留着） */
  z.strictObject({ action: z.literal('own_off') }),
  /** 删掉自己的密钥（Vault 那条一起删，删了找不回），自动回到柠檬记的 AI */
  z.strictObject({ action: z.literal('own_delete') }),
  z.strictObject({ action: z.literal('admin_get') }),
  z.strictObject({ action: z.literal('admin_test'), provider, model, key: key.optional() }),
  /** 先试，通了才存这家的模型名和密钥（key 不带 = 只改模型名，用库里那把试） */
  z.strictObject({ action: z.literal('admin_key'), provider, model, key: key.optional() }),
  /** 某项改由哪家做（这家要已存好密钥、能做这项）；联网（web）用 admin_web_route */
  z.strictObject({ action: z.literal('admin_route'), task: z.enum(AI_ROUTE_TASKS), provider }),
  /** 有自己搜索密钥的三家（Brave、Tavily、Naver）：试一下、先试再存密钥（没有模型名；key 不带 = 用库里那把） */
  z.strictObject({ action: z.literal('admin_web_test'), provider: webKeyOwner, key: key.optional() }),
  z.strictObject({ action: z.literal('admin_web_key'), provider: webKeyOwner, key: key.optional() }),
  /** 联网搜索勾了哪几家（11-25 起是数组；原来的 provider 单选字段不再收） */
  z.strictObject({ action: z.literal('admin_web_route'), providers: webPicks }),
  /** 对比用（负责人 11-24）：同一批问题三家各搜一次，见 WEB_COMPARE_PROVIDERS */
  z.strictObject({ action: z.literal('admin_web_compare'), queries: z.array(z.string().trim().min(1).max(WEB_COMPARE_QUERY_MAX)).min(1).max(WEB_COMPARE_MAX) }),
]);
export type AiProviderReq = z.infer<typeof aiProviderReq>;

const last4 = z.string().max(4);
/** 自己的密钥为什么用不了（负责人 11-23：欠费、额度满 quota；密钥失效 auth） */
export const OWN_DEAD_CODES = ['auth', 'quota'] as const;
/**
 * 自己的密钥（没存过为 null）：active 是不是正在用它；
 * fell_back：最近一次密钥用不了、自动改用了柠檬记的 AI 的时刻（毫秒）和原因（“我的 AI”页提示用；重新“改用这把密钥”后清空，为 null）
 */
export const ownKey = z.strictObject({
  provider, model, last4, active: z.boolean(),
  fell_back: z.strictObject({ at: z.number().int().nonnegative(), why: z.enum(OWN_DEAD_CODES) }).nullable(),
});
export type OwnKey = z.infer<typeof ownKey>;

/**
 * mine：admin 决定设置首页出不出“AI 服务商”一行；project 是柠檬记现在给对话和整理用的那家（“柠檬记现在用的是 Gemini”）；
 * images：这个人对话现在用的那家（开着自己的密钥就是他那家）收不收图，AI 助手据此藏不藏输入条的“＋”（独立评审第 4 条）
 */
export const mineRes = z.strictObject({ admin: z.boolean(), project: provider.nullable(), own: ownKey.nullable(), images: z.boolean() });
export type MineRes = z.infer<typeof mineRes>;


const testFail = z.strictObject({ ok: z.literal(false), code: z.enum(TEST_FAIL_CODES), status: z.number().int().optional() });

/** 试调结果：通了带耗时（毫秒），不通带原因 */
export const testRes = z.union([z.strictObject({ ok: z.literal(true), ms: z.number().int().nonnegative() }), testFail]);
export type TestRes = z.infer<typeof testRes>;

/** own_off、own_delete、admin_route 成功 */
export const okRes = z.strictObject({ ok: z.literal(true) });
/** own_use：先试，没通回试调的失败（什么都没存）；通了存好、回存好的那一份 */
export const ownUseRes = z.union([z.strictObject({ ok: z.literal(true), own: ownKey }), testFail]);
export type OwnUseRes = z.infer<typeof ownUseRes>;
/** admin_key：先试，没通回试调的失败（什么都没存）；通了存好 */
export const adminKeyRes = z.union([okRes, testFail]);

/**
 * 管理员页：每项现在由哪家做（没配的项沿用柠檬记默认那家）、每家存的模型名和后四位（没存为 null）；
 * has_key：这家现在有没有能用的项目密钥（Vault 里存的，或 Gemini 只配了环境变量的也算），界面“已填密钥 / 还没填密钥”只照它
 */
export const keyInfo = z.strictObject({ model: model.nullable(), last4: last4.nullable(), saved_at: z.number().int().nullable(), has_key: z.boolean() });
export type KeyInfo = z.infer<typeof keyInfo>;
export const adminGetRes = z.strictObject({
  routes: z.strictObject({ chat: provider.nullable(), stt: provider.nullable(), embed: provider.nullable() }),
  /** 联网搜索勾了哪几家（按 WEB_PROVIDERS 排；没配也给出默认的 DEFAULT_WEB_PICKS） */
  web: webPicks,
  /** brave、tavily、naver 没有模型名（model 一律 null）；DeepSeek 搜索用 deepseek 那一把 */
  keys: z.strictObject({ gemini: keyInfo, claude: keyInfo, openai: keyInfo, deepseek: keyInfo, brave: keyInfo, tavily: keyInfo, naver: keyInfo }),
});
export type AdminGetRes = z.infer<typeof adminGetRes>;

/** 对比里一家搜一条不通的原因：试调那几个固定词，另加 no_key（这家没存项目密钥，没搜） */
export const WEB_COMPARE_FAIL_CODES = [...TEST_FAIL_CODES, 'no_key'] as const;
/** 搜到的一条：site 是网址的主机名；date 是这家给的网页日期原样（没有为 null）；snippet 摘要截到 WEB_COMPARE_SNIPPET_MAX 字 */
export const webCompareHit = z.strictObject({ title: z.string(), url: z.string(), site: z.string(), date: z.string().nullable(), snippet: z.string() });
/** 一家搜一条：ms 是这一家这一条用了多少毫秒（没存密钥为 0） */
export const webCompareOne = z.union([
  z.strictObject({ ok: z.literal(true), ms: z.number().int().nonnegative(), results: z.array(webCompareHit) }),
  z.strictObject({ ok: z.literal(false), ms: z.number().int().nonnegative(), code: z.enum(WEB_COMPARE_FAIL_CODES), status: z.number().int().optional() }),
]);
/** admin_web_compare：按请求里的顺序，每条问题一行，三家各一份 */
export const webCompareRes = z.strictObject({
  rows: z.array(z.strictObject({ query: z.string(), brave: webCompareOne, tavily: webCompareOne, deepseek: webCompareOne })),
});
export type WebCompareRes = z.infer<typeof webCompareRes>;
