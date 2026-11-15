// 隐私记会话（B5 FA-1；架构 5.5、0.27 第 5 点、0.29 续第 87、94、127 条；S6；TC-B5-10、11、44、47）
// • 令牌、明文、图片的 blob URL 只在这个对象的内存里；令牌另抄一份到 core/vault-token.ts（导出要带），同样只在内存
// • 明文放在会话持有的内存仓库 store（./vault-store.ts）：解锁时 list 一次全量放进去，之后界面读写都只碰它；
//   改动交给会话持有的发送队列 queue（./vault-queue.ts）在后台串行发（B5 隐私记重写 11-15，负责人“读取跟写入速度太慢了”）。
//   作废在飞请求的上锁丢掉整个队列（个数记进仓库，解锁后报一句）；令牌过期的上锁队列不动，解锁拉完列表把本机还没发完的盖回仓库
// • lock()：清仓库里的明文、令牌、撤销全部 blob URL（TC-B5-11：上锁后组件树、DOM 里不留明文；D3：撤销后的地址再用就失效）
// • 半路上锁（11-14 独立评审 S1；11-14 整块评审第 8 条）：上锁分两种——
//   - 作废在飞请求的上锁（hard）：用户主动上锁、离开超时、vault_relock、session_revoked。回来的结果整个丢掉（STALE）：
//     不收令牌、不写明文、不造 blob 地址、不弹解锁、不重试
//   - 令牌过期的上锁（soft，vault_locked：等解锁重试那种）：同时在飞的写请求（保存、传图、移进移出……）不丢——
//     回来成功就照常算成功（只是不收令牌，锁着不留令牌），失败就进 waiters，解锁后重发一次；list、取图这类读请求照样丢（锁着不写明文）
// • 运行日志（第 14 条）：状态迁移（phase、waiting、relock）、错误码和 left、STALE 丢弃、续期结果、取图失败经 rlog 记；
//   不记标题、正文、密码、令牌、图片 id
// • 失败怎么落只按 data/vault-errors.ts 的落法（kind）分支（onFail 里穷尽 switch），不另写一套按码判断
// • run(req)：带令牌调 vault；成功换上新令牌（每次续期 600 秒）。
//   - vault_locked → 上锁、置 waiting（界面弹解锁），等解锁成功后**自动重试一次**原请求；再失败就停（TC-B5-47 ①）；取消解锁回失败
//   - vault_relock → 上锁、relocked = true（提示“密码已在别的设备修改”、不显示 Face ID，TC-B5-47 ②）
//   - session_revoked → 上锁，交给同步引擎退出（D20：和 B1 同一条路）
// • 离开、回来（S6）：离开时刻按原因分开记（'app'：离开 App；'page'：离开隐私记页，负责人 11-15“离开隐私记页 1 分钟不自动上锁”）。
//   hide(now, why) 记下；show(now, min, why) 这个原因离开满 min 分钟就上锁（59 秒不锁、61 秒锁，TC-B5-10），再看别的原因满没满（check）。
//   check(now, min)：任何一个原因离开满时长就上锁；入口行、查找行、移进隐私记读状态前先调一次（计时器被浏览器压后时也对）。
//   有离开原因时自己挂一个计时器到点调 check（App 在前台、只是离开了隐私记页，到点就锁，不等回来）。
//   隐私记页没挂着时解锁的（移进隐私记弹的解锁卡）：解锁那一刻就记 'page'。默认原因是 'app'，原来的调用不用改。
//   令牌过期、等解锁（waiting）时也算：满时长就作废等着的请求、丢掉后台队列（审查第 2 条：原来只认已解锁，没发完的明文一直留在内存）。
//   盖遮罩、去遮罩由 hooks/useVault.ts 的 watchLeave 同步做；页面挂上、卸下由 useVaultPresence 报；这里只管锁不锁
// • 取图（image）：同时最多 2 张（IMG_SLOTS），限流、服务忙、断网（kind retry）退避 2 秒、5 秒、15 秒再取；本机刚插的图 seedImage 直接放进图片表，不再取
// • 续期（M2）：编辑页有输入时调 touch()，拿到令牌满 5 分钟就发一次 {renew}（按本机拿到令牌的时刻算，不受两边时钟差影响）；
//   vault-image 只验不续，令牌过期（vault_locked）时先 {renew}（锁着就等解锁）再试一次；取图失败不缓存（M6）
// • 文档附件（B4b-1，vault-file）：同 vault-image 只验不续（withImageToken）；成功放了微软预览的临时明文副本时记下，上锁时先发 ms_preview_end（keepalive）。
//   审查第 4 条：服务器的 ms_preview_end 只验 JWT（令牌过期也删得掉），令牌有才带；没发成（断网、JWT 过期）记下，下次解锁后补发一次（endOwed）
// • 不碰 core/cache、outbox、log（A18）
import { z } from 'zod';
import {
  vaultCredentialsResponse, vaultListResponse, vaultOkResponse, vaultPurgeResponse, vaultStatusResponse, vaultTokenResponse,
  webauthnOptionsResponse, type VaultRequest,
} from '../../../../shared/schema/vault.ts';
import { vaultFileListResponse, vaultFileOkResponse, vaultFilePreviewResponse, vaultFileUploadResponse, type VaultFileMeta } from '../../../../shared/schema/vault-file.ts';
import { setVaultToken } from '../../../core/vault-token.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { VaultApi, VaultFail, VaultResult } from './vault-api.ts';
import { unhandled, vaultErrorAction, type VaultCode } from './vault-errors.ts';
import { createVaultQueue, limiter, QUEUE_BACKOFF, type SaveReq } from './vault-queue.ts';
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
/** 半路上锁丢掉的结果（按引用比较：run 见到它不弹解锁、不重试，调用方不再 onFail） */
const STALE: VaultFail = { ok: false, code: 'vault_locked' };
/** 在飞时碰上令牌过期的上锁、等解锁时用户取消了：回失败（调用方照常提示“已锁上”），run 不再弹解锁 */
const CANCELLED: VaultFail = { ok: false, code: 'vault_locked' };
/** 半路丢掉（STALE）或取消（CANCELLED）的结果：调用方不再 onFail、不弹解锁（审查第 13 条：原来 7 处各写一遍） */
const dropped = (r: VaultResult<unknown>): boolean => r === STALE || r === CANCELLED;
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

