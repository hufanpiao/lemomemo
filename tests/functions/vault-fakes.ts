// vault、vault-image 测试共用的内存假库、假 R2 和依赖（照 account-fakes.ts 的写法）。
// • 假库按 0003、0006 的 check 约束和 RLS 写：隐私记不准留明文残留，vault-images 的图不准有 taken_at、ai_desc；只看得到本人的行；
//   tx 出错整个回滚（开头存一份快照，抛错就换回去）。
// • 钥匙都是测试专用的假值，用 btoa('TEST-ONLY-…') 现算（不写成像真钥匙的 base64 字面量）。
import { vaultImageKey, vaultRequest, lockSeconds, PIN_RE, VAULT_FAILS_PER_LEVEL, VAULT_IMAGE_MAX_BYTES,
  VAULT_RESET_OTP_MAX_AGE_S, WEBAUTHN_CHALLENGE_TTL_S, WEBAUTHN_RP_ID } from '../../shared/schema/vault.ts';
import type { VaultPushEvent } from '../../supabase/functions/_shared/push/payload.ts';
import { decodeKey32 } from '../../supabase/functions/_shared/vault-crypto.ts';
import {
  type CredRow, type Deps, type ImageRow, type NoteRow, type Obj, StoreDataError, type VaultReq, type VaultRow, type VaultTx,
} from '../../supabase/functions/vault/common.ts';
import { handle } from '../../supabase/functions/vault/core.ts';

export const A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const B = 'bbbbbbbb-0000-4000-8000-000000000002';
export const T0 = Date.parse('2026-11-13T03:00:00Z');
export const MASTER = decodeKey32(btoa('TEST-ONLY-fake-vault-key-32-byte'))!;
export const PEPPER = decodeKey32(btoa('TEST-ONLY-fake-pin-pepper-32-byt'))!;
export const SECRET = decodeKey32(btoa('TEST-ONLY-fake-token-secret-32-b'))!;
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 一个不验签名的 JWT（authenticate 由测试替身代替，只读 sub 和 amr） */
export function jwtFor(sub: string, otpAgoS: number | null, nowMs: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const amr = otpAgoS === null ? [{ method: 'password', timestamp: 1 }] : [{ method: 'otp', timestamp: Math.floor(nowMs / 1000) - otpAgoS }];
  return `${b64({ alg: 'HS256' })}.${b64({ sub, amr })}.sig`;
}

type Owned<T> = T & { user_id: string };
interface NoteFull extends Owned<NoteRow> { raw_text: string; tags: string[]; ai_meta: unknown; converted_to: unknown }
interface ImageFull extends Owned<ImageRow> { taken_at: number | null; ai_desc: string | null; ai_status: string; skip_reason: string | null }
interface State {
  vault: Map<string, VaultRow>;
  creds: Map<string, Owned<CredRow>>;
  secrets: Map<string, string>;   // device_id → user_id
  challenges: Map<string, { user_id: string; exp: number }>;
  notes: Map<string, NoteFull>;
  images: Map<string, ImageFull>;
  files: Map<string, { user_id: string; note_id: string }>;
  vectors: Set<string>;           // `${user_id}|${kind}|${id}`
  vaultAi: Set<string>;           // `${user_id}|${image_id}`
}

export class FakeVault {
  s: State = {
    vault: new Map(), creds: new Map(), secrets: new Map(), challenges: new Map(), notes: new Map(), images: new Map(),
    files: new Map(), vectors: new Set(), vaultAi: new Set(),
  };
  ms = T0;
  txCount = 0;
  failNext: string | null = null;

