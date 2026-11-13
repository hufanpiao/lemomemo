// 隐私记会话（B5 FA-1；架构 5.5、0.27 第 5 点、0.29 续第 87、94、127 条；S6；TC-B5-10、11、44、47）
// • 令牌、明文（notes）、图片的 blob URL 只在这个对象的内存里；令牌另抄一份到 core/vault-token.ts（导出要带），同样只在内存
// • lock()：清明文、令牌、撤销全部 blob URL（TC-B5-11：上锁后组件树、DOM 里不留明文；D3：撤销后的地址再用就失效）
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
// • 离开、回来（S6）：hide(now) 记下离开时刻；show(now, min) 离开满 min 分钟就上锁（59 秒不锁、61 秒锁，TC-B5-10），否则什么也不动。
//   盖遮罩、去遮罩由 hooks/useVault.ts 的 watchLeave 同步做，这里只管锁不锁
// • 续期（M2）：编辑页有输入时调 touch()，拿到令牌满 5 分钟就发一次 {renew}（按本机拿到令牌的时刻算，不受两边时钟差影响）；
//   vault-image 只验不续，令牌过期（vault_locked）时先 {renew}（锁着就等解锁）再试一次；取图失败不缓存（M6）
// • 不碰 core/cache、outbox、log（A18）
import { z } from 'zod';
import {
  vaultCredentialsResponse, vaultListResponse, vaultOkResponse, vaultPurgeResponse, vaultStatusResponse, vaultTokenResponse,
  webauthnOptionsResponse, type VaultImageAdd, type VaultNote, type VaultRequest,
} from '../../../../shared/schema/vault.ts';
import { setVaultToken } from '../../../core/vault-token.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { VaultApi, VaultFail, VaultResult } from './vault-api.ts';
import { unhandled, vaultErrorAction, type VaultCode } from './vault-errors.ts';

export type VaultPhase = 'loading' | 'offline' | 'unset' | 'locked' | 'unlocked' | 'error';

export interface VaultStatus {
  set: boolean;
  lockedUntil: number | null;
  lastResetAt: number | null;
  webauthn: number;
}

export interface VaultState {
  phase: VaultPhase;
  status: VaultStatus | null;
  /** 明文，只在已解锁时有 */
  notes: readonly VaultNote[] | null;
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
  phase: 'loading', status: null, notes: null, relocked: false, waiting: false, left: null, lockedUntil: null, lastError: null,
};

const tokenShape = z.object({ vault_token: z.string(), expires_at: z.number() });
/** 半路上锁丢掉的结果（按引用比较：run 见到它不弹解锁、不重试，调用方不再 onFail） */
const STALE: VaultFail = { ok: false, code: 'vault_locked' };
/** 在飞时碰上令牌过期的上锁、等解锁时用户取消了：回失败（调用方照常提示“已锁上”），run 不再弹解锁 */
const CANCELLED: VaultFail = { ok: false, code: 'vault_locked' };
/** 拿到令牌满这么久、编辑页又有输入就续一次（令牌 10 分钟） */
export const RENEW_AFTER_MS = 5 * 60_000;

export interface VaultSessionDeps {
  api: VaultApi;
  now?: () => number;
  /** 测试用：不写 core/vault-token */
  onToken?: (token: string | null, expiresAt: number) => void;
  createUrl?: (b: Blob) => string;
  revokeUrl?: (url: string) => void;
  newId?: () => string;
}

export interface SaveInput {
  id: string | null;
  title: string;
  body: string;
  createdAt?: number;
  /** id：编辑页给每张待传的图定好的 id（重试时复用同一个，同一个键再传算成功，不留多份对象） */
  addImages?: readonly { id: string; full: Blob; thumb: Blob | null; width: number | null; height: number | null }[];
  removeImages?: readonly string[];
}

export type VaultSession = ReturnType<typeof createVaultSession>;

