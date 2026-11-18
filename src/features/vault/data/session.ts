// 隐私记会话（B5 FA-1；架构 5.5、0.27 第 5 点、0.29 续第 87、94、127 条；S6；TC-B5-10、11、44、47）
// • 令牌、明文、图片的 blob URL 只在这个对象的内存里；令牌另抄一份到 core/vault-token.ts（导出要带），同样只在内存
// • 明文放在会话持有的内存仓库 store（./vault-store.ts）：解锁时 list 一次全量放进去，之后界面读写都只碰它；
//   改动交给会话持有的发送队列 queue（./vault-queue.ts）在后台串行发（B5 隐私记重写 11-15，负责人“读取跟写入速度太慢了”）
// • lock()：清仓库里的明文、令牌、撤销全部 blob URL（TC-B5-11：上锁后组件树、DOM 里不留明文；D3：撤销后的地址再用就失效）
// • 上锁只有一套做法（11-15 正确性评审 M1：原来软硬两套叠了 epoch、hardEpoch、STALE、CANCELLED、late、会话 waiters、held……）：
//   - 每上锁一次 epoch 加 1；上锁以后才回来的结果一律当“已锁上”（STALE）：不收令牌、不写明文、不造 blob 地址、不弹解锁
//   - 令牌过期（vault_locked）：后台队列暂停（不丢）、仓库清空、waiting = true 弹解锁卡；在飞的写回来也当失败，解锁拉完列表后队列整条重发
//     （save 是整行写、add_images 重发服务器跳过，重发无害）。编辑页卸下时没交的草稿照样交给队列（锁着时只进队列，不进仓库）
//   - 别的上锁（主动上锁、离开超时、取消解锁、vault_relock、session_revoked）：队列整个丢掉（个数记进仓库，解锁后报一句）。
//     软状态只在 waiting 期间成立：进“锁着且没在等解锁”的路径一律等同这种
//   - 不进队列的写（移进移出、永久删除、改密码、Face ID、附件）锁着时直接回 vault_locked（界面弹解锁卡，解锁后由用户再点一次），会话不排队等
// • 运行日志（第 14 条）：状态迁移（phase、waiting、relock）、错误码和 left、STALE 丢弃、续期结果、取图失败经 rlog 记；
//   不记标题、正文、密码、令牌、图片 id
// • 失败怎么落只按 data/vault-errors.ts 的落法（kind）分支（onFail 里穷尽 switch），不另写一套按码判断
// • run(req)：带令牌调 vault；成功换上新令牌（每次续期 600 秒）。
//   - vault_locked → 上锁、置 waiting（界面弹解锁）、回失败；后台队列解锁后自己重发（TC-B5-47 ① 改成这样，M1）
//   - vault_relock → 上锁、relocked = true（提示“密码已在别的设备修改”、不显示 Face ID，TC-B5-47 ②）
//   - session_revoked → 上锁，交给同步引擎退出（D20：和 B1 同一条路）
// • 离开、回来（S6）：离开时刻按原因分开记（'app'：离开 App；'page'：离开隐私记页，负责人 11-15“离开隐私记页 1 分钟不自动上锁”）。
//   hide(now, why) 记下；show(now, min, why) 这个原因离开满 min 分钟就上锁（59 秒不锁、61 秒锁，TC-B5-10），再看别的原因满没满（check）。
//   check(now, min)：任何一个原因离开满时长就上锁；入口行、查找行、移进隐私记读状态前先调一次（计时器被浏览器压后时也对）。
//   有离开原因时自己挂一个计时器到点调 check（App 在前台、只是离开了隐私记页，到点就锁，不等回来）。
//   隐私记页没挂着时解锁的（移进隐私记弹的解锁卡）：解锁那一刻就记 'page'。默认原因是 'app'，原来的调用不用改。
//   令牌过期、等解锁（waiting）时也算、计时照常走：满时长就丢掉后台队列（审查第 2 条：原来只认已解锁，没发完的明文一直留在内存）。
//   盖遮罩、去遮罩由 hooks/useVault.ts 的 watchLeave 同步做；页面挂上、卸下由 useVaultPresence 报；这里只管锁不锁
// • 取图（image）：同时最多 2 张（IMG_SLOTS），限流、服务忙、断网（kind retry）退避 2 秒、5 秒、15 秒再取；本机刚插的图 seedImage 直接放进图片表，不再取
// • 续期（M2）：编辑页有输入时调 touch()，拿到令牌满 5 分钟就发一次 {renew}（按本机拿到令牌的时刻算，不受两边时钟差影响）；
//   vault-image 只验不续，令牌过期（vault_locked）时先 {renew} 再试一次（renew 也被拒就上锁）；取图失败不缓存（M6）
// • 文档附件（B4b-1，vault-file）：同 vault-image 只验不续（withImageToken）；成功放了微软预览的临时明文副本时记下，上锁时先发 ms_preview_end（keepalive）。
//   审查第 4 条：服务器的 ms_preview_end 只验 JWT（令牌过期也删得掉），令牌有才带；没发成（断网、JWT 过期）记下，下次解锁后补发一次（endOwed）
// • 不碰 core/cache、outbox、log（A18）
import { z } from 'zod';
import {
  vaultCredentialsResponse, vaultListResponse, vaultOkResponse, vaultPurgeResponse, vaultStatusResponse, vaultTokenResponse, vaultUnlockResponse,
  webauthnOptionsResponse, type VaultRequest,
} from '../../../../shared/schema/vault.ts';
import { vaultFileListResponse, vaultFileOkResponse, vaultFilePreviewResponse, vaultFileUploadResponse, type VaultFileMeta } from '../../../../shared/schema/vault-file.ts';
import { setVaultToken } from '../../../core/vault-token.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { VaultApi, VaultFail, VaultResult } from './vault-api.ts';
import { unhandled, vaultErrorAction, type VaultCode } from './vault-errors.ts';
import { createVaultQueue, limiter, QUEUE_BACKOFF } from './vault-queue.ts';
import { createVaultStore } from './vault-store.ts';

