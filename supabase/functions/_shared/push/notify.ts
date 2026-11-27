// 给一个人的所有设备各发一条推送（B5：隐私记锁定、改密码、重设、新绑定 Face ID 的安全通知，任务单 S2～S4）。
// VAPID 钥匙和签名器按进程缓存（原来写在 push-test/index.ts，B5 挪到这里两处共用）；端点、密钥照 5.3 校验在 send.ts 的 deliver。
// 发送失败不抛错、不影响调用方的主流程，只回各台的结果（调用方按需记错误码，不记端点）。
// 不 import npm 包、不碰 Deno 全局；fetch 由调用方注入。
import type { Bytes } from '../b64url.ts';
import { deliver, type DeliverResult, type Device, type FetchLike, type PushOptions } from './send.ts';
import { loadVapid, VapidSigner, type VapidKeys, type VapidLoad } from './vapid.ts';

let vapidMemo: { priv?: string | undefined; pub?: string | undefined; sub?: string | undefined; p: Promise<VapidLoad> } | null = null;
/** 同一组环境变量只解析一次钥匙 */
export function cachedVapid(priv: string | undefined, pub: string | undefined, sub: string | undefined): Promise<VapidLoad> {
  if (!vapidMemo || vapidMemo.priv !== priv || vapidMemo.pub !== pub || vapidMemo.sub !== sub) vapidMemo = { priv, pub, sub, p: loadVapid(priv, pub, sub) };
  return vapidMemo.p;
}

let signerMemo: { keys: VapidKeys; signer: VapidSigner } | null = null;
/** 签名器跟着钥匙对象走（按 origin 缓存 JWT，D1-6）；换了钥匙就新建 */
export function cachedSigner(keys: VapidKeys, now: () => number): VapidSigner {
  if (!signerMemo || signerMemo.keys !== keys) signerMemo = { keys, signer: new VapidSigner(keys, now) };
  return signerMemo.signer;
}

/** 一个人最多发几台（同 push-test 的 MAX_DEVICES） */
export const NOTIFY_MAX_DEVICES = 20;

/** 逐台发；某一台抛错只算这一台 failed */
export async function pushToDevices(
  devices: readonly Device[], payload: Bytes, opt: PushOptions, keys: VapidKeys, override: string | null, fetchImpl: FetchLike, now: () => number,
): Promise<DeliverResult[]> {
  const signer = cachedSigner(keys, now);
  return Promise.all(devices.slice(0, NOTIFY_MAX_DEVICES).map(async (d) => {
    try {
      return await deliver(d, payload, opt, { fetch: fetchImpl, signer, override });
    } catch {
      return { outcome: 'failed' } as DeliverResult;
    }
  }));
}
