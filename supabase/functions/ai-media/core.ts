// ai-media：后台识图（架构 5.13 第 5 点“cron 函数 ai-media”、第 6 节 ai-media 行、第 8 点用量表；R-112、R-114 D-8、D-9；B4b-2）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/ai-media.test.ts）。不 import _shared/gen（CI unit 不生成 gen）。
// 每 5 分钟由 pg_cron 带 x-cron-secret 调一次（迁移 20261115040000_ai_media.sql）：
//   ① 谷歌额度用完（ai_state.exhausted_until 没过）、AI 没配好（模型、密钥）：整轮不做，只写心跳；
//   ② 从扫描视图 private.scan_note_images 随机挑最多 USERS_MAX 个有到期 pending 图片的人（随机：卡住的人不占名额，同 ai-embed）；
//   ③ 逐人（一轮墙钟预算 ROUND_BUDGET_MS，一轮最多 MAX_CALLS 次 AI）：读这个人最早的 BATCH 张到期 pending 图片（fn_ai，app.uid = 本人）——
//      isUsable 不过 → 这几张推后 LATER_MS；
//      隐私记的图（bucket = vault-images、或所在随手记 is_private）→ 推后 VAULT_LATER_MS 留着：隐私记的图这一批不识别、不进向量（主持人定；
//        服务器解密识图、vault_ai 加密写回和隐私记线一起做），不每轮空扫；
//      所在随手记在“最近删除”里 → 推后 LATER_MS（恢复了照常识别，30 天清理时跟着删）；
//      aiAllowed 不过（没同意、关了 AI、同意版本过期）→ 这个人全部 pending 的普通图片写 skip、skip_reason = consent（R-179：重新同意、
//        重新打开 AI 时由触发器 private.ai_consent_resume 改回 pending，迁移 20261115040000）；写完再查一次同意：
//        查和写之间用户刚好打开了 AI（触发器先跑、那时还没有可恢复的），就把刚写的这几张改回 pending（11-14 整块评审第 2 条）；
//   ④ 先扣全项目 ai:global:<太平洋日期>，上限是 global_daily 的 GLOBAL_SHARE（70%）——到了整轮让路，把额度留给打字和录音（第 8 点、L7）；
//      扣上以后这个人后面哪一步出错、没送成 AI，都退回这一次（finally）；
//   ⑤ 按 user_id、note_id、id 拼路径从 R2 images 桶读缩略图（has_thumb；缩略图不在再读原图；没有缩略图读原图，> IMAGE_MAX_BYTES 写 skip/other），
//      不读存下来的 path（第四轮安全 S1）；原图也不在（另一台设备还没传上、页面关了没传上）按这张失败处理；
//   ⑥ 每人每天 media:<uid>:<太平洋日期>（user_limits.media_daily；没有这一行用 app_config.ai.media_daily_default，朋友默认 40；null = 不设上限，照样计数）：
//      键是附录 A 定的 media:，只能经 take_rate 计（ai_quota_take 只收 ai: 开头的键，退不回），所以“识别成了才算”——
//      送 AI 前先扣 1 张看还有没有余额（扣不上 → 退回全项目那一次、这个人全部 pending 推到太平洋午夜，不每轮空扫），
//      识别成了再按写成的张数补扣其余的（补扣到上限就停，同一批最多多识别 BATCH − 1 张）；送 AI 失败只损失先扣的那 1 张（R-356 失败退回额度的近似，代定）；
//   ⑦ 一次请求最多 BATCH 张（responseSchema 约束 {results:[{i, desc, tags[]}]}，request.ts 读回、清洗）；
//      成功：带条件（还是 pending、还在 images 桶）写 ai_status = done、ai_desc、ai_tags（ai_desc 一变，0007 的 note_images_embed 触发器入队，
//        ai-embed 把“描述 + 标签 + 所在随手记标题”算成向量，按意思能查到这张图）；
//      模型没给这一张、出错、超时、对象不在：ai_tries + 1，第 1、2 次各推后 BACKOFF_MS（10 分钟、1 小时），第 MAX_TRIES 次还失败 → failed
//        （界面“没识别 · 重新识别”，点了调 file-check {action: retry_ai}）；
//      谷歌额度用完（429）：退回全项目那一次、写 exhausted_until（exhaustedUntilFor：每天的到太平洋午夜、每分钟的按 retryDelay），这批不计 ai_tries，本轮停；
//   ⑧ 写心跳 ai-media（只有计数和布尔）。日志只记码和数，不记描述、标签、路径；出错时报错信息本身是安全码（如 db:profiles）的带上。
import { cronGate, errorResponder, json, NO_STORE } from '../_shared/http.ts';
import { readAll } from '../_shared/body.ts';
import { exhaustedUntilFor, globalQuotaKey, nextPacificMidnight, pacificDate, type QuotaStore } from '../_shared/ai/gate.ts';
import { aiFailCode, type AIProvider } from '../_shared/ai/provider.ts';
import type { AiConfig } from '../_shared/ai/router.ts';
import { QUOTA_WINDOW_S } from '../_shared/ai/store.ts';
import { isObj } from '../_shared/obj.ts';
import { mediaRequest, readResults, type MediaLocale } from './request.ts';

