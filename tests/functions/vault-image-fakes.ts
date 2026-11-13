// vault-image 测试的假世界（vault-image.test.ts、vault-token-consumers.test.ts 共用）。
import { vaultImageGet, vaultImageKey, vaultImageUploadQuery, VAULT_IMAGE_MAX_BYTES } from '../../shared/schema/vault.ts';
import { signVaultToken, vaultTokenChecker } from '../../supabase/functions/_shared/vault-token.ts';
import { type Deps, handle } from '../../supabase/functions/vault-image/core.ts';
import { A, B, FakeR2, jwtFor, SECRET, T0, uuid } from './vault-fakes.ts';

export const N = uuid(1);
export const I = uuid(2);
export const webp = (n = 64) => { const b = new Uint8Array(n); b.set([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]); return b; };

export function imageWorld(epochs = new Map([[A, 0], [B, 0]])) {
  const r2 = new FakeR2();
  const logs: string[] = [];
  const rate = new Map<string, number>();
  const notes = new Map([[`${A}|${N}`, true]]);   // A 的隐私记 N
  const images = new Map<string, { note_id: string; bucket: string; has_thumb: boolean; user: string }>();
  let ms = T0;
  const deps: Deps = {
    async authenticate(req) {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const p = JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string };
      return { ok: true, user: { userId: p.sub } };
    },
    async takeRate(k, limit) { const n = (rate.get(k) ?? 0) + 1; rate.set(k, n); return n <= limit; },
    checkToken: vaultTokenChecker(SECRET, () => ms, async (u) => epochs.get(u) ?? null),
    parseUpload(q) { const p = vaultImageUploadQuery.safeParse(q); return p.success ? p.data : null; },
    parseGet(v) { const p = vaultImageGet.safeParse(v); return p.success ? p.data : null; },
    imageKey: vaultImageKey,
    maxBytes: VAULT_IMAGE_MAX_BYTES,
    async ownsPrivateNote(u, n) { return notes.get(`${u}|${n}`) === true; },
    async image(u, id) { const i = images.get(id); return i && i.user === u ? i : null; },
    r2,
    now: () => ms,
    log: (c) => logs.push(c),
  };
  const tok = async (u = A) => (await signVaultToken(SECRET, u, epochs.get(u) ?? 0, ms)).token;
  const req = (path: string, body: BodyInit, h: Record<string, string> = {}, u = A) =>
    handle(new Request(`http://x/functions/v1/vault-image${path}`, { method: 'POST', headers: { authorization: `Bearer ${jwtFor(u, 60, ms)}`, ...h }, body }), deps);
  const upload = async (bytes: Uint8Array, q = `?action=upload&note_id=${N}&image_id=${I}&part=full`, token?: string | null, u = A) =>
    req(q, bytes as Uint8Array<ArrayBuffer>, token === null ? {} : { 'x-vault-token': token ?? (await tok(u)) }, u);
  const get = async (body: unknown, token?: string | null, u = A) =>
    req('', JSON.stringify(body), token === null ? {} : { 'x-vault-token': token ?? (await tok(u)) }, u);
  return { r2, logs, deps, images, notes, epochs, tok, upload, get, advance: (d: number) => { ms += d; } };
}