  /** 一个普通随手记（明文），可带图片 */
  plainNote(uid: string, id: string, title: string, body: string, imgs: { id: string; has_thumb?: boolean; taken_at?: number }[] = []) {
    this.s.notes.set(id, {
      id, user_id: uid, is_private: false, deleted_at: null, title, body, body_enc: null, enc_key_id: null, category_id: null,
      created_at: this.ms, updated_at: this.ms, raw_text: body, tags: ['t'], ai_meta: { a: 1 }, converted_to: null,
    });
    for (const i of imgs) {
      this.s.images.set(i.id, {
        id: i.id, user_id: uid, note_id: id, bucket: 'images', has_thumb: i.has_thumb ?? false, width: 10, height: 10, bytes: 100,
        deleted_at: null, taken_at: i.taken_at ?? null, ai_desc: 'desc', ai_status: 'done', skip_reason: null,
      });
    }
  }

  private check(n: NoteFull) {
    const ok = n.is_private
      ? n.title === null && n.body === null && n.body_enc !== null && n.raw_text === '' && n.tags.length === 0 && n.ai_meta === null && n.converted_to === null
      : n.body_enc === null;
    if (!ok) throw new StoreDataError('data');
  }

  private checkImg(i: ImageFull) {
    if (i.bucket === 'vault-images' && (i.taken_at !== null || i.ai_desc !== null)) throw new StoreDataError('data');
  }