export function createVaultSession(d: VaultSessionDeps) {
  const now = d.now ?? (() => Date.now());
  const onToken = d.onToken ?? setVaultToken;
  const createUrl = d.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = d.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));
  const newId = d.newId ?? (() => crypto.randomUUID());

  let state: VaultState = INIT;
  let token: string | null = null;
  /** 本机拿到当前令牌的时刻（touch 据此判断该不该续） */
  let tokenAt = 0;
  let renewing = false;
  let hiddenAt: number | null = null;
  /** 每上锁一次加 1（两种上锁都加）：读请求据此丢掉 */
  let epoch = 0;
  /** 只在作废在飞请求的上锁（hard）时加 1：写请求据此丢掉 */
  let hardEpoch = 0;
  const blobs = new Map<string, string>();
  const pendingImg = new Map<string, Promise<string | null>>();
  let waiters: ((ok: boolean) => void)[] = [];
  const listeners = new Set<() => void>();

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

  /** 上锁：清明文、令牌、blob URL；同步完成。hard：作废在飞请求（主动上锁、超时、relock、revoked）；令牌过期的上锁不作废写请求 */
  function lock(patch: Partial<VaultState>, hard: boolean): void {
    token = null;
    epoch += 1;
    if (hard) hardEpoch += 1;
    onToken(null, 0);
    revokeAll();
    hiddenAt = null;
    const set_ = state.status?.set ?? true;
    set({ phase: set_ ? 'locked' : 'unset', notes: null, ...patch });
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
    if (first === STALE || first === CANCELLED) return first;
    if (first.ok || first.code !== 'vault_locked') {
      if (!first.ok) onFail(first);
      return first;
    }
    lock({ waiting: true, lastError: 'vault_locked' }, false);
    const unlocked = await waitUnlock();
    if (!unlocked) return first;
    const second = await once(req, schema);
    if (!second.ok && second !== STALE && second !== CANCELLED) onFail(second);
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
    if (r === STALE || r === CANCELLED || r.ok || r.code !== 'vault_locked') return r;
    const k = await renew();
    if (!k.ok) return k;
    return token ? (await guarded(go, write)).r : STALE;
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
    const status: VaultStatus = { set: r.value.set, lockedUntil: r.value.locked_until, lastResetAt: r.value.last_reset_at, webauthn: r.value.webauthn };
    const phase: VaultPhase = !status.set ? 'unset' : state.phase === 'unlocked' && token ? 'unlocked' : 'locked';
    set({ status, phase, lockedUntil: status.lockedUntil && status.lockedUntil > now() ? status.lockedUntil : null });
    return { ok: true, value: status };
  }

  /** 解锁类请求（setup、unlock、reset、Face ID）：半路上锁就丢掉签来的令牌，不进已解锁 */
  async function afterUnlock(send: () => Promise<VaultResult<z.infer<typeof vaultTokenResponse>>>): Promise<VaultResult<true>> {
    const { r } = await guarded(send, false);
    if (r === STALE) return r;
    if (!r.ok) {
      onFail(r);
      return r;
    }
    takeToken(r.value);
    const st = state.status ? { ...state.status, set: true } : { set: true, lockedUntil: null, lastResetAt: null, webauthn: 0 };
    set({ phase: 'unlocked', status: st, relocked: false, waiting: false, left: null, lockedUntil: null, lastError: null });
    const listed = await list();
    release(true);
    return listed.ok ? { ok: true, value: true } : listed;
  }

  /** 拉明文列表；锁着（没令牌）就不拉：写请求在锁着时才回来成功的，解锁时 afterUnlock 会再拉 */
  async function list(): Promise<VaultResult<true>> {
    if (!token) return { ok: true, value: true };
    const r = await once({ action: 'list' }, vaultListResponse, false);
    if (!r.ok) {
      if (r !== STALE) onFail(r);
      return r;
    }
    set({ notes: r.value.notes });
    return { ok: true, value: true };
  }

  async function uploadImages(noteId: string, imgs: NonNullable<SaveInput['addImages']>): Promise<VaultResult<true>> {
    for (const img of imgs) {
      for (const [part, blob] of [['full', img.full], ['thumb', img.thumb]] as const) {
        if (!blob) continue;
        const r = await withImageToken((tok) => d.api.imageUpload({ note_id: noteId, image_id: img.id, part }, blob, tok), true);
        if (!r.ok) {
          if (r !== STALE && r !== CANCELLED) onFail(r);
          return r;
        }
      }
    }
    return { ok: true, value: true };
  }

  /**
   * 保存。带图（11-14 整块评审第 3 条）：先 save 带 add_images 预登记图片行（这条没有就同时建出来），再经 vault-image 传原图和缩略图——
   * vault-image 只收已登记的 image_id、原图字节数要等于登记的 bytes。传图失败时这条和图片行都已建好，
   * 编辑页用同一个 id、同一批图片 id 重试：服务器把字节数一样的重发当成已登记，再传一次对象
   */
  async function save(input: SaveInput): Promise<VaultResult<string>> {
    const id = input.id ?? newId();
    const old = state.notes?.find((n) => n.id === id);
    const t = now();
    const add: VaultImageAdd[] = (input.addImages ?? []).map((img) => ({ id: img.id, bytes: img.full.size, width: img.width, height: img.height, has_thumb: img.thumb !== null }));
    const r = await run(
      {
        action: 'save' as const, id, title: input.title, body: input.body, category_id: old?.category_id ?? null, created_at: old?.created_at ?? input.createdAt ?? t, updated_at: t,
        ...(add.length ? { add_images: add } : {}),
        ...(input.removeImages?.length ? { remove_images: [...input.removeImages] } : {}),
      },
      vaultOkResponse,
    );
    if (!r.ok) return r;
    if (input.addImages?.length) {
      const up = await uploadImages(id, input.addImages);
      if (!up.ok) return up;
    }
    const l = await list();
    return l.ok ? { ok: true, value: id } : l;
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
    /**
     * 令牌过期上锁、等解锁时编辑页被换下（第 22 条：没存的草稿不丢）：草稿只在这个闭包里（不进 DOM），解锁后保存一次；
     * 用户取消解锁、或被作废在飞请求的上锁（主动上锁、超时、relock、revoked）打断就丢掉
     */
    async saveWhenUnlocked(input: SaveInput): Promise<VaultResult<string>> {
      const h = hardEpoch;
      if (!(await waitUnlock()) || hardEpoch !== h) return CANCELLED;
      rlog('vault draft saved-after-unlock');
      return save(input);
    },
    async remove(id: string) {
      const r = await run({ action: 'delete', id }, vaultOkResponse);
      if (r.ok) await list();
      return r;
    },
    async undelete(id: string) {
      const r = await run({ action: 'undelete', id }, vaultOkResponse);
      if (r.ok) await list();
      return r;
    },
    async purge(items: readonly string[]) {
      const r = await run({ action: 'purge', items: [...items] }, vaultPurgeResponse);
      if (r.ok) await list();
      return r;
    },
    /** 普通随手记移进隐私记（S7）：要令牌，锁着时等解锁、重试一次 */
    async importNote(noteId: string) {
      const r = await run({ action: 'import', note_id: noteId }, vaultOkResponse);
      if (r.ok && state.notes) await list();
      return r;
    },
    exportNote: async (noteId: string) => {
      const r = await run({ action: 'export', note_id: noteId }, vaultOkResponse);
      if (r.ok) await list();
      return r;
    },
    /** 图片：拿字节做成 blob URL（只在内存、上锁时撤销，D3）；同一张同时只取一次，取到了缓存，没取到（失败、半路上锁）不缓存（M6） */
    image(imageId: string, part: 'full' | 'thumb'): Promise<string | null> {
      const key = `${imageId}:${part}`;
      const have = blobs.get(key);
      if (have) return Promise.resolve(have);
      const going = pendingImg.get(key);
      if (going) return going;
      if (!token) return Promise.resolve(null);
      const p = (async () => {
        const r = await withImageToken((tok) => d.api.imageGet(imageId, part, tok), false);
        if (!r.ok) {
          // 只有“密码在别处改了”“设备被移除”要落（上锁）；没找到、服务忙只是这张图不显示，不改界面状态
          const kind = r === STALE ? null : vaultErrorAction(r.code).kind;
          if (r !== STALE) rlog(`vault image ${part} fail ${r.code}`);
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
    blobCount: (): number => blobs.size,
    hide(at: number = now()): void {
      if (state.phase === 'unlocked' && hiddenAt === null) hiddenAt = at;
    },
    /** 回来：离开满 min 分钟就上锁；回 true 表示锁上了 */
    show(at: number = now(), min = 1): boolean {
      const h = hiddenAt;
      hiddenAt = null;
      if (h === null || state.phase !== 'unlocked') return false;
      if (at - h >= Math.max(1, min) * 60_000) {
        release(false);
        lock({ waiting: false }, true);
        return true;
      }
      return false;
    },
  };
}