export const USERS_MAX = 20;
/** 一次请求最多几张（5.13 第 5 点） */
export const BATCH = 6;
/** 一轮最多送几次 AI */
export const MAX_CALLS = 10;
/** 一轮墙钟预算（同 ai-classify；pg_net 超时 55 秒，迁移里写） */
export const ROUND_BUDGET_MS = 40_000;
/** 第 1、2 次失败各推后多久；第 MAX_TRIES 次失败记 failed */
export const BACKOFF_MS = [10 * 60_000, 3600_000] as const;
export const MAX_TRIES = 3;
export const LATER_MS = 24 * 3600_000;
export const VAULT_LATER_MS = 30 * LATER_MS;
/** 后台识图最多用到全项目每天额度的几成（第 8 点“超过 70% 让路”） */
export const GLOBAL_SHARE = 0.7;
/** 没有缩略图时原图最多读多大（字节）；更大的写 skip/other */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const BUCKET = 'images';
/** app_config.ai.media_daily_default 读不出时（朋友默认 40，R-114 D-9） */
export const MEDIA_DAILY_DEFAULT = 40;
/** 不设上限的人：照样计数，上限给一个用不到的数（同 note-search） */
export const UNLIMITED = 1_000_000;

/** fn_ai 读到的一张图（只用到这些列） */
export interface MediaItem {
  id: string;
  note_id: string;
  bucket: string;
  has_thumb: boolean;
  tries: number;
  /** 所在随手记是隐私记 */
  note_private: boolean;
  /** 所在随手记在“最近删除”里（或已经没了） */
  note_gone: boolean;
}

export interface Store {
  users(limit: number, nowMs: number): Promise<string[]>;
  /** 这个人最早的 limit 张到期 pending 图片（没删的） */
  items(userId: string, limit: number, nowMs: number): Promise<MediaItem[]>;
  /** 推后：还是 pending 的才改；bump 时 ai_tries + 1 */
  later(userId: string, ids: readonly string[], atMs: number, bump: boolean): Promise<void>;
  /** 这个人全部到期 pending 的图推到 atMs（每天额度用完） */
  parkAll(userId: string, atMs: number): Promise<void>;
  /** 这个人全部 pending 的普通图片写 skip / consent；回写了哪几张 */
  skipConsent(userId: string): Promise<string[]>;
  /** 刚写的 skip / consent 改回 pending（写完发现已经同意了） */
  unskip(userId: string, ids: readonly string[]): Promise<void>;
  skipOther(userId: string, ids: readonly string[]): Promise<void>;
  /** 试满了：failed、ai_tries = tries */
  fail(userId: string, id: string, tries: number): Promise<void>;
  /** 带条件写回（还是 pending、还在 images 桶）；回写成没有 */
  done(userId: string, id: string, desc: string, tags: readonly string[]): Promise<boolean>;
  heartbeat(detail: Heartbeat): Promise<void>;
}

export interface Obj {
  get(bucket: string, key: string): Promise<{ body: unknown; contentLength: number | null } | null>;
}

export interface MediaConfig {
  ai: AiConfig;
  /** app_config.ai.media_daily_default */
  mediaDailyDefault: number;
}

/** app_config.ai 里的 media_daily_default（格式不对按 40） */
export function readMediaDefault(ai: unknown): number {
  const v = isObj(ai) ? ai['media_daily_default'] : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : MEDIA_DAILY_DEFAULT;
}

export interface Deps {
  cronSecret: string | undefined;
  store: Store | null;
  r2: Obj | null;
  isUsable(userId: string): Promise<boolean>;
  consent(userId: string): Promise<boolean>;
  config(): Promise<MediaConfig>;
  provider(cfg: AiConfig): AIProvider | null;
  quota: QuotaStore;
  /** private.take_rate */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** private.user_limits.media_daily：没有这一行 undefined，写着 null 为 null（不设上限） */
  mediaDaily(userId: string): Promise<number | null | undefined>;
  /** profiles.ui_locale → 描述用的语言 */
  locale(userId: string): Promise<MediaLocale>;
  exhaustedUntil(): Promise<number | null>;
  markExhausted(untilMs: number): Promise<void>;
  /** 图片对象路径（shared/logic/files/media-path.ts，由 index.ts 注入） */
  path(userId: string, noteId: string, id: string, thumb: boolean): string;
  now(): number;
  log(code: string): void;
}

