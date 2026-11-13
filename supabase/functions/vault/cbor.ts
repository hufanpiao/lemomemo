// 最小 CBOR 解码（RFC 8949 的子集），只给 WebAuthn 的 attestationObject 和 COSE 公钥用（B5 任务单 S4：不引第三方库）。
// 认：无符号整数、负整数、字节串、文本串、数组、映射、false / true / null；不认：不定长、标签、浮点、undefined 和别的简单值——一律当格式不对。
// 整数只认到 2^53（JS 安全整数）；嵌套最多 8 层、一个数组或映射最多 64 项（攻击者给的数据，不让它把内存和时间耗光）。
// 映射用 Map（键可能是整数，比如 COSE 的 1、3、-1），不准有重复键。出错一律抛 CborError，不带内容。
// 不 import 任何东西，Vitest 直接测。

export type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

export class CborError extends Error {
  constructor() {
    super('bad_cbor');
  }
}

const MAX_DEPTH = 8;
const MAX_ITEMS = 64;
const td = new TextDecoder('utf-8', { fatal: true });

class Reader {
  pos: number;
  readonly b: Uint8Array;
  constructor(b: Uint8Array, start: number) { this.b = b; this.pos = start; }
  byte(): number {
    const v = this.b.at(this.pos);   // 用 at() 不用方括号（check_backend F7 只放行几种数字下标）
    if (v === undefined) throw new CborError();
    this.pos += 1;
    return v;
  }
  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.b.length) throw new CborError();
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** 附加信息 ai 对应的长度或值（0～23 直接是值；24～27 后面跟 1、2、4、8 字节） */
  arg(ai: number): number {
    if (ai < 24) return ai;
    if (ai === 24) return this.byte();
    if (ai === 25) return this.byte() * 0x100 + this.byte();
    if (ai === 26) return ((this.byte() * 0x100 + this.byte()) * 0x100 + this.byte()) * 0x100 + this.byte();
    if (ai === 27) {
      const hi = this.arg(26);
      const lo = this.arg(26);
      if (hi > 0x1fffff) throw new CborError();   // 超过 2^53
      return hi * 0x100000000 + lo;
    }
    throw new CborError();   // 28～30 保留，31 是不定长
  }
}

function item(r: Reader, depth: number): Cbor {
  if (depth > MAX_DEPTH) throw new CborError();
  const ib = r.byte();
  const major = ib >> 5;
  const ai = ib & 0x1f;
  switch (major) {
    case 0: return r.arg(ai);
    case 1: return -1 - r.arg(ai);
    case 2: return r.take(r.arg(ai));
    case 3: {
      try {
        return td.decode(r.take(r.arg(ai)));
      } catch (e) {
        if (e instanceof CborError) throw e;
        throw new CborError();
      }
    }
    case 4: {
      const n = r.arg(ai);
      if (n > MAX_ITEMS) throw new CborError();
      const out: Cbor[] = [];
      for (let i = 0; i < n; i++) out.push(item(r, depth + 1));
      return out;
    }
    case 5: {
      const n = r.arg(ai);
      if (n > MAX_ITEMS) throw new CborError();
      const out = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = item(r, depth + 1);
        if (typeof k !== 'number' && typeof k !== 'string') throw new CborError();   // 只认整数、文本当键
        if (out.has(k)) throw new CborError();
        out.set(k, item(r, depth + 1));
      }
      return out;
    }
    case 7:
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      throw new CborError();
    default:
      throw new CborError();   // 6 = 标签
  }
}

/** 从 start 起解一个数据项，回值和结束位置（authData 里公钥后面可能还跟着扩展） */
export function decodeFirst(b: Uint8Array, start = 0): { value: Cbor; end: number } {
  const r = new Reader(b, start);
  const value = item(r, 0);
  return { value, end: r.pos };
}

/** 整段必须正好是一个数据项 */
export function decodeAll(b: Uint8Array): Cbor {
  const { value, end } = decodeFirst(b, 0);
  if (end !== b.length) throw new CborError();
  return value;
}

export const isMap = (v: Cbor | undefined): v is Map<Cbor, Cbor> => v instanceof Map;
export const isBytes = (v: Cbor | undefined): v is Uint8Array => v instanceof Uint8Array;
