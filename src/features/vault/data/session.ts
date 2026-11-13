// 隐私记会话（B5 FA-1；架构 5.5、0.27 第 5 点、0.29 续第 87、94、127 条；S6；TC-B5-10、11、44、47）
// • 令牌、明文（notes）、图片的 blob URL 只在这个对象的内存里；令牌另抄一份到 core/vault-token.ts（导出要带），同样只在内存
// • lock()：清明文、令牌、撤销全部 blob URL（TC-B5-11：上锁后组件树、DOM 里不留明文；D3：撤销后的地址再用就失效）
// • run(req)：带令牌调 vault；成功换上新令牌（每次续期 600 秒）。
//   - vault_locked → 上锁、置 waiting（界面弹解锁），等解锁成功后**自动重试一次**原请求；再失败就停（TC-B5-47 ①）；取消解锁回失败
//   - vault_relock → 上锁、relocked = true（提示“密码已在别的设备修改”、不显示 Face ID，TC-B5-47 ②）
//   - session_revoked → 上锁，交给同步引擎退出（D20：和 B1 同一条路）
// • 离开、回来（S6）：hide(now) 记下离开时刻；show(now, min) 离开满 min 分钟就上锁（59 秒不锁、61 秒锁，TC-B5-10），否则什么也不动。
//   盖遮罩、去遮罩由 hooks/useVault.ts 的 watchLeave 同步做，这里只管锁不锁
// • 不碰 core/cache、outbox、log（A18）
import { z } from 'zod';
import {
  vaultCredentialsResponse, vaultListResponse, vaultOkResponse, vaultPurgeResponse, vaultStatusResponse, vaultTokenResponse,
  webauthnOptionsResponse, type VaultImageAdd, type VaultNote, type VaultRequest,
} from '../../../../shared/schema/vault.ts';
import { setVaultToken } from '../../../core/vault-token.ts';
import type { VaultApi, VaultFail, VaultResult } from './vault-api.ts';
import type { VaultCode } from './vault-errors.ts';

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
  addImages?: readonly { full: Blob; thumb: Blob | null; width: number | null; height: number | null }[];
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
  let hiddenAt: number | null = null;
  /** 每上锁一次加 1：半路上锁的取图结果据此丢掉 */
  let epoch = 0;
  const blobs = new Map<string, string>();
  const pendingImg = new Map<string, Promise<string | null>>();
  let waiters: ((ok: boolean) => void)[] = [];
  const listeners = new Set<() => void>();

  const set = (patch: Partial<VaultState>): void => {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  };

  const takeToken = (v: unknown): void => {
    const p = tokenShape.safeParse(v);
    if (!p.success) return;
    token = p.data.vault_token;
    onToken(token, p.data.expires_at);
  };

  function revokeAll(): void {
    for (const url of blobs.values()) revokeUrl(url);
    blobs.clear();
    pendingImg.clear();
  }

  /** 上锁：清明文、令牌、blob URL；同步完成（Ctrl+L、自动上锁、relock 都走这里） */
  function lock(patch: Partial<VaultState> = {}): void {
    token = null;
    epoch += 1;
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

  function onFail(f: VaultFail): void {
    if (f.code === 'vault_relock') {
      release(false);
      lock({ relocked: true, waiting: false, lastError: f.code });
    } else if (f.code === 'session_revoked' || f.code === 'signed_out') {
      release(false);
      lock({ waiting: false, lastError: f.code });
    } else {
      set({ lastError: f.code });
    }
  }

  /** 带令牌调一次（不处理 vault_locked） */
  async function once<S extends z.ZodType>(req: VaultRequest, schema: S): Promise<VaultResult<z.infer<S>>> {
    const r = await d.api.call(req, token, schema);
    if (r.ok) takeToken(r.value);
    return r;
  }

  /** 要令牌的请求：vault_locked 时等解锁、自动重试一次 */
  async function run<S extends z.ZodType>(req: VaultRequest, schema: S): Promise<VaultResult<z.infer<S>>> {
    const first = await once(req, schema);
    if (first.ok || first.code !== 'vault_locked') {
      if (!first.ok) onFail(first);
      return first;
    }
    lock({ waiting: true, lastError: 'vault_locked' });
    const unlocked = await new Promise<boolean>((resolve) => waiters.push(resolve));
    if (!unlocked) return first;
    const second = await once(req, schema);
    if (!second.ok) {
      if (second.code === 'vault_locked') lock({ lastError: second.code });
      else onFail(second);
    }
    return second;
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

  async function afterUnlock(r: VaultResult<z.infer<typeof vaultTokenResponse>>): Promise<VaultResult<true>> {
    if (!r.ok) {
      if (r.code === 'pin_wrong') set({ left: r.left ?? null, lastError: r.code });
      else if (r.code === 'pin_locked') set({ lockedUntil: now() + (r.retryAfterS ?? 60) * 1000, left: 0, lastError: r.code });
      else onFail(r);
      return r;
    }
    takeToken(r.value);
    const st = state.status ? { ...state.status, set: true } : { set: true, lockedUntil: null, lastResetAt: null, webauthn: 0 };
    set({ phase: 'unlocked', status: st, relocked: false, waiting: false, left: null, lockedUntil: null, lastError: null });
    const listed = await list();
    release(true);
    return listed.ok ? { ok: true, value: true } : listed;
  }

  async function list(): Promise<VaultResult<true>> {
    const r = await once({ action: 'list' }, vaultListResponse);
    if (!r.ok) {
      if (r.code === 'vault_locked') lock({ lastError: r.code });
      else onFail(r);
      return r;
    }
    set({ notes: r.value.notes });
    return { ok: true, value: true };
  }

  async function uploadImages(noteId: string, imgs: NonNullable<SaveInput['addImages']>): Promise<VaultResult<VaultImageAdd[]>> {
    const out: VaultImageAdd[] = [];
    for (const img of imgs) {
      const id = newId();
      for (const [part, blob] of [['full', img.full], ['thumb', img.thumb]] as const) {
        if (!blob) continue;
        let r = token ? await d.api.imageUpload({ note_id: noteId, image_id: id, part }, blob, token) : ({ ok: false, code: 'vault_locked' } as VaultFail);
        if (!r.ok && r.code === 'vault_locked') {
          // vault-image 只验不续期：先用一次普通请求换新令牌（或等解锁）再传
          const k = await run({ action: 'list_credentials' }, vaultCredentialsResponse);
          if (!k.ok || !token) return k.ok ? { ok: false, code: 'vault_locked' } : k;
          r = await d.api.imageUpload({ note_id: noteId, image_id: id, part }, blob, token);
        }
        if (!r.ok) {
          onFail(r);
          return r;
        }
      }
      out.push({ id, bytes: img.full.size, width: img.width, height: img.height, has_thumb: img.thumb !== null });
    }
    return { ok: true, value: out };
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
      lock({ waiting: false });
    },
    /** 取消等待中的解锁：原请求回失败 */
    cancelWait(): void {
      release(false);
      set({ waiting: false });
    },
    async setup(pin: string): Promise<VaultResult<true>> {
      const r = await d.api.call({ action: 'setup', pin }, null, vaultTokenResponse);
      return afterUnlock(r);
    },
    async unlock(pin: string): Promise<VaultResult<true>> {
      return afterUnlock(await d.api.call({ action: 'unlock', pin }, null, vaultTokenResponse));
    },
    async reset(newPin: string): Promise<VaultResult<true>> {
      const r = await afterUnlock(await d.api.call({ action: 'reset', new_pin: newPin }, null, vaultTokenResponse));
      if (r.ok) set({ status: state.status ? { ...state.status, lastResetAt: now(), webauthn: 0 } : null });
      return r;
    },
    async webauthnOptions(purpose: 'register' | 'unlock') {
      return d.api.call({ action: 'webauthn_options', purpose }, null, webauthnOptionsResponse);
    },
    async unlockWebauthn(assertion: { id: string; client_data_json: string; authenticator_data: string; signature: string }) {
      return afterUnlock(await d.api.call({ action: 'unlock_webauthn', assertion }, null, vaultTokenResponse));
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
    async changePin(oldPin: string, newPin: string) {
      const r = await run({ action: 'change_pin', old_pin: oldPin, new_pin: newPin }, vaultTokenResponse);
      if (!r.ok && r.code === 'pin_wrong') set({ left: r.left ?? null });
      return r;
    },
    list,
    async save(input: SaveInput): Promise<VaultResult<string>> {
      const id = input.id ?? newId();
      const old = state.notes?.find((n) => n.id === id);
      let add: VaultImageAdd[] = [];
      if (input.addImages?.length) {
        const up = await uploadImages(id, input.addImages);
        if (!up.ok) return up;
        add = up.value;
      }
      const t = now();
      const r = await run(
        {
          action: 'save', id, title: input.title, body: input.body, category_id: old?.category_id ?? null,
          created_at: old?.created_at ?? input.createdAt ?? t, updated_at: t,
          ...(add.length ? { add_images: add } : {}),
          ...(input.removeImages?.length ? { remove_images: [...input.removeImages] } : {}),
        },
        vaultOkResponse,
      );
      if (!r.ok) return r;
      const l = await list();
      return l.ok ? { ok: true, value: id } : l;
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
    /** 图片：拿字节做成 blob URL（只在内存、上锁时撤销，D3）；同一张只取一次 */
    image(imageId: string, part: 'full' | 'thumb'): Promise<string | null> {
      const key = `${imageId}:${part}`;
      const have = blobs.get(key);
      if (have) return Promise.resolve(have);
      const going = pendingImg.get(key);
      if (going) return going;
      const at = epoch;
      const p = (async () => {
        if (!token) return null;
        const r = await d.api.imageGet(imageId, part, token);
        if (!r.ok) {
          if (r.code === 'vault_relock' || r.code === 'session_revoked') onFail(r);
          return null;
        }
        if (!token || epoch !== at) return null;   // 半路上锁了：不再造地址
        const url = createUrl(r.value);
        blobs.set(key, url);
        pendingImg.delete(key);
        return url;
      })();
      pendingImg.set(key, p);
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
        lock({ waiting: false });
        return true;
      }
      return false;
    },
  };
}