export type VaultPhase = 'loading' | 'offline' | 'unset' | 'locked' | 'unlocked' | 'error';

export interface VaultStatus {
  set: boolean;
  lastResetAt: number | null;
  webauthn: number;
}

export interface VaultState {
  phase: VaultPhase;
  status: VaultStatus | null;
  /** 这一段解锁期拉过列表了（明文在 store 里，这里只记拉没拉过） */
  listed: boolean;
  /** 别处改过、重设过密码：提示一句、不显示 Face ID，直到用新密码解锁 */
  relocked: boolean;
  /** 有请求等着解锁后重试（界面据此弹解锁） */
  waiting: boolean;
  /** 上一次解锁失败：还能试几次 */
  left: number | null;
  /** 正在锁定：到这个时刻（毫秒）才能再试 */
  lockedUntil: number | null;
  /** 最近一次失败的码（界面挑文案） */
  lastError: VaultCode | null;
}

const INIT: VaultState = {
  phase: 'loading', status: null, listed: false, relocked: false, waiting: false, left: null, lockedUntil: null, lastError: null,
};

const tokenShape = z.object({ vault_token: z.string(), expires_at: z.number() });
/** 上锁以后才回来的结果（按引用比较：调用方不再 onFail、不弹解锁；后台队列当失败、解锁后重发） */
const STALE: VaultFail = { ok: false, code: 'vault_locked' };
const dropped = (r: VaultResult<unknown>): boolean => r === STALE;
/** 拿到令牌满这么久、编辑页又有输入就续一次（令牌 10 分钟） */
export const RENEW_AFTER_MS = 5 * 60_000;

