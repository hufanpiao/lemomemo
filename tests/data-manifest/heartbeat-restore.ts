// TC-B0-117 真链路（purge-runner.ts 的 startLivePurge）开跑时记下 account-purge 的心跳，close 时按原样写回；这里是读、写两头的纯函数
// （TESTCLEAN 复审建议，10-30：解包加层数上限和 try/catch；update 改到 0 行单独报“心跳行不见了”）

/** detail 最多解几层 JSON 字符串：正常 0 层；以前 close 的 bug 每跑一轮多包一层。每包一层长度约乘 4（16 层约 20 万字，二十几层就 RangeError），
 *  到这个数还没解完就该人工看了 */
export const HEARTBEAT_UNWRAP_MAX = 16;

/**
 * 兜底：以前 close 的写法每跑一轮把 detail 多包一层 JSON 字符串（account-purge 写的本是对象）。读到 string 就一层层解开：
 * • 超过 max 层还是字符串：抛错（不再往下解，也不往回写坏数据）；
 * • 某一层 JSON.parse 解不开（本来就是普通字符串）：停在这一层原样返回，close 时照它写回
 */
export function unwrapHeartbeatDetail(detail: unknown, max = HEARTBEAT_UNWRAP_MAX): unknown {
  let d = detail;
  for (let depth = 0; typeof d === 'string'; depth++) {
    if (depth >= max) throw new Error(`live purge：account-purge 心跳的 detail 套了超过 ${max} 层 JSON 字符串，不再往下解，请人工看一下 private.heartbeat`);
    try {
      d = JSON.parse(d) as unknown;
    } catch {
      return d;
    }
  }
  return d;
}

/**
 * close 还原心跳以后核对 update … returning jsonb_typeof(detail) 的结果，不对就抛错：
 * • 一行都没改到：心跳行在跑的过程中不见了（被删了），没能还原——单独报，不和“类型不对”混在一起；
 * • 还原后的 jsonb_typeof 和原值（开跑时解包后的 detail）的 JSON 类型对不上：按原值类型核对，不一律要求 object——
 *   原本就是 jsonb 字符串的（unwrapHeartbeatDetail 解不开、原样返回的）还原后是 string，不误报；原值是对象、还原成 string 才是又被包成字符串了。
 * 注意：postgres.js 把 jsonb 的 'null' 和 SQL NULL 都读成 null，开跑时分不清；还原时 null 一律写成 SQL NULL，
 * 所以原来是 jsonb 'null' 的，还原后会变成 SQL NULL（jsonb_typeof 是 null），这里不当错报
 */
export function assertHeartbeatRestored(back: readonly { t: string | null }[], detail: unknown): void {
  if (back.length === 0) throw new Error('live purge：还原 account-purge 心跳时 update 改到 0 行——心跳行不见了（跑的过程中被删了？），没能还原');
  const want = jsonTypeOf(detail);
  const got = back[0]?.t ?? null;
  if (want === null || got === want) return;
  const why = got === 'string' ? '被包成字符串了' : '类型对不上';
  throw new Error(`live purge：还原 account-purge 心跳后 detail 是 ${got}，原值是 ${want}（${why}）`);
}

/** 和 jsonb_typeof 同一套名字：object、array、string、number、boolean；null 返回 null（还原成 SQL NULL，不核对） */
function jsonTypeOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}
