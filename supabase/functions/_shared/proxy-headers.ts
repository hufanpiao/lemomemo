// 转发层写的三个头统一在这里读（架构 14.2 第 4 条、0.31 第 11 条：“_shared/ 里一个函数统一读 x-proxy-secret、x-client-ip、x-lemo-geo”）。
// Worker 先删掉客户端传来的这几个头、再用 headers.set 写自己的；直连 supabase.co 的请求带的同名头是客户端自己写的，不能信。
// 所以：x-proxy-secret 和函数侧的 PROXY_SECRET 常量时间比较，对不上（或函数没配 PROXY_SECRET）就当这三个头都没有。
// 不 import npm 包、不读环境变量（secret 由调用方传进来），Vitest 直接测。

export interface Geo {
  /** 两位大写国家码，或 '-' */
  country: string;
  /** 城市（已解码），或 '-' */
  city: string;
}

export interface ProxyInfo {
  /** secret 对上了：这几个头是转发层写的 */
  trusted: boolean;
  /** 只有 trusted 且格式像 IP 时才有 */
  ip: string | null;
  /** 只有 trusted 且格式对时才有；两样都是 '-' 时调用方写“未知地区” */
  geo: Geo | null;
}

const UNTRUSTED: ProxyInfo = { trusted: false, ip: null, geo: null };

/** 定长比较，免得按响应时间猜 secret */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:.]{2,45}$/;

/** CF-Connecting-IP 的写法：IPv4 点分十进制，或 IPv6（含 IPv4 映射）。别的一律不认 */
export function parseIp(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (IPV4.test(s)) return s;
  if (s.includes(':') && IPV6.test(s)) return s.toLowerCase();
  return null;
}

/** IPv6 展开成 8 个 16 位数；内嵌的 IPv4（::ffff:1.2.3.4）折成最后两组。格式不对返回 null */
function v6Groups(s: string): number[] | null {
  let t = s.toLowerCase();
  const pct = t.indexOf('%');
  if (pct >= 0) t = t.slice(0, pct);   // 去掉区域标识（fe80::1%eth0）
  const tail: number[] = [];
  const lastColon = t.lastIndexOf(':');
  if (t.includes('.')) {
    const v4 = t.slice(lastColon + 1);
    if (!IPV4.test(v4)) return null;
    const o = v4.split('.').map(Number);
    tail.push(((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0));
    // 前半段：“::ffff:” → “::ffff”；“64:ff9b::” 保持（以 :: 结尾）；“1:2:3:4:5:6:” → “1:2:3:4:5:6”
    const head = t.slice(0, lastColon + 1);
    t = head.endsWith('::') ? head : head.slice(0, -1);
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parse(halves[0] ?? '');
  const right = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!left || !right) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...left, ...new Array<number>(8 - known).fill(0), ...right, ...tail];
  }
  return known === 8 ? [...left, ...tail] : null;
}

/**
 * 限流用的 IP（K2 安全审查 P3）：IPv4 原样；IPv4 映射的 IPv6（::ffff:a.b.c.d）当 IPv4；
 * 其余 IPv6 只取前 64 位，写成 “xxxx:xxxx:xxxx:xxxx::/64”（一家宽带通常分到一整个 /64，换后 64 位不算新来源）。
 * 不是合法 IP 返回 null（调用方当不可信）
 */
export function rateIp(ip: string): string | null {
  const s = ip.trim();
  if (IPV4.test(s)) return s;
  if (!s.includes(':')) return null;
  const g = v6Groups(s);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const a = g[6] ?? 0;
    const b = g[7] ?? 0;
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** x-lemo-geo =<国家>|<城市>（0.31 第 11 条）：按第一个 | 切开；国家不是 ^[A-Z]{2}$ 也不是 '-' 就整条当没有；城市解码失败当 '-' */
export function parseGeo(v: string | null): Geo | null {
  if (!v) return null;
  const i = v.indexOf('|');
  if (i < 0) return null;
  const country = v.slice(0, i);
  if (!/^[A-Z]{2}$/.test(country) && country !== '-') return null;
  const raw = v.slice(i + 1);
  let city = '-';
  if (raw && raw !== '-') {
    try {
      city = decodeURIComponent(raw).slice(0, 64) || '-';
    } catch {
      city = '-';
    }
  }
  return { country, city };
}

export function readProxyHeaders(req: Request, proxySecret: string | undefined): ProxyInfo {
  if (!proxySecret) return UNTRUSTED;   // 函数没配 PROXY_SECRET：谁写的头都不信
  const got = req.headers.get('x-proxy-secret');
  if (got === null || !safeEqual(got, proxySecret)) return UNTRUSTED;
  return {
    trusted: true,
    ip: parseIp(req.headers.get('x-client-ip')),
    geo: parseGeo(req.headers.get('x-lemo-geo')),
  };
}