/** 心跳 detail（只是个数和布尔） */
export type Heartbeat = {
  users: number; images: number; done: number; retry: number; failed: number; consent: number; parked: number; other: number; calls: number; ms: number;
  quota_hit: boolean; global_yield: boolean; budget_hit: boolean;
};

export const backoffAt = (now: number, tries: number): number => now + (tries <= 0 ? BACKOFF_MS[0] : BACKOFF_MS[1]);
export const mediaKey = (userId: string, ms: number): string => `media:${userId}:${pacificDate(ms)}`;
/** 全项目计数里后台识图能用到的上限（global_daily 没配按 0：AI 一律不调） */
export const globalShare = (globalDaily: number | null): number => Math.floor((globalDaily ?? 0) * GLOBAL_SHARE);

/** 报错信息本身是安全码（db:profiles 这种）时带上，别的不记（不把可能带内容的报错写进日志） */
const safeCode = (e: unknown): string => {
  const m = e instanceof Error ? e.message : '';
  return /^[a-z_]+(:[a-z_]+)?$/.test(m) ? `:${m}` : '';
};

type Round = { cfg: MediaConfig; provider: AIProvider; store: Store; r2: Obj; h: Heartbeat; calls: number };

/** 一张或几张没成：ai_tries + 1，没满 MAX_TRIES 退避，满了 failed */
async function failed(deps: Deps, r: Round, uid: string, items: readonly MediaItem[]): Promise<void> {
  const now = deps.now();
  for (const it of items) {
    const tries = it.tries + 1;
    if (tries >= MAX_TRIES) {
      await r.store.fail(uid, it.id, tries);
      r.h.failed += 1;
    } else {
      await r.store.later(uid, [it.id], backoffAt(now, it.tries), true);
      r.h.retry += 1;
    }
  }
}

/** 一个人的一轮；回 'stop' 表示额度用完或让路、本轮不再往下做 */
async function oneUser(deps: Deps, r: Round, uid: string): Promise<'ok' | 'stop'> {
  const now = deps.now();
  const items = await r.store.items(uid, BATCH, now);
  if (items.length === 0) return 'ok';
  r.h.users += 1;
  r.h.images += items.length;
  const ids = (xs: readonly MediaItem[]) => xs.map((x) => x.id);
  if (!(await deps.isUsable(uid))) {
    await r.store.later(uid, ids(items), now + LATER_MS, false);
    r.h.parked += items.length;
    return 'ok';
  }
  const vault = items.filter((x) => x.bucket !== BUCKET || x.note_private);
  const trashed = items.filter((x) => !vault.includes(x) && x.note_gone);
  const todo = items.filter((x) => !vault.includes(x) && !trashed.includes(x));
  if (vault.length > 0) await r.store.later(uid, ids(vault), now + VAULT_LATER_MS, false);
  if (trashed.length > 0) await r.store.later(uid, ids(trashed), now + LATER_MS, false);
  r.h.parked += vault.length + trashed.length;
  if (todo.length === 0) return 'ok';
  if (!(await deps.consent(uid))) {
    const skipped = await r.store.skipConsent(uid);
    if (await deps.consent(uid)) {
      await r.store.unskip(uid, skipped);
      deps.log('consent_raced');
    } else r.h.consent += skipped.length;
    return 'ok';
  }
  if (r.calls >= MAX_CALLS) return 'stop';

  // ④ 全项目（70% 让路）；扣上以后没送成 AI 就退回
  const globalKey = globalQuotaKey(now);
  if ((await deps.quota.take(globalKey, globalShare(r.cfg.ai.global_daily))) === null) {
    deps.log('global_yield');
    r.h.global_yield = true;
    return 'stop';
  }
  let sent = false;
  try {
    const inputs = await readImages(deps, r, uid, todo);
    if (inputs.length === 0) return 'ok';
    // ⑥ 每人每天：先扣 1 张看有没有余额
    const own = await deps.mediaDaily(uid);
    const limit = own === undefined ? r.cfg.mediaDailyDefault : own ?? UNLIMITED;
    const key = mediaKey(uid, now);
    if (!(await deps.takeRate(key, limit, QUOTA_WINDOW_S))) {
      await r.store.parkAll(uid, nextPacificMidnight(now));
      deps.log('daily_out');
      return 'ok';
    }
    const locale = await deps.locale(uid);
    sent = true;
    return await recognize(deps, r, uid, inputs, locale, globalKey, async (done) => {
      for (let k = 1; k < done && (await deps.takeRate(key, limit, QUOTA_WINDOW_S)); k += 1);
    });
  } finally {
    if (!sent) await deps.quota.refund(globalKey).catch(() => deps.log('settle_failed'));
  }
}