export interface VaultSessionDeps {
  api: VaultApi;
  now?: () => number;
  /** 测试用：不写 core/vault-token */
  onToken?: (token: string | null, expiresAt: number) => void;
  createUrl?: (b: Blob) => string;
  revokeUrl?: (url: string) => void;
  /** 测试用：退避等待（默认 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
}

/** 离开的原因：离开 App、离开隐私记页 */
export type LeaveWhy = 'app' | 'page';

/** 同时取几张图（列表封面只取看得见的，这里再限一道并发） */
export const IMG_SLOTS = 2;

export type VaultSession = ReturnType<typeof createVaultSession>;

export function createVaultSession(d: VaultSessionDeps) {
  const now = d.now ?? (() => Date.now());
  const onToken = d.onToken ?? setVaultToken;
  const createUrl = d.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = d.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const imgSlot = limiter(IMG_SLOTS);

  let state: VaultState = INIT;
  let token: string | null = null;
  /** 本机拿到当前令牌的时刻（touch 据此判断该不该续） */
  let tokenAt = 0;
  let renewing = false;
  /** 按原因记的离开时刻 */
  const away = new Map<LeaveWhy, number>();
  /** 隐私记页挂着 */
  let onPage = false;
  /** 自动上锁分钟数（设置里的 vault.autolock_min，hooks/useVault.ts 的 useAutolockMin 报进来） */
  let autoMin = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 每上锁一次加 1：上锁以后才回来的结果据此当 STALE */
  let epoch = 0;
  const blobs = new Map<string, string>();
  const pendingImg = new Map<string, Promise<string | null>>();
  /** 服务器上有没有这个人的微软预览临时明文副本（ms_preview 成功后 true，ms_preview_end 后 false） */
  let msLive = false;
  /** 发过 ms_preview_end、还没确认成了：解锁后补发一次 */
  let endOwed = false;
  const listeners = new Set<() => void>();
  const store = createVaultStore();
  const queue = createVaultQueue({
    store,
    save: (req) => run({ action: 'save', ...req }, vaultOkResponse),
    setDeleted: (id, del) => run({ action: del ? 'delete' : 'undelete', id }, vaultOkResponse),
    async upload(noteId, imageId, part, blob) {
      const r = await withImageToken((tok) => d.api.imageUpload({ note_id: noteId, image_id: imageId, part }, blob, tok));
      if (!r.ok && !dropped(r)) {
        const kind = vaultErrorAction(r.code).kind;
        if (kind === 'relock' || kind === 'revoked') onFail(r);
      }
      return r;
    },
    seed: (imageId, full, thumb) => seedImage(imageId, full, thumb),
    reload: () => void list(),
    now,
    sleep,
    log: rlog,
  });

  const set = (patch: Partial<VaultState>): void => {
    const was = state;
    state = { ...state, ...patch };
    if (was.phase !== state.phase || was.waiting !== state.waiting || was.relocked !== state.relocked) {
      rlog(`vault state ${state.phase}${state.waiting ? ' waiting' : ''}${state.relocked ? ' relock' : ''}${state.lastError ? ` err=${state.lastError}` : ''}`);
    }
    for (const fn of [...listeners]) fn();
  };

  const takeToken = (v: unknown): void => {
    const p = tokenShape.safeParse(v);
    if (!p.success) return;
    token = p.data.vault_token;
    tokenAt = now();
    onToken(token, p.data.expires_at);
  };

  /** 这几张图的 blob 地址立即撤销（删图、永久删除、移出时，L1：不等上锁才撤） */
  function revokeImages(ids: readonly string[]): void {
    for (const id of ids) {
      for (const part of ['full', 'thumb'] as const) {
        const key = `${id}:${part}`;
        const url = blobs.get(key);
        if (url) revokeUrl(url);
        blobs.delete(key);
        pendingImg.delete(key);
      }
    }
  }

  /** 几条从仓库拿掉，连它们的图的 blob 地址一起撤销 */
  function forgetNotes(ids: readonly string[]): void {
    revokeImages(store.getSnapshot().images.filter((r) => ids.includes(String(r['note_id']))).map((r) => r.id));
    store.forget(ids);
  }

  function revokeAll(): void {
    for (const url of blobs.values()) revokeUrl(url);
    blobs.clear();
    pendingImg.clear();
  }

  /** 发 ms_preview_end（同步发出），没成就记 endOwed */
  function endPreview(why: 'lock' | 'close' | 'resend'): void {
    msLive = false;
    endOwed = true;
    rlog(`vatt ms_preview_end ${why} tok=${token ? 1 : 0}`);
    void d.api.fileEnd(token).then((ok) => {
      if (ok) endOwed = false;
      rlog(`vatt ms_preview_end ${ok ? 'ok' : 'fail'}`);
    });
  }

  /**
   * 上锁：清明文、令牌、blob URL；同步完成。drop：丢掉后台队列的原因（运行日志 vault queue drop why=）；
   * null = 令牌过期：队列暂停不丢、waiting = true 弹解锁卡、离开计时照常走（H1）。软状态只在 waiting 期间成立
   */
  function lock(patch: Partial<VaultState>, drop: string | null): void {
    if (msLive) endPreview('lock');
    token = null;
    epoch += 1;
    onToken(null, 0);
    revokeAll();
    store.clear();
    if (drop === null) queue.pause();
    else {
      queue.dropAll(drop);
      away.clear();
    }
    const set_ = state.status?.set ?? true;
    set({ phase: set_ ? 'locked' : 'unset', listed: false, waiting: drop === null, ...patch });
    arm();
  }

  /** 失败怎么落：按 vault-errors.ts 的落法分支（vault_locked 的“等解锁、重试一次”在 run 里，走到这里的 unlock 是重试后仍锁、或 list 被拒） */
  function onFail(f: VaultFail): void {
    const kind = vaultErrorAction(f.code).kind;
    switch (kind) {
      case 'relock':
        lock({ relocked: true, lastError: f.code }, kind);
        return;
      case 'revoked':
        lock({ lastError: f.code }, kind);
        return;
      case 'unlock':
        lock({ lastError: f.code }, null);
        return;
      case 'pin_wrong':
        // 第 6 条：锁上的那一次服务器回 423 pin_locked；万一回的是 pin_wrong 又带了 retry_after_s，照样显示倒计时
        rlog(`vault fail ${f.code} left=${f.left ?? '-'}${f.retryAfterS !== undefined ? ` retry=${f.retryAfterS}` : ''}`);
        set({ left: f.left ?? null, lastError: f.code, ...(f.retryAfterS !== undefined ? { lockedUntil: now() + f.retryAfterS * 1000 } : {}) });
        return;
      case 'pin_locked':
        rlog(`vault fail ${f.code} retry=${f.retryAfterS ?? '-'}`);
        set({ lockedUntil: now() + (f.retryAfterS ?? 60) * 1000, left: 0, lastError: f.code });
        return;
      case 'setup':
      case 'reauth':
      case 'webauthn':
      case 'retry':
      case 'message':
        rlog(`vault fail ${f.code}`);
        set({ lastError: f.code });
        return;
      default:
        unhandled(kind);
    }
  }

  /** 发出去、回来时还是同一段解锁期才算数（第 8 条）：中间上过锁（哪一种都算）→ STALE */
  async function guarded<T>(send: () => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    const e = epoch;
    const r = await send();
    if (epoch === e) return r;
    rlog(`vault stale ${r.ok ? 'ok' : r.code}`);
    return STALE;
  }

  /** 要令牌的请求：成功收新令牌；失败按落法落（vault_locked：上锁、弹解锁卡、回失败，不在这里等） */
  async function run<S extends z.ZodType>(req: VaultRequest, schema: S): Promise<VaultResult<z.infer<S>>> {
    const r = await guarded(() => d.api.call(req, token, schema));
    if (r.ok) takeToken(r.value);
    else if (!dropped(r)) onFail(r);
    return r;
  }

  const renew = async () => {
    const r = await run({ action: 'renew' }, vaultTokenResponse);
    rlog(`vault renew ${r.ok ? 'ok' : r === STALE ? 'stale' : r.code}`);
    return r;
  };

  /**
   * vault-image 只验不续期：令牌过期（vault_locked）时先 renew 再试一次（renew 也被拒：run 已经上锁）。
   * 半路上锁回 STALE；别的失败原样回，由调用方决定落不落（renew 自己的失败 run 已经落过）
   */
  async function withImageToken<T>(send: (tok: string) => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    const go = (): Promise<VaultResult<T>> => (token ? send(token) : Promise.resolve({ ok: false, code: 'vault_locked' } as VaultFail));
    const r = await guarded(go);
    if (dropped(r) || r.ok || r.code !== 'vault_locked') return r;
    const k = await renew();
    if (!k.ok) return k;
    return token ? guarded(go) : STALE;
  }

  /** vault-file 的一次调用：只验不续（同 vault-image）；relock、revoked 一类要落 */
  async function fileOp<T>(send: (tok: string) => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    const r = await withImageToken(send);
    if (!r.ok && !dropped(r)) {
      const kind = vaultErrorAction(r.code).kind;
      if (kind === 'relock' || kind === 'revoked') onFail(r);
    }
    return r;
  }

  async function refreshStatus(): Promise<VaultResult<VaultStatus>> {
    const r = await d.api.call({ action: 'status' }, null, vaultStatusResponse);
    if (!r.ok) {
      if (r.code === 'offline') set({ phase: state.phase === 'unlocked' ? 'unlocked' : 'offline', lastError: 'offline' });
      else {
        onFail(r);
        if (state.phase === 'loading') set({ phase: 'error' });
      }
      return r;
    }
    const status: VaultStatus = { set: r.value.set, lastResetAt: r.value.last_reset_at, webauthn: r.value.webauthn };
    const phase: VaultPhase = !status.set ? 'unset' : state.phase === 'unlocked' && token ? 'unlocked' : 'locked';
    // 倒计时按服务器给的还剩几秒、从本机现在算（审查第 5 条：原来拿服务器的绝对时刻比本机时钟，两边差几分钟倒计时就错）
    const retry = r.value.retry_after_s;
    if (retry) rlog(`vault status locked retry=${retry}`);
    set({ status, phase, lockedUntil: retry ? now() + retry * 1000 : null });
    return { ok: true, value: status };
  }

  /** 解锁类请求（setup、unlock、reset、Face ID）：半路上锁就丢掉签来的令牌，不进已解锁 */
  async function afterUnlock(send: () => Promise<VaultResult<z.infer<typeof vaultUnlockResponse>>>): Promise<VaultResult<true>> {
    const r = await guarded(send);
    if (dropped(r)) return r as VaultFail;
    if (!r.ok) {
      onFail(r);
      return r;
    }
    takeToken(r.value);
    // 在隐私记页上解锁时请求带了 with_list，响应里就有整张列表（11-18“隐私记每次进去都很慢”：原来解锁 0.88s 后再串行 list 0.61s）；
    // 和 phase 一起置 listed，VaultPage 不再另发一次 list（日志 108.66 同时两次 list 就是它）
    const notes = onPage ? r.value.notes : undefined;
    if (notes) store.load(notes);
    const st = state.status ? { ...state.status, set: true } : { set: true, lastResetAt: null, webauthn: 0 };
    set({ phase: 'unlocked', status: st, relocked: false, waiting: false, left: null, lockedUntil: null, lastError: null, ...(notes ? { listed: true } : {}) });
    if (notes) queue.overlay();
    rlog(`vault unlocked with_list=${notes ? notes.length : '-'}`);
    if (endOwed) endPreview('resend');
    // 不在隐私记页上解锁的（移进隐私记弹的解锁卡）：这一刻起就算离开了隐私记页；也不拉列表（进隐私记页时再拉，M3）
    if (!onPage) away.set('page', now());
    arm();
    const listed: VaultResult<true> = onPage && !notes ? await list() : { ok: true, value: true };
    // 列表没拉成也接着发：队列里是整行，发出去无害；下次拉列表时再盖回仓库
    if (state.phase === 'unlocked') queue.resume();
    return listed.ok ? { ok: true, value: true } : listed;
  }

  /** 在隐私记页上解锁：请求顺带要列表（服务器回在 notes 里，afterUnlock 直接装进仓库） */
  const withList = (): { with_list?: true } => (onPage ? { with_list: true } : {});

  /** 拉明文列表；锁着（没令牌）就不拉；已经在拉就等那一次（不同时发两次） */
  let listing: Promise<VaultResult<true>> | null = null;
  function list(): Promise<VaultResult<true>> {
    if (!token) return Promise.resolve({ ok: true, value: true });
    listing ??= listOnce().finally(() => {
      listing = null;
    });
    return listing;
  }
  async function listOnce(): Promise<VaultResult<true>> {
    const r = await run({ action: 'list' }, vaultListResponse);
    if (!r.ok) return r;
    store.load(r.value.notes);
    set({ listed: true });
    queue.overlay();
    return { ok: true, value: true };
  }

  /** 已解锁，或令牌过期等解锁（waiting，后台队列里还有没发完的明文） */
  const live = (): boolean => state.phase === 'unlocked' || state.waiting;
  const minMs = (min: number): number => Math.max(1, min) * 60_000;

  /** 离开满时长：丢掉后台队列上锁（等解锁时也一样） */
  function autolock(why: LeaveWhy): void {
    rlog(`vault autolock why=${why}${state.waiting ? ' waiting' : ''}`);
    lock({}, 'lock');
  }

  /** 有离开原因时挂一个计时器，到最早那个满时长时调 check */
  function arm(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!live() || away.size === 0) return;
    const due = Math.min(...away.values()) + minMs(autoMin) - now();
    timer = setTimeout(() => {
      timer = null;
      check();
    }, Math.max(0, due) + 50);
  }

