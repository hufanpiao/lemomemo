// 测试用的假认证器：用 WebCrypto 现生成 P-256 钥匙对，按 WebAuthn 的格式拼 attestationObject（fmt none / packed 自签）和断言。
// 只给 tests/functions/vault-webauthn*.test.ts 用；自带一个最小 CBOR 编码器（只编测试要的几种类型）。
import { b64uEncode } from '../../supabase/functions/_shared/b64url.ts';

type C = number | string | Uint8Array | C[] | Map<C, C> | boolean;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function cbor(v: C): Uint8Array {
  const out: number[] = [];
  const put = (x: C): void => {
    if (typeof x === 'number') out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === 'boolean') out.push(x ? 0xf5 : 0xf4);
    else if (typeof x === 'string') { const b = new TextEncoder().encode(x); out.push(...head(3, b.length), ...b); }
    else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) { out.push(...head(4, x.length)); x.forEach(put); }
    else { out.push(...head(5, x.size)); for (const [k, val] of x) { put(k); put(val); } }
  };
  put(v);
  return new Uint8Array(out);
}

const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));

/** r‖s（64 字节）→ DER */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && (v[1] ?? 0) < 0x80) v = v.slice(1);
    if ((v[0] ?? 0) >= 0x80) v = cat(new Uint8Array([0]), v);
    return cat(new Uint8Array([2, v.length]), v);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

export const FLAGS = { UP: 1, UV: 4, AT: 0x40 };

export class FakeAuthenticator {
  keys!: CryptoKeyPair;
  id = crypto.getRandomValues(new Uint8Array(32));
  count = 0;
  static async make(): Promise<FakeAuthenticator> {
    const a = new FakeAuthenticator();
    a.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    return a;
  }
  get idB64() { return b64uEncode(this.id); }

  async cose(alg = -7): Promise<Uint8Array> {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', this.keys.publicKey) as ArrayBuffer);
    return cbor(new Map<C, C>([[1, 2], [3, alg], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]));
  }

  async authData(rpId: string, flags: number, withCred: boolean, alg = -7): Promise<Uint8Array> {
    const cnt = new Uint8Array([(this.count >>> 24) & 0xff, (this.count >>> 16) & 0xff, (this.count >>> 8) & 0xff, this.count & 0xff]);
    const base = cat(await sha(new TextEncoder().encode(rpId)), new Uint8Array([flags | (withCred ? FLAGS.AT : 0)]), cnt);
    if (!withCred) return base;
    return cat(base, new Uint8Array(16), new Uint8Array([this.id.length >> 8, this.id.length & 0xff]), this.id, await this.cose(alg));
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, data as Uint8Array<ArrayBuffer>)));
  }

  clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** webauthn_register 的 attestation 一项 */
  async attest(challenge: string, o: { origin?: string; rpId?: string; flags?: number; fmt?: 'none' | 'packed'; alg?: number } = {}) {
    const cd = this.clientData('webauthn.create', challenge, o.origin ?? 'https://lemomemo.com');
    const ad = await this.authData(o.rpId ?? 'lemomemo.com', o.flags ?? (FLAGS.UP | FLAGS.UV), true, o.alg);
    const stmt = o.fmt === 'packed' ? new Map<C, C>([['alg', -7], ['sig', await this.sign(cat(ad, await sha(cd)))]]) : new Map<C, C>();
    const att = cbor(new Map<C, C>([['fmt', o.fmt ?? 'none'], ['attStmt', stmt], ['authData', ad]]));
    return { id: this.idB64, client_data_json: b64uEncode(cd), attestation_object: b64uEncode(att) };
  }

  /** unlock_webauthn 的 assertion 一项；每次 count 加 1（countDelta 可改） */
  async assert(challenge: string, o: { origin?: string; rpId?: string; flags?: number; countDelta?: number; type?: string } = {}) {
    this.count += o.countDelta ?? 1;
    const cd = this.clientData(o.type ?? 'webauthn.get', challenge, o.origin ?? 'https://lemomemo.com');
    const ad = await this.authData(o.rpId ?? 'lemomemo.com', o.flags ?? (FLAGS.UP | FLAGS.UV), false);
    const sig = await this.sign(cat(ad, await sha(cd)));
    return { id: this.idB64, client_data_json: b64uEncode(cd), authenticator_data: b64uEncode(ad), signature: b64uEncode(sig) };
  }
}
