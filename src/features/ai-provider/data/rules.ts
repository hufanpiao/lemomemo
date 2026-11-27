// 设置 › 我的 AI、AI 服务商 两页的规则（契约 shared/schema/ai-provider.ts 的 supportOf（查 TASK_SUPPORT）、ownCovers、MODEL_NAME_RE、API_KEY_RE）
// • 管理员页“XX用哪家”：每家一行的状态——这家没有这项（no）、还没接上（later）、还没填密钥（服务器回的 has_key 是 false）都变灰点不了，其余写“已填密钥 · 试通过”
//   （has_key 由服务器按 Vault 和环境变量算：Gemini 只配了环境变量的也算有；存密钥时服务器已经试通过）
// • 向量（embed）这项暂不让换（换向量要整库重算，流程还没做；服务器 admin_route 也拒）：弹层里每家都点不了
// • 某项没配（routes 里是 null）：契约写“沿用柠檬记默认那家”，默认是 Gemini（_shared/ai/router.ts 的 routeFor：顶层 provider 没写当 gemini），界面照写 Gemini
// • 自带密钥：这家接管 ownCovers 算出来的几项，剩下的仍由柠檬记的 AI 做、占每天次数
// • 联网搜索（四家各自打勾，勾几家用几家）：不归四家 AI 服务商。
//   “联网搜索”那一行弹层列 WEB_PROVIDERS 四家，每家一个勾、可以勾几家（toggleWeb）；没密钥的变灰勾不上，但已经勾着的（后来密钥被删了）能取消；
//   只剩一个勾时那一个点了没反应（至少勾一家，同单选里点已选那项没反应的做法）。行值写勾的几家，用 + 连。
//   “密钥”卡多 Brave、Tavily、Naver 三行（DeepSeek 搜索用对话那家的密钥，不另加行）；这三家没有模型名（canTest 不看模型名）、“这家没有”卡不画；
//   Naver 的密钥要填成 “Client ID:Client Secret” 一个值（NAVER_KEY_RE），格式不对“试一下”点不了
// 纯 TS：不准 import React
import {
  AI_PROVIDERS, AI_ROUTE_TASKS, API_KEY_RE, isWebKeyOwner, KEY_OWNERS, MODEL_NAME_RE, NAVER_KEY_RE, ownCovers, supportOf, WEB_PROVIDERS,
  type AdminGetRes, type AiProviderName, type AiRouteTask, type AiWebName, type KeyOwnerName, type TestFailCode,
} from '../../../../shared/schema/ai-provider.ts';

export const DEFAULT_PROVIDER: AiProviderName = 'gemini';

export const isProvider = (v: string | undefined): v is AiProviderName => (AI_PROVIDERS as readonly string[]).includes(v ?? '');
/** 有密钥页的几家（四家 AI 服务商 + Brave、Tavily、Naver） */
export const isKeyOwner = (v: string | undefined): v is KeyOwnerName => (KEY_OWNERS as readonly string[]).includes(v ?? '');
/** 这家要不要填模型名（Brave、Tavily、Naver 不用） */
export const needsModel = (p: KeyOwnerName): boolean => !isWebKeyOwner(p);

/**
 * 管理员页“每项用哪家”的四行（照稿子的顺序）：三项 AI 用途（AI_ROUTE_TASKS），第二行插“联网搜索”。
 * 联网不在 AI 用途表里，只在这一层分开：它的值读 admin_get 的 web（勾的几家）、弹层列 WEB_PROVIDERS、改了发 admin_web_route
 */
export type AdminRow = AiRouteTask | 'web';
export const ADMIN_ROWS: readonly AdminRow[] = ['chat', 'web', 'stt', 'embed'];

/** 弹层里的一项：一家服务商（联网那一行是搜索四家之一） */
export type PickName = KeyOwnerName;

/** 三项 AI 用途现在由哪家做（没配 = 默认那家） */
export const routeOf = (admin: Pick<AdminGetRes, 'routes'>, row: AiRouteTask): AiProviderName => admin.routes[row] ?? DEFAULT_PROVIDER;

/** 弹层里这一项现在打没打勾：联网看勾的几家里有没有它，其余看是不是现在那一家 */
export const isOn = (admin: Pick<AdminGetRes, 'routes' | 'web'>, row: AdminRow, p: PickName): boolean =>
  row === 'web' ? (admin.web as readonly string[]).includes(p) : routeOf(admin, row) === p;