  /** 任何一个原因离开满自动上锁时长（setAutolock，只这一份）就上锁；回 true 表示锁上了 */
  function check(at: number = now()): boolean {
    if (!live()) {
      away.clear();
      arm();
      return false;
    }
    for (const [why, t] of away) {
      if (at - t >= minMs(autoMin)) {
        autolock(why);
        return true;
      }
    }
    arm();
    return false;
  }

  /** 本机刚插的图（原图、缩略图）放进图片表：显示直接用，不再经 vault-image 取（上锁时一起撤销） */
  function seedImage(imageId: string, full: Blob, thumb: Blob | null): void {
    if (!token) return;
    for (const [part, b] of [['full', full], ['thumb', thumb]] as const) {
      const key = `${imageId}:${part}`;
      if (b && !blobs.has(key)) blobs.set(key, createUrl(b));
    }
  }

  return {
    get: (): VaultState => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    hasToken: (): boolean => token !== null,
    refreshStatus,
    lock: (): void => lock({}, 'lock'),
    /** 取消等待中的解锁：等同主动上锁（软状态只在 waiting 期间成立，H2），后台队列整个丢掉 */
    cancelWait(): void {
      rlog('vault wait cancel');
      lock({}, 'cancel');
    },
    setup: (pin: string): Promise<VaultResult<true>> => afterUnlock(() => d.api.call({ action: 'setup', pin }, null, vaultTokenResponse)),
    unlock: (pin: string): Promise<VaultResult<true>> => afterUnlock(() => d.api.call({ action: 'unlock', pin, ...withList() }, null, vaultUnlockResponse)),
    async reset(newPin: string): Promise<VaultResult<true>> {
      const r = await afterUnlock(() => d.api.call({ action: 'reset', new_pin: newPin }, null, vaultTokenResponse));
      if (r.ok) set({ status: state.status ? { ...state.status, lastResetAt: now(), webauthn: 0 } : null });
      return r;
    },
    async webauthnOptions(purpose: 'register' | 'unlock') {
      return d.api.call({ action: 'webauthn_options', purpose }, null, webauthnOptionsResponse);
    },
    async unlockWebauthn(assertion: { id: string; client_data_json: string; authenticator_data: string; signature: string }) {
      return afterUnlock(() => d.api.call({ action: 'unlock_webauthn', assertion, ...withList() }, null, vaultUnlockResponse));
    },
    async registerWebauthn(pin: string, label: string, attestation: { id: string; client_data_json: string; attestation_object: string }) {
      const r = await run({ action: 'webauthn_register', pin, label, attestation }, vaultOkResponse);
      if (r.ok && state.status) set({ status: { ...state.status, webauthn: state.status.webauthn + 1 } });
      return r;
    },
    listCredentials: () => run({ action: 'list_credentials' }, vaultCredentialsResponse),
    async removeCredential(id: string) {
      const r = await run({ action: 'remove_credential', credential_id: id }, vaultOkResponse);
      if (r.ok && state.status) set({ status: { ...state.status, webauthn: Math.max(0, state.status.webauthn - 1) } });
      return r;
    },
    /** 改密码：失败的落法（pin_wrong 记还能试几次）在 onFail；成功后服务器已删全部 Face ID 凭据（M3），这里同步成 0 */
    async changePin(oldPin: string, newPin: string) {
      const r = await run({ action: 'change_pin', old_pin: oldPin, new_pin: newPin }, vaultTokenResponse);
      if (r.ok && state.status) set({ status: { ...state.status, webauthn: 0 } });
      return r;
    },
    /** 编辑页有输入时调（M2：一直在写的人保存时令牌不会已过期）；锁着、正在续、拿到令牌还不满 5 分钟都不动 */
    touch(): void {
      if (!token || renewing || now() - tokenAt < RENEW_AFTER_MS) return;
      renewing = true;
      void renew().then(() => {
        renewing = false;
      });
    },
    list,
    /** 会话持有的内存仓库、后台发送队列（界面经 hooks/vault-note-source.ts 读写） */
    store,
    queue,
    seedImage,
    revokeImages,
    /** 永久删除（要确认，不进后台队列）：发出前先撤掉队列里这几条的任务和标记（不再 save 回来，H5）；成了从仓库拿掉 */
    async purge(items: readonly string[]) {
      queue.forget(items);
      const r = await run({ action: 'purge', items: [...items] }, vaultPurgeResponse);
      if (r.ok) forgetNotes(items);
      return r;
    },
    /**
     * 普通随手记移进隐私记（S7）：要令牌，锁着时回 vault_locked（界面等解锁再移一次）。
     * 成了不整表重拉（M3）：拉过列表的记成没拉过，进隐私记页时再拉（这一条的明文只有服务器那边有）
     */
    async importNote(noteId: string) {
      const r = await run({ action: 'import', note_id: noteId }, vaultOkResponse);
      if (r.ok && state.listed) set({ listed: false });
      return r;
    },
    /**
     * 移出隐私记：先等后台队列把这一条发完（没发完就移，服务器上是旧的那一份）；移出在路上时这一条先不发（H5：移出后再 save 会在隐私记里重建它），
     * 成了从仓库、队列拿掉
     */
    exportNote: async (noteId: string): Promise<VaultResult<unknown>> => {
      if (!(await queue.flush(noteId))) return { ok: false, code: 'try_later' };
      queue.hold(noteId);
      try {
        const r = await run({ action: 'export', note_id: noteId }, vaultOkResponse);
        if (r.ok) {
          queue.forget([noteId]);
          forgetNotes([noteId]);
        }
        return r;
      } finally {
        queue.release(noteId);
      }
    },
    /**
     * 图片：拿字节做成 blob URL（只在内存、上锁时撤销，D3）；同一张同时只取一次，取到了缓存，没取到（失败、半路上锁）不缓存（M6）。
     * 同时最多 IMG_SLOTS 张；限流、服务忙、断网退避再取（QUEUE_BACKOFF），还不行这一张先不显示
     */
    image(imageId: string, part: 'full' | 'thumb'): Promise<string | null> {
      const key = `${imageId}:${part}`;
      const have = blobs.get(key);
      if (have) return Promise.resolve(have);
      const going = pendingImg.get(key);
      if (going) return going;
      if (!token) return Promise.resolve(null);
      const e = epoch;
      const p = (async () => {
        let r = await imgSlot(() => withImageToken((tok) => d.api.imageGet(imageId, part, tok)));
        for (const ms of QUEUE_BACKOFF) {
          if (r.ok || dropped(r) || vaultErrorAction(r.code).kind !== 'retry') break;
          rlog(`vault image ${part} wait ${r.code}`);
          await sleep(ms);
          if (epoch !== e) return null;
          r = await imgSlot(() => withImageToken((tok) => d.api.imageGet(imageId, part, tok)));
        }
        if (!r.ok) {
          // 只有“密码在别处改了”“设备被移除”要落（上锁）；没找到、服务忙只是这张图不显示，不改界面状态
          const kind = dropped(r) ? null : vaultErrorAction(r.code).kind;
          if (kind) rlog(`vault image ${part} fail ${r.code}`);
          if (kind === 'relock' || kind === 'revoked') onFail(r);
          return null;
        }
        // 取图期间上过锁：字节丢掉，不造地址（L2：上锁时已经撤过一遍，这里再造的就留在内存里了）
        if (epoch !== e) return null;
        const url = createUrl(r.value);
        blobs.set(key, url);
        return url;
      })();
      pendingImg.set(key, p);
      void p.then(() => {
        if (pendingImg.get(key) === p) pendingImg.delete(key);
      });
      return p;
    },
    /**
     * 文档附件（vault-file）：令牌过期先 renew 再试一次；“密码在别处改了”“设备被移除”要落（上锁），别的失败原样交回附件区出提示。
     * 明文字节不进这里的缓存：附件区自己放内存，卸下就丢
     */
    file: {
      list: (noteId: string) => fileOp((tok) => d.api.fileCall({ action: 'list', note_id: noteId }, tok, vaultFileListResponse)),
      upload(meta: VaultFileMeta, file: Blob, thumb: Blob | null) {
        return fileOp((tok): Promise<VaultResult<z.infer<typeof vaultFileUploadResponse>>> => {
          const fd = new FormData();
          fd.set('meta', JSON.stringify(meta));
          fd.set('file', file, 'file');
          if (thumb) fd.set('thumb', thumb, 'thumb.webp');
          return d.api.fileUpload(fd, tok).then((r) => {
            if (!r.ok) return r;
            const p = vaultFileUploadResponse.safeParse(r.value);
            return p.success ? { ok: true as const, value: p.data } : ({ ok: false, code: 'unknown' } as VaultFail);
          });
        });
      },
      get: (id: string, part: 'full' | 'thumb') => fileOp((tok) => d.api.fileGet(id, part, tok)),
      remove: (id: string) => fileOp((tok) => d.api.fileCall({ action: 'remove', id }, tok, vaultFileOkResponse)),
      restore: (id: string) => fileOp((tok) => d.api.fileCall({ action: 'restore', id }, tok, vaultFileOkResponse)),
      // 发之前就记 msLive：请求在飞时上锁（回 STALE），服务器可能已经放了临时明文副本，上锁时也要发 end（多发一次无害）。
      // 回来后再记一次：在飞时预览已经关了（end 先发了、msLive 落回 false），服务器随后才放的副本，调用方回来再 end 一次时要真发出去
      async msPreview(id: string) {
        msLive = true;
        const r = await fileOp((tok) => d.api.fileCall({ action: 'ms_preview', id }, tok, vaultFilePreviewResponse));
        // 上锁作废的（vault_locked）不再记：上锁时已经发过 end、令牌也没了
        if (r.ok || r.code !== 'vault_locked') msLive = true;
        return r;
      },
      msPreviewEnd(): void {
        if (msLive) endPreview('close');
      },
    },
    /** 已经在图片表里的地址（本机刚插的、取过的）；没有回 null，不去取 */
    peekImage: (imageId: string, part: 'full' | 'thumb'): string | null => blobs.get(`${imageId}:${part}`) ?? null,
    blobCount: (): number => blobs.size,
    /** 已解锁、或令牌过期等解锁时记下这个原因的离开时刻（同一个原因只记第一次） */
    hide(at: number = now(), why: LeaveWhy = 'app'): void {
      if (why === 'page') onPage = false;
      if (live() && !away.has(why)) away.set(why, at);
      arm();
    },
    /** 回来：这个原因离开满自动上锁时长就上锁、丢掉后台队列（审查第 2 条）；再看别的原因（check）。回 true 表示锁上了 */
    show(at: number = now(), why: LeaveWhy = 'app'): boolean {
      if (why === 'page') onPage = true;
      const h = away.get(why);
      away.delete(why);
      if (live() && h !== undefined && at - h >= minMs(autoMin)) {
        autolock(why);
        return true;
      }
      return check(at);
    },
    check,
    /** 设置里的自动上锁分钟数变了 */
    setAutolock(min: number): void {
      autoMin = min;
      arm();
    },
  };
}