/** 发一次 save：分类、时间不给就是没分类、现在 */
export type SaveInput = Pick<SaveReq, 'id' | 'title' | 'body'> & Partial<SaveReq>;

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
  /** 每上锁一次加 1（两种上锁都加）：读请求据此丢掉 */
  let epoch = 0;
  /** 只在作废在飞请求的上锁（hard）时加 1：写请求据此丢掉 */
  let hardEpoch = 0;
  const blobs = new Map<string, string>();
  const pendingImg = new Map<string, Promise<string | null>>();
  let waiters: ((ok: boolean) => void)[] = [];
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
      const r = await withImageToken((tok) => d.api.imageUpload({ note_id: noteId, image_id: imageId, part }, blob, tok), true);
      if (!r.ok && !dropped(r)) {
        const kind = vaultErrorAction(r.code).kind;
        if (kind === 'relock' || kind === 'revoked') onFail(r);
      }
      return r;
    },
    seed: (imageId, full, thumb) => seedImage(imageId, full, thumb),
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

  /** 上锁：清明文、令牌、blob URL；同步完成。hard：作废在飞请求（主动上锁、超时、relock、revoked）；令牌过期的上锁不作废写请求 */
  function lock(patch: Partial<VaultState>, hard: boolean): void {
    if (msLive) endPreview('lock');
    token = null;
    epoch += 1;
    if (hard) hardEpoch += 1;
    onToken(null, 0);
    revokeAll();
    store.clear();
    if (hard) queue.dropAll('lock');
    away.clear();
    arm();
    const set_ = state.status?.set ?? true;
    set({ phase: set_ ? 'locked' : 'unset', listed: false, ...patch });
  }

  function release(ok: boolean): void {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w(ok);
  }

  /** 失败怎么落：按 vault-errors.ts 的落法分支（vault_locked 的“等解锁、重试一次”在 run 里，走到这里的 unlock 是重试后仍锁、或 list 被拒） */
  function onFail(f: VaultFail): void {
    const kind = vaultErrorAction(f.code).kind;
    switch (kind) {
      case 'relock':
        release(false);
        lock({ relocked: true, waiting: false, lastError: f.code }, true);
        return;
      case 'revoked':
        release(false);
        lock({ waiting: false, lastError: f.code }, true);
        return;
      case 'unlock':
        lock({ lastError: f.code }, false);
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

  const waitUnlock = (): Promise<boolean> => new Promise<boolean>((resolve) => waiters.push(resolve));

  /**
   * 发出去、回来时还是同一段解锁期才算数（第 8 条）：
   * • 中间有过作废在飞请求的上锁 → STALE
   * • 中间只有令牌过期的上锁：读请求（write = false）→ STALE；写请求成功就回成功（标 late，调用方不收令牌），
   *   失败就等解锁、重发一次（send 每次现读令牌）；等的时候取消回 CANCELLED、作废回 STALE
   */
  async function guarded<T>(send: () => Promise<VaultResult<T>>, write: boolean): Promise<{ r: VaultResult<T>; late: boolean }> {
    const e = epoch;
    const h = hardEpoch;
    const r = await send();
    if (hardEpoch !== h) return drop(r, 'hard');
    if (epoch === e) return { r, late: false };
    if (!write) return drop(r, 'soft');
    if (r.ok) return { r, late: true };
    rlog(`vault inflight ${r.code} wait-unlock`);
    const ok = await waitUnlock();
    if (hardEpoch !== h) return drop(r, 'hard');
    if (!ok) return { r: CANCELLED, late: false };
    return guarded(send, write);
  }
  function drop<T>(r: VaultResult<T>, why: string): { r: VaultResult<T>; late: boolean } {
    rlog(`vault stale ${why} ${r.ok ? 'ok' : r.code}`);
    return { r: STALE, late: false };
  }

  /** 带令牌调一次（不处理 vault_locked）；成功收新令牌（在飞时碰上令牌过期的上锁、回来才成功的不收：锁着不留令牌） */
  async function once<S extends z.ZodType>(req: VaultRequest, schema: S, write = true): Promise<VaultResult<z.infer<S>>> {
    const { r, late } = await guarded(() => d.api.call(req, token, schema), write);
    if (r.ok && !late) takeToken(r.value);
    return r;
  }

  /** 要令牌的请求：vault_locked 时等解锁、自动重试一次 */
  async function run<S extends z.ZodType>(req: VaultRequest, schema: S): Promise<VaultResult<z.infer<S>>> {
    const first = await once(req, schema);
    if (dropped(first)) return first;
    if (first.ok || first.code !== 'vault_locked') {
      if (!first.ok) onFail(first);
      return first;
    }
    lock({ waiting: true, lastError: 'vault_locked' }, false);
    const unlocked = await waitUnlock();
    if (!unlocked) return first;
    const second = await once(req, schema);
    if (!second.ok && !dropped(second)) onFail(second);
    return second;
  }

  const renew = async () => {
    const r = await run({ action: 'renew' }, vaultTokenResponse);
    rlog(`vault renew ${r.ok ? 'ok' : r === STALE ? 'stale' : r.code}`);
    return r;
  };

  /**
   * vault-image 只验不续期：令牌过期（vault_locked）时先 renew（锁着就等解锁）再试一次。
   * 半路上锁回 STALE；别的失败原样回，由调用方决定落不落（renew 自己的失败 run 已经落过）
   */
  async function withImageToken<T>(send: (tok: string) => Promise<VaultResult<T>>, write: boolean): Promise<VaultResult<T>> {
    const go = (): Promise<VaultResult<T>> => (token ? send(token) : Promise.resolve({ ok: false, code: 'vault_locked' } as VaultFail));
    const { r } = await guarded(go, write);
    if (dropped(r) || r.ok || r.code !== 'vault_locked') return r;
    const k = await renew();
    if (!k.ok) return k;
    return token ? (await guarded(go, write)).r : STALE;
  }

  /** vault-file 的一次调用：只验不续（同 vault-image）；relock、revoked 一类要落 */
  async function fileOp<T>(send: (tok: string) => Promise<VaultResult<T>>, write: boolean): Promise<VaultResult<T>> {
    const r = await withImageToken(send, write);
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
  async function afterUnlock(send: () => Promise<VaultResult<z.infer<typeof vaultTokenResponse>>>): Promise<VaultResult<true>> {
    const { r } = await guarded(send, false);
    if (dropped(r)) return r as VaultFail;
    if (!r.ok) {
      onFail(r);
      return r;
    }
    takeToken(r.value);
    const st = state.status ? { ...state.status, set: true } : { set: true, lastResetAt: null, webauthn: 0 };
    set({ phase: 'unlocked', status: st, relocked: false, waiting: false, left: null, lockedUntil: null, lastError: null });
    if (endOwed) endPreview('resend');
    // 不在隐私记页上解锁的（移进隐私记弹的解锁卡）：这一刻起就算离开了隐私记页
    if (!onPage) away.set('page', now());
    arm();
    const listed = await list();
    release(true);
    return listed.ok ? { ok: true, value: true } : listed;
  }

  /** 拉明文列表；锁着（没令牌）就不拉：写请求在锁着时才回来成功的，解锁时 afterUnlock 会再拉 */
  async function list(): Promise<VaultResult<true>> {
    if (!token) return { ok: true, value: true };
    const r = await once({ action: 'list' }, vaultListResponse, false);
    if (!r.ok) {
      if (!dropped(r)) onFail(r);
      return r;
    }
    store.load(r.value.notes);
    set({ listed: true });
    queue.overlay();
    return { ok: true, value: true };
  }

  /** 已解锁，或令牌过期等解锁（waiting，后台队列里还有没发完的明文） */
  const live = (): boolean => state.phase === 'unlocked' || state.waiting;
  const minMs = (min: number): number => Math.max(1, min) * 60_000;

  /** 离开满时长：作废等着的请求、后台队列，硬上锁 */
  function autolock(why: LeaveWhy): void {
    rlog(`vault autolock why=${why}${state.waiting ? ` waiting n=${waiters.length}` : ''}`);
    release(false);
    lock({ waiting: false }, true);
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

  /** 任何一个原因离开满 min 分钟就上锁；回 true 表示锁上了 */
  function check(at: number = now(), min: number = autoMin): boolean {
    if (!live()) {
      away.clear();
      arm();
      return false;
    }
    for (const [why, t] of away) {
      if (at - t >= minMs(min)) {
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

  /**
   * 发一次 save（后台队列和测试用；带图时 add_images 只是预登记，图的字节由队列随后经 vault-image 传，11-14 整块评审第 3 条）。
   * 不再重拉列表：仓库里本来就是本机最新的那一份
   */
  async function save(input: SaveInput): Promise<VaultResult<string>> {
    const t = now();
    const r = await run({ action: 'save', category_id: null, created_at: t, updated_at: t, ...input }, vaultOkResponse);
    return r.ok ? { ok: true, value: input.id } : r;
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
    lock: (): void => {
      release(false);
      lock({ waiting: false }, true);
    },
    /** 取消等待中的解锁：原请求回失败 */
    cancelWait(): void {
      rlog(`vault wait cancel n=${waiters.length}`);
      release(false);
      set({ waiting: false });
    },
    setup: (pin: string): Promise<VaultResult<true>> => afterUnlock(() => d.api.call({ action: 'setup', pin }, null, vaultTokenResponse)),
    unlock: (pin: string): Promise<VaultResult<true>> => afterUnlock(() => d.api.call({ action: 'unlock', pin }, null, vaultTokenResponse)),
    async reset(newPin: string): Promise<VaultResult<true>> {
      const r = await afterUnlock(() => d.api.call({ action: 'reset', new_pin: newPin }, null, vaultTokenResponse));
      if (r.ok) set({ status: state.status ? { ...state.status, lastResetAt: now(), webauthn: 0 } : null });
      return r;
    },
    async webauthnOptions(purpose: 'register' | 'unlock') {
      return d.api.call({ action: 'webauthn_options', purpose }, null, webauthnOptionsResponse);
    },
    async unlockWebauthn(assertion: { id: string; client_data_json: string; authenticator_data: string; signature: string }) {
      return afterUnlock(() => d.api.call({ action: 'unlock_webauthn', assertion }, null, vaultTokenResponse));
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
    save,
    /** 会话持有的内存仓库、后台发送队列（界面经 hooks/vault-note-source.ts 读写） */
    store,
    queue,
    seedImage,
    /** 删除、撤销删除各发一次（后台队列发的也是这两个；不重拉列表） */
    remove: (id: string) => run({ action: 'delete', id }, vaultOkResponse),
    undelete: (id: string) => run({ action: 'undelete', id }, vaultOkResponse),
    /** 永久删除（要确认，不进后台队列）：成了从仓库拿掉 */
    async purge(items: readonly string[]) {
      const r = await run({ action: 'purge', items: [...items] }, vaultPurgeResponse);
      if (r.ok) store.forget(items);
      return r;
    },
    /** 普通随手记移进隐私记（S7）：要令牌，锁着时等解锁、重试一次；这一段解锁期拉过列表的，成了补拉一次（服务器那边才有这一条的明文） */
    async importNote(noteId: string) {
      const r = await run({ action: 'import', note_id: noteId }, vaultOkResponse);
      if (r.ok && state.listed) await list();
      return r;
    },
    /** 移出隐私记：先等后台队列把这一条发完（没发完就移，服务器上是旧的那一份），成了从仓库拿掉 */
    exportNote: async (noteId: string): Promise<VaultResult<unknown>> => {
      if (!(await queue.flush(noteId))) return { ok: false, code: 'try_later' };
      const r = await run({ action: 'export', note_id: noteId }, vaultOkResponse);
      if (r.ok) store.forget([noteId]);
      return r;
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
        let r = await imgSlot(() => withImageToken((tok) => d.api.imageGet(imageId, part, tok), false));
        for (const ms of QUEUE_BACKOFF) {
          if (r.ok || dropped(r) || vaultErrorAction(r.code).kind !== 'retry') break;
          rlog(`vault image ${part} wait ${r.code}`);
          await sleep(ms);
          if (epoch !== e) return null;
          r = await imgSlot(() => withImageToken((tok) => d.api.imageGet(imageId, part, tok), false));
        }
        if (!r.ok) {
          // 只有“密码在别处改了”“设备被移除”要落（上锁）；没找到、服务忙只是这张图不显示，不改界面状态
          const kind = dropped(r) ? null : vaultErrorAction(r.code).kind;
          if (kind) rlog(`vault image ${part} fail ${r.code}`);
          if (kind === 'relock' || kind === 'revoked') onFail(r);
          return null;
        }
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
      list: (noteId: string) => fileOp((tok) => d.api.fileCall({ action: 'list', note_id: noteId }, tok, vaultFileListResponse), false),
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
        }, true);
      },
      get: (id: string, part: 'full' | 'thumb') => fileOp((tok) => d.api.fileGet(id, part, tok), false),
      remove: (id: string) => fileOp((tok) => d.api.fileCall({ action: 'remove', id }, tok, vaultFileOkResponse), true),
      restore: (id: string) => fileOp((tok) => d.api.fileCall({ action: 'restore', id }, tok, vaultFileOkResponse), true),
      // 发之前就记 msLive：请求在飞时上锁（回 STALE），服务器可能已经放了临时明文副本，上锁时也要发 end（多发一次无害）。
      // 回来后再记一次：在飞时预览已经关了（end 先发了、msLive 落回 false），服务器随后才放的副本，调用方回来再 end 一次时要真发出去
      async msPreview(id: string) {
        msLive = true;
        const r = await fileOp((tok) => d.api.fileCall({ action: 'ms_preview', id }, tok, vaultFilePreviewResponse), true);
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
    /** 回来：这个原因离开满 min 分钟就上锁，等解锁的请求和后台队列一并作废（审查第 2 条）；再看别的原因（check）。回 true 表示锁上了 */
    show(at: number = now(), min = autoMin, why: LeaveWhy = 'app'): boolean {
      if (why === 'page') onPage = true;
      autoMin = min;
      const h = away.get(why);
      away.delete(why);
      if (live() && h !== undefined && at - h >= minMs(min)) {
        autolock(why);
        return true;
      }
      return check(at, min);
    },
    check,
    /** 设置里的自动上锁分钟数变了 */
    setAutolock(min: number): void {
      autoMin = min;
      arm();
    },
  };
}
