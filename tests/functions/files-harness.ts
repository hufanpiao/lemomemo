// tests/functions/files*.test.ts 共用：环境（假值）、调用入口、造请求的小工具。
import { handleFiles, type FilesDeps, type FilesEnv } from '../../functions/files/[[path]].ts';
import { createVersionGate } from '../../functions/sb/version-gate.ts';
import type { ObjStore } from '../../shared/objstore.ts';
import { bearer, clock, fakeAuthz, ID1, ID2, type MemStore, memStore, NOTE, UA, UB } from './files-fakes.ts';

export const BASE = 'https://lemomemo.com';
export const T0 = Date.UTC(2026, 9, 28, 3, 0, 0);
export const ENV: FilesEnv = {
  SUPABASE_UPSTREAM: 'http://supabase.fake.test',
  SUPABASE_ANON_KEY: 'fake-anon-key',
  R2_ENDPOINT: 'https://s3.fake.test',
  R2_FILES_ACCESS_KEY_ID: 'FAKEKEYID',
  R2_FILES_SECRET_ACCESS_KEY: 'fake-secret',
  FILES_URL_SECRET: 'fake-files-url-secret-for-tests-only-0000',
};
export const EXE = 'http://tauri.localhost';

export const IMG = `${UA}/${NOTE}/${ID1}.webp`;
export const THUMB = `${UA}/${NOTE}/${ID1}.t.webp`;
export const AVATAR = `${UA}/anniv/${NOTE}/${ID1}.webp`;
export const PDF = `${UA}/${NOTE}/${ID2}.pdf`;
export const PPTX = `${UA}/${NOTE}/${ID1}.pptx`;
export const B_IMG = `${UB}/${NOTE}/${ID1}.webp`;

/** store：默认内存替身；打真的 S3 替身时传 liveObjStore()（files-get.test.ts 的替身组） */
export function setup<S extends ObjStore = MemStore>(opts: { min?: string; fixed?: boolean; timeoutMs?: number; store?: S } = {}) {
  const store = (opts.store ?? memStore()) as S;
  const authz = fakeAuthz();
  const c = clock(T0);
  const logs: { code: string; ms: number }[] = [];
  const deps: FilesDeps = {
    fetch: authz.fetch,
    store,
    gate: createVersionGate({ loadMin: async () => opts.min ?? '4.0.0', now: c.now }),
    now: c.now,
    log: (code, ms) => logs.push({ code, ms }),
    ...(opts.fixed ? { fixedLength: () => new TransformStream<Uint8Array, Uint8Array>() } : {}),
    ...(opts.timeoutMs ? { authzTimeoutMs: opts.timeoutMs } : {}),
  };
  const call = (r: Request, env: FilesEnv = ENV) => handleFiles(r, env, deps);
  return { store, authz, c, logs, deps, call };
}

export function put(path: string, body: Uint8Array | ReadableStream<Uint8Array>, o: { bucket?: string; ct?: string; len?: number | null; uid?: string | null; v?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': o.ct ?? (path.endsWith('.webp') ? 'image/webp' : 'application/pdf'), 'X-App-Version': o.v ?? '4.0.0' };
  if (o.uid !== null) headers.Authorization = bearer(o.uid ?? UA);
  const len = o.len === undefined ? (body instanceof Uint8Array ? body.length : null) : o.len;
  if (len !== null) headers['Content-Length'] = String(len);
  if (o.origin) headers.Origin = o.origin;
  return new Request(`${BASE}/files/v1/o/${o.bucket ?? (path.endsWith('.webp') && !path.includes('.t.webp') ? 'images' : 'files')}/${path}`, {
    method: 'PUT',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
}

export const signReq = (items: unknown[], uid: string = UA) =>
  new Request(`${BASE}/files/v1/sign`, {
    method: 'POST',
    headers: { Authorization: bearer(uid), 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });

export async function signOne(s: ReturnType<typeof setup>, item: Record<string, unknown>) {
  const r = await s.call(signReq([item]));
  const j = (await r.json()) as { items: { ok: boolean; url?: string; e?: number; reason?: string }[] };
  return j.items[0] ?? { ok: false };
}
