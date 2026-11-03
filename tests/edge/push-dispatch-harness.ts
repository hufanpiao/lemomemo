// push-dispatch 测试的公共部分：假 VAPID（现生成、用完即丢）、cron 请求、按内存库组 Deps
import type { Deps } from '../../supabase/functions/push-dispatch/core.ts';
import type { RoundLogic } from '../../supabase/functions/push-dispatch/round.ts';
import { loadVapid, type VapidKeys } from '../../supabase/functions/_shared/push/vapid.ts';
import type { FetchLike } from '../../supabase/functions/_shared/push/send.ts';
import { b64u, unb64u } from '../fakes/push-service-vapid.ts';
import { LOGIC, type MemDb } from './push-dispatch-mem.ts';

export const CRON = 'c'.repeat(40);

export async function fakeVapid(): Promise<{ keys: VapidKeys; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(new Uint8Array([4, ...unb64u(j.x ?? ''), ...unb64u(j.y ?? '')]));
  const r = await loadVapid(JSON.stringify({ kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y }), pub, 'https://lemomemo.com');
  if (!r.ok) throw new Error(r.reason);
  return { keys: r.keys, pub };
}

export function cronReq(): Request {
  return new Request('http://kong:8000/functions/v1/push-dispatch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': CRON }, body: '{}' });
}

export function depsFor(db: MemDb, keys: VapidKeys, over: Partial<Deps> & { fetch?: FetchLike; logic?: RoundLogic } = {}): Deps & { codes: string[] } {
  const codes: string[] = [];
  return {
    cronSecret: CRON,
    override: { ok: true, url: null },
    vapid: async () => ({ ok: true, keys }),
    store: db,
    isUsable: async (u) => db.usable.get(u) === true,
    now: Date.now,
    log: (c) => codes.push(c),
    logic: LOGIC,
    codes,
    ...over,
  };
}