  tx(uid: string): VaultTx {
    const s = this.s;
    const mine = <T extends { user_id: string }>(v: T | undefined) => (v && v.user_id === uid ? v : undefined);
    const check = this.check.bind(this);
    const checkImg = this.checkImg.bind(this);
    return {
      async vault() { return s.vault.get(uid) ?? null; },
      async insertVault(h) {
        if (s.vault.has(uid)) return false;
        s.vault.set(uid, { pin_hash: h, pin_epoch: 0, fail_count: 0, lock_level: 0, locked_until: null, last_reset_at: null });
        return true;
      },
      async updateVault(p) { const v = s.vault.get(uid); if (v) s.vault.set(uid, { ...v, ...p }); },
      async dropCredentialsAndSecrets() {
        for (const [k, c] of [...s.creds]) if (c.user_id === uid) s.creds.delete(k);
        for (const [k, u] of [...s.secrets]) if (u === uid) s.secrets.delete(k);
      },
      async credentials() { return [...s.creds.values()].filter((c) => c.user_id === uid).sort((a, b) => (a.id < b.id ? -1 : 1)); },
      async credential(id) { return mine(s.creds.get(id)) ?? null; },
      async insertCredential(c) { if (s.creds.has(c.id)) return false; s.creds.set(c.id, { ...c, user_id: uid }); return true; },
      async setSignCount(id, n) { const c = mine(s.creds.get(id)); if (c) c.sign_count = n; },
      async deleteCredential(id) { return mine(s.creds.get(id)) ? s.creds.delete(id) : false; },
      async putChallenge(ch, exp) { s.challenges.set(ch, { user_id: uid, exp }); },
      async takeChallenge(ch) { const c = mine(s.challenges.get(ch)); if (!c) return null; s.challenges.delete(ch); return c.exp; },
      async privateNotes() { return [...s.notes.values()].filter((n) => n.user_id === uid && n.is_private); },
      async note(id) { return mine(s.notes.get(id)) ?? null; },
      async vaultImages() { return [...s.images.values()].filter((i) => i.user_id === uid && i.bucket === 'vault-images'); },
      async imagesOf(nid) { return [...s.images.values()].filter((i) => i.user_id === uid && i.note_id === nid).sort((a, b) => (a.id < b.id ? -1 : 1)); },
      async insertPrivateNote(n) {
        if (s.notes.has(n.id)) throw new StoreDataError('data');
        const row: NoteFull = { ...n, user_id: uid, is_private: true, deleted_at: null, title: null, body: null, raw_text: '', tags: [], ai_meta: null, converted_to: null };
        check(row);
        s.notes.set(n.id, row);
      },
      async updatePrivateNote(id, p) {
        const n = mine(s.notes.get(id));
        if (!n || !n.is_private || n.deleted_at !== null) return false;
        Object.assign(n, p);
        return true;
      },
      async setPrivateDeleted(id, at) {
        const n = mine(s.notes.get(id));
        if (!n || !n.is_private) return false;
        n.deleted_at = at;
        return true;
      },
      async insertVaultImage(nid, img) {
        if (s.images.has(img.id)) return;
        const row: ImageFull = { ...img, user_id: uid, note_id: nid, bucket: 'vault-images', deleted_at: null, taken_at: null, ai_desc: null, ai_status: 'skip', skip_reason: 'vault_off' };
        if (!mine(s.notes.get(nid))) throw new StoreDataError('data');   // 外键 (note_id, user_id)
        s.images.set(img.id, row);
      },
      async removeVaultImages(nid, ids, at) {
        for (const id of ids) { const i = mine(s.images.get(id)); if (i && i.note_id === nid && i.bucket === 'vault-images' && i.deleted_at === null) i.deleted_at = at; }
      },
      async purge(ids) {
        let n = 0;
        for (const id of ids) {
          const r = mine(s.notes.get(id));
          if (r && r.is_private && r.deleted_at !== null) {
            s.notes.delete(id); n++;
            for (const [k, i] of [...s.images]) if (i.note_id === id) s.images.delete(k);
          }
        }
        return n;
      },
      async hasFiles(nid) { return [...s.files.values()].some((f) => f.user_id === uid && f.note_id === nid); },
      async toVault(id, enc, kid, at) {
        const n = mine(s.notes.get(id));
        if (!n || n.is_private || n.deleted_at !== null) return false;
        Object.assign(n, { is_private: true, body_enc: enc, enc_key_id: kid, title: null, body: null, raw_text: '', tags: [], ai_meta: null, converted_to: null, updated_at: at });
        check(n);
        return true;
      },
      async toPlain(id, title, body, at) {
        const n = mine(s.notes.get(id));
        if (!n || !n.is_private || n.deleted_at !== null) return false;
        Object.assign(n, { is_private: false, body_enc: null, enc_key_id: null, title, body, updated_at: at });
        check(n);
        return true;
      },
      async moveImages(nid, to) {
        for (const i of s.images.values()) {
          if (i.user_id !== uid || i.note_id !== nid) continue;
          if (to === 'vault-images') Object.assign(i, { bucket: to, taken_at: null, ai_desc: null, ai_status: 'skip', skip_reason: 'vault_off' });
          else Object.assign(i, { bucket: to, ai_status: 'pending', skip_reason: null });
          checkImg(i);
        }
      },
      async dropVectors(nid) {
        s.vectors.delete(`${uid}|note|${nid}`);
        for (const i of s.images.values()) if (i.note_id === nid) { s.vectors.delete(`${uid}|image|${i.id}`); s.vaultAi.delete(`${uid}|${i.id}`); }
      },
    };
  }

  /** 事务：出错整个回滚 */
  async run<T>(uid: string, fn: (t: VaultTx) => Promise<T>): Promise<T> {
    this.txCount++;
    if (this.failNext) { const f = this.failNext; this.failNext = null; throw new Error(f); }
    const snap = structuredClone(this.s);
    try {
      return await fn(this.tx(uid));
    } catch (e) {
      this.s = snap;
      throw e;
    }
  }
}