/** “XX用哪家”弹层列哪几项：联网列搜索四家（WEB_PROVIDERS），其余列四家 AI 服务商 */
export const pickList = (row: AdminRow): readonly PickName[] => (row === 'web' ? WEB_PROVIDERS : AI_PROVIDERS);

/**
 * 联网那一行点了 p 以后勾的几家（按 WEB_PROVIDERS 排）：勾着的取消、没勾的勾上；
 * 取消以后一家都不剩回 null（至少勾一家：点了没反应）
 */
export function toggleWeb(cur: readonly AiWebName[], p: AiWebName): AiWebName[] | null {
  const next = WEB_PROVIDERS.filter((k) => (k === p ? !cur.includes(k) : cur.includes(k)));
  return next.length > 0 ? next : null;
}

export type PickState = 'ok' | 'no' | 'later' | 'nokey';

export const isWebProvider = (p: PickName): p is AiWebName => (WEB_PROVIDERS as readonly string[]).includes(p);

/**
 * “XX用哪家”弹层里这一项的状态：AI 用途先查能力表，再看有没有能用的密钥（has_key）；联网那一行看这家有没有密钥
 */
export function pickState(row: AdminRow, p: PickName, keys: AdminGetRes['keys']): PickState {
  if (row === 'web') return isWebProvider(p) ? (keys[p].has_key ? 'ok' : 'nokey') : 'no';
  const s = isProvider(p) ? supportOf(row, p) : 'no';
  if (s !== 'yes') return s;
  return isProvider(p) && keys[p].has_key ? 'ok' : 'nokey';
}

/** 这项能不能在管理员页换（向量暂不让换，见文件头） */
export const routeWritable = (row: AdminRow): boolean => row !== 'embed';

/** 这家没有的几项（详情页“这家没有：……”卡；只列 no，later 是柠檬记还没接，不算这家没有）；Brave、Tavily 不做 AI 用途，不画这张卡 */
export const missingOf = (p: KeyOwnerName): AiRouteTask[] => (isProvider(p) ? AI_ROUTE_TASKS.filter((t) => supportOf(t, p) === 'no') : []);

/** 用自己的这家密钥时：这家接管哪几项、剩下哪几项仍由柠檬记做（联网从来不归自己的密钥，总在剩下的里） */
export function ownSplit(p: AiProviderName): { covers: AiRouteTask[]; rest: AdminRow[] } {
  const covers = ownCovers(p);
  const has: readonly AdminRow[] = covers;
  return { covers, rest: ADMIN_ROWS.filter((t) => !has.includes(t)) };
}

/** “没通”卡最后一行“其他可能的原因也会这样直说：……”列的几种（照稿子：除了这次这一种） */
const TOLD: readonly TestFailCode[] = ['auth', 'model', 'quota', 'timeout'];
export const otherFails = (code: TestFailCode): TestFailCode[] => TOLD.filter((c) => c !== code);

export const modelOk = (m: string): boolean => MODEL_NAME_RE.test(m.trim());
/** 贴进来的密钥：前后空白去掉再认；Naver 另要 “Client ID:Client Secret” 的样子 */
export const keyOk = (k: string, p?: KeyOwnerName): boolean => API_KEY_RE.test(k.trim()) && (p !== 'naver' || NAVER_KEY_RE.test(k.trim()));

/**
 * 能不能点“试一下”：模型名对（withModel 为 false 的 Brave、Tavily 不看）、并且要么贴了一把格式对的新密钥，要么没贴、但这家库里已经存着一把（hasSaved）
 * 贴了半截（格式不对）不能试，免得用库里那把试通了、存的却是半截
 */
export function canTest(model: string, key: string, hasSaved: boolean, withModel = true, p?: KeyOwnerName): boolean {
  if (withModel && !modelOk(model)) return false;
  return key.trim() === '' ? hasSaved : keyOk(key, p);
}

/** 毫秒 → “0.8”秒（一位小数） */
export const secOf = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(1);

/** “HH:MM” → 上午 / 下午、12 小时制的点和分（清零写“下午 5 点”，不写“17:00”）；0 点写上午 12 点、12 点写下午 12 点 */
export function clockParts(hm: string): { pm: boolean; h: number; m: number } {
  const [hh = 0, mm = 0] = hm.split(':').map(Number);
  return { pm: hh >= 12, h: hh % 12 === 0 ? 12 : hh % 12, m: mm };
}