/** ⑤ 读图（不读存下来的 path）：缩略图不在再读原图；太大的写 skip/other，都不在的按失败 */
async function readImages(deps: Deps, r: Round, uid: string, todo: readonly MediaItem[]): Promise<{ it: MediaItem; bytes: Uint8Array }[]> {
  const inputs: { it: MediaItem; bytes: Uint8Array }[] = [];
  const missing: MediaItem[] = [];
  const big: MediaItem[] = [];
  for (const it of todo) {
    const obj = (it.has_thumb ? await r.r2.get(BUCKET, deps.path(uid, it.note_id, it.id, true)) : null) ?? (await r.r2.get(BUCKET, deps.path(uid, it.note_id, it.id, false)));
    if (!obj) missing.push(it);
    else if (obj.contentLength !== null && obj.contentLength > IMAGE_MAX_BYTES) big.push(it);
    else {
      const bytes = await readAll(obj.body);
      if (bytes.length > IMAGE_MAX_BYTES) big.push(it);
      else inputs.push({ it, bytes });
    }
  }
  if (big.length > 0) {
    await r.store.skipOther(uid, big.map((x) => x.id));
    r.h.other += big.length;
  }
  if (missing.length > 0) {
    deps.log(`object_missing n=${missing.length}`);
    await failed(deps, r, uid, missing);
  }
  return inputs;
}

/** ⑦ 送 AI、写回；全项目那一次已扣（失败退回），charge(写成几张) 补扣每人张数 */
async function recognize(
  deps: Deps, r: Round, uid: string, batch: readonly { it: MediaItem; bytes: Uint8Array }[], locale: MediaLocale, globalKey: string,
  charge: (done: number) => Promise<void>,
): Promise<'ok' | 'stop'> {
  r.calls += 1;
  r.h.calls += 1;
  let res;
  try {
    res = await r.provider.generate(mediaRequest(batch.map((b) => ({ mime: 'image/webp', bytes: b.bytes })), locale));
  } catch {
    res = { ok: false as const, reason: 'error' as const };
  }
  if (!res.ok) {
    deps.log(aiFailCode(res));
    await deps.quota.refund(globalKey).catch(() => deps.log('settle_failed'));
    if (res.reason === 'quota') {
      await deps.markExhausted(exhaustedUntilFor(deps.now(), res)).catch(() => deps.log('settle_failed'));
      r.h.quota_hit = true;
      return 'stop';
    }
    await failed(deps, r, uid, batch.map((b) => b.it));
    return 'ok';
  }
  const got = readResults(res.json, batch.length);
  if (got.size < batch.length) deps.log(`ai_partial n=${batch.length - got.size}`);
  const miss: MediaItem[] = [];
  let done = 0;
  for (const [i, b] of batch.entries()) {
    const g = got.get(i);
    if (!g) miss.push(b.it);
    else if (await r.store.done(uid, b.it.id, g.desc, g.tags)) done += 1;
  }
  r.h.done += done;
  await charge(done);
  if (miss.length > 0) await failed(deps, r, uid, miss);
  return 'ok';
}

type Code = 'method_not_allowed' | 'misconfigured';
const err = errorResponder<Code>();

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
  if (denied) return denied;
  const { store, r2 } = deps;
  if (!store || !r2) {
    deps.log('misconfigured');
    return err(500, 'misconfigured');
  }
  const t0 = deps.now();
  const h: Heartbeat = { users: 0, images: 0, done: 0, retry: 0, failed: 0, consent: 0, parked: 0, other: 0, calls: 0, ms: 0, quota_hit: false, global_yield: false, budget_hit: false };
  try {
    const until = await deps.exhaustedUntil();
    let cfg: MediaConfig | null = null;
    let provider: AIProvider | null = null;
    if (until !== null && until > t0) h.quota_hit = true;
    else {
      cfg = await deps.config();
      provider = deps.provider(cfg.ai);
      if (!provider) deps.log('ai_not_configured');
    }
    if (cfg && provider) {
      const r: Round = { cfg, provider, store, r2, h, calls: 0 };
      for (const uid of await store.users(USERS_MAX, t0)) {
        if (deps.now() - t0 >= ROUND_BUDGET_MS) {
          h.budget_hit = true;
          deps.log('round_budget');
          break;
        }
        try {
          if ((await oneUser(deps, r, uid)) === 'stop') break;
        } catch (e) {
          h.failed += 1;
          deps.log(`user_failed${safeCode(e)}`);
        }
      }
    }
    h.ms = deps.now() - t0;
    await store.heartbeat(h);
  } catch (e) {
    deps.log(`try_later${safeCode(e)}`);
    return json(503, { error: 'try_later' }, NO_STORE);
  }
  return json(200, { ok: true, ...h }, NO_STORE);
}