/** 内存 R2：记下每次 put 的 contentType（TC-B0-75 契约测试） */
export class FakeR2 implements Obj {
  objs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  puts: { bucket: string; key: string; contentType: string }[] = [];
  failPut = false;
  async get(b: string, k: string) { const o = this.objs.get(`${b}/${k}`); return o ? { body: o.bytes.slice(), contentLength: o.bytes.length } : null; }
  async head(b: string, k: string): Promise<{ contentLength: number | null } | null> { const o = this.objs.get(`${b}/${k}`); return o ? { contentLength: o.bytes.length } : null; }
  async put(b: string, k: string, body: Uint8Array, opts: { contentType: string; ifNoneMatch?: boolean }) {
    if (this.failPut) throw new Error('objstore_network');
    if (opts.ifNoneMatch && this.objs.has(`${b}/${k}`)) throw Object.assign(new Error('objstore_exists'), { code: 'exists' });
    this.puts.push({ bucket: b, key: k, contentType: opts.contentType });
    this.objs.set(`${b}/${k}`, { bytes: new Uint8Array(body), contentType: opts.contentType });
    return {};
  }
  async deleteMany(b: string, keys: readonly string[]) { for (const k of keys) this.objs.delete(`${b}/${k}`); return keys.length; }
  keys(bucket: string) { return [...this.objs.keys()].filter((k) => k.startsWith(`${bucket}/`)).sort(); }
}

export const RULES = {
  pinRe: PIN_RE, failsPerLevel: VAULT_FAILS_PER_LEVEL, lockSeconds, resetOtpMaxAgeS: VAULT_RESET_OTP_MAX_AGE_S, challengeTtlS: WEBAUTHN_CHALLENGE_TTL_S,
  rpId: WEBAUTHN_RP_ID, imageMaxBytes: VAULT_IMAGE_MAX_BYTES, imageKey: vaultImageKey,
};

export interface World { db: FakeVault; r2: FakeR2; deps: Deps; pushes: { user: string; event: VaultPushEvent }[]; mails: number[]; logs: string[]; rows: { act: string }[]; bg: Promise<unknown>[]; rate: Map<string, number> }

/** 一套依赖：authenticate 读 Authorization 里假 JWT 的 sub（'bad' 回 401） */
export function world(over: Partial<Deps> = {}): World {
  const db = new FakeVault();
  const r2 = new FakeR2();
  const w: World = { db, r2, deps: undefined as unknown as Deps, pushes: [], mails: [], logs: [], rows: [], bg: [], rate: new Map() };
  w.deps = {
    async authenticate(req) {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      try {
        const p = JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string };
        return { ok: true, user: { userId: p.sub, jwt } };
      } catch {
        return { ok: false, response: new Response('{"error":"unauthorized"}', { status: 401 }) };
      }
    },
    parse(v) { const p = vaultRequest.safeParse(v); return p.success ? (p.data as VaultReq) : null; },
    rules: RULES,
    async takeRate(k, limit) { const n = (w.rate.get(k) ?? 0) + 1; w.rate.set(k, n); return n <= limit; },
    tx: (uid, fn) => db.run(uid, fn),
    keys: { master: MASTER, pepper: PEPPER, tokenSecret: SECRET },
    r2,
    env: 'prod',
    async notify(user, event) { w.pushes.push({ user, event }); },
    async resetMail(_u, at) { w.mails.push(at); },
    async insertLog(_u, row) { w.rows.push(row); },
    background(p) { w.bg.push(p); },
    now: () => db.ms,
    log: (c) => w.logs.push(c),
    ...over,
  };
  return w;
}

/** 调一次 vault；token 放进 x-vault-token */
export async function call(w: World, body: unknown, o: { user?: string; token?: string | null; otpAgoS?: number | null; origin?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${jwtFor(o.user ?? A, o.otpAgoS === undefined ? 60 : o.otpAgoS, w.db.ms)}`, 'content-type': 'application/json' };
  if (o.token) headers['x-vault-token'] = o.token;
  if (o.origin) headers.origin = o.origin;
  const res = await handle(new Request('http://x/functions/v1/vault', { method: 'POST', headers, body: JSON.stringify(body) }), w.deps);
  await Promise.all(w.bg.splice(0));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/** 设好密码并解锁，回令牌 */
export async function unlocked(w: World, user = A, pin = '1234'): Promise<string> {
  await call(w, { action: 'setup', pin }, { user });
  const r = await call(w, { action: 'unlock', pin }, { user });
  return r.body.vault_token as string;
}
