// account 的 export action（ACCOUNT-sugg ①：从 core.ts 拆出；流程说明见 core.ts 文件头的 export 一段）。
// 按数据清单挑表、按主键翻页读本人的行、边读边压缩成 gzip、响应之后发导出通知。对外经 core.ts 转出。

import { exportMail } from '../_shared/account-mail.ts';
import { readProxyHeaders } from '../_shared/proxy-headers.ts';
import {
  ACCOUNT_DAILY_LIMIT, type ActiveUser, DAY_S, type Deps, err, type ExportTable, keys, mailInfo, NO_STORE, utcDate,
} from './common.ts';

// ---------------- 常量（出处见行尾） ----------------
/** 导出临时性失败每人每天最多退回 3 次，超过就照常扣（K3 复审低 2；键 export-refund:<user_id>:<UTC 日期>，和 account 键同一天口径） */
export const EXPORT_REFUND_DAILY_LIMIT = 3;
export const EXPORT_PAGE = 1000;               // PostgREST 默认每次最多 1000 行，按主键往后翻页（gt），不用 offset
export const EXPORT_MAX_ROWS = 25_000;         // 同步表每张上限 2 万行（row_quota），多读一点余量；超过就当数据异常
/** logs 不受 row_quota 管：每人每天最多 2,000 条、保留 90 天（第 6 节 logs、3.4），最多约 18 万行，再加 2 万行余量 */
export const EXPORT_MAX_LOG_ROWS = 2000 * 90 + 20_000;
/**
 * 原文（JSON）总字节上限。边读边压缩，内存里只留一页原文和压缩后的块：
 * 同步表约 10 张 × 2 万行、logs 20 万行，正常账号原文几十 MB，压缩后几 MB；超过这个数就整次失败（退回次数），不让一个账号撑爆函数内存
 */
export const EXPORT_MAX_RAW_BYTES = 256 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ManifestLike {
  tables: readonly {
    name: string; schema: string; export: string;
    exportOmitCols?: readonly string[] | undefined;
    vaultRows?: { flag: string; cipherCols: readonly string[]; neutralCols: readonly string[] } | undefined;
  }[];
}

/** 按数据清单（3.5）挑出要导出的表：public、export = 'json'。private 的表、export: none 的表一律不进（第 83 条） */
export function exportTablesOf(manifests: readonly ManifestLike[]): ExportTable[] {
  const out: ExportTable[] = [];
  for (const m of manifests) {
    for (const t of m.tables) {
      if (t.schema !== 'public' || t.export !== 'json') continue;
      const base = {
        name: t.name,
        keyCol: t.name === 'profiles' ? ('user_id' as const) : ('id' as const),
        maxRows: t.name === 'logs' ? EXPORT_MAX_LOG_ROWS : EXPORT_MAX_ROWS,
        omitCols: [...(t.exportOmitCols ?? [])],
      };
      out.push(t.vaultRows ? { ...base, vaultRows: t.vaultRows } : base);
    }
  }
  return out;
}

// ---------------- 导出通知里的设备名 ----------------
/** 方向控制符和零宽字符（U+200B～U+200F、U+202A～U+202E、U+2066～U+2069，另加 U+FEFF）：能把名字倒着显示、藏东西 */
const BIDI_ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex -- 就是要去掉控制字符（C0、DEL、C1）
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** 像域名、网址、IP、邮箱的：名字里有任何点或句号（. 。 ． ｡，NFKC 以后 ． 变 .、｡ 变 。）一律算——非拉丁顶级域（.中国、.рф、.한국）、
 *  IP、混写字母（西里尔 о）都绕不过（K3 复审 A）；另有 @、://、www */
const LINK_LIKE = /[.\u3002\uff0e\uff61]|@|:\/\/|www/i;
/** 像电话号码的：7 位以上数字，中间只隔空白、横线、括号、斜杠、加号、下划线（02-1234-5678、010 1234 5678、全角数字 NFKC 后同样）。
 *  防止安全通知里出现“请回拨”的话术（K3 复审低 1）；iPhone 15 Pro、Galaxy S24 不受影响。用 \p{Nd} 认各种文字的数字 */
const PHONE_LIKE = /(?:\p{Nd}[\s\p{Pd}()/+_]*){6}\p{Nd}/u;

/**
 * 设备名放进邮件正文前清一下（K3 安全审查必改 1：设备名是用户自己写的，拿到会话的人也能改，不能让它变成钓鱼文案）：
 * NFKC 规整 → 去掉方向控制符、零宽字符、控制字符 → 像域名、网址、邮箱的一律整个不用（返回 null，邮件里写通用的“未知设备”）
 * → 截到 40 个字符。判断在截断之前做，截断只为版面。
 */
export function cleanDeviceLabel(v: string | null): string | null {
  if (v === null) return null;
  const s = v.normalize('NFKC').replace(BIDI_ZERO_WIDTH, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!s || LINK_LIKE.test(s) || PHONE_LIKE.test(s)) return null;
  return [...s].slice(0, 40).join('');
}

// ---------------- 组包 ----------------
type VaultMode = 'omitted' | 'cipher';

/** 导出中途失败的原因（写进日志的码是 export_<它>） */
class ExportError extends Error {}

/** 行是不是隐私记行：flag 写成列名（is_private、is_vault）或 "col = 'value'"（note_images 的 bucket = 'vault-images'） */
export function isVaultRow(row: Record<string, unknown>, flag: string): boolean {
  const m = /^\s*([a-z_][a-z0-9_]*)\s*=\s*'([^']*)'\s*$/.exec(flag);
  if (m) { const col = m[1] ?? ''; return (Object.hasOwn(row, col) ? row[col] : undefined) === m[2]; }   // 只取自有属性（check_backend F7）
  if (!/^[a-z_][a-z0-9_]*$/.test(flag)) throw new ExportError('bad_vault_flag');   // 认不出的写法不猜，整次导出失败
  return (Object.hasOwn(row, flag) ? row[flag] : undefined) === true;
}

function flagCols(flag: string): string[] {
  const m = /^\s*([a-z_][a-z0-9_]*)/.exec(flag);
  return m?.[1] ? [m[1]] : [];
}

/**
 * 一张表的导出行：普通行原样；隐私记行没带令牌时整行不要，带了有效令牌只留密文列和不含内容的列（含 flag 列）；
 * 最后去掉清单 exportOmitCols 的列
 */
export function exportRows(t: ExportTable, rows: readonly Record<string, unknown>[], mode: VaultMode): Record<string, unknown>[] {
  const v = t.vaultRows;
  const keep = v ? new Set([...v.cipherCols, ...v.neutralCols, ...flagCols(v.flag)]) : null;
  const omit = new Set(t.omitCols);
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    let row = r;
    if (v && keep && isVaultRow(r, v.flag)) {
      if (mode === 'omitted') continue;
      row = Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k)));
    }
    out.push(omit.size ? Object.fromEntries(Object.entries(row).filter(([k]) => !omit.has(k))) : row);
  }
  return out;
}

/** 边写边压缩：原文按块进 CompressionStream，压缩后的块收进数组；内存里不留整份原文 */
class GzipSink {
  rawBytes = 0;
  private readonly maxRaw: number;
  private readonly writer: ReturnType<CompressionStream['writable']['getWriter']>;
  private readonly chunks: Promise<Uint8Array[]>;
  private readonly enc = new TextEncoder();

  constructor(maxRaw: number) {
    this.maxRaw = maxRaw;
    const cs = new CompressionStream('gzip');
    this.writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    this.chunks = (async () => {
      const out: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out.push(value);
      }
    })();
    this.chunks.catch(() => {});   // abort 时读端也报错，这里不算未处理
  }

  async write(text: string): Promise<void> {
    const b = this.enc.encode(text);
    this.rawBytes += b.byteLength;
    if (this.rawBytes > this.maxRaw) throw new ExportError('too_large');
    await this.writer.write(b);
  }

  /** 收尾，拼成一整块（只拼压缩后的字节） */
  async close(): Promise<ArrayBuffer> {
    await this.writer.close();
    const parts = await this.chunks;
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out.buffer;
  }

  abort(): void {
    this.writer.abort().catch(() => {});
  }
}

/** 按主键往后翻页读一张表，读一页写一页；读到别人的行、超过这张表的上限、主键不前进都整次失败 */
async function writeTable(deps: Deps, sink: GzipSink, t: ExportTable, userId: string, mode: VaultMode): Promise<void> {
  let after: string | number | null = null;
  let n = 0;
  let first = true;
  for (;;) {
    const page = await deps.store.readPage(t.name, t.keyCol, userId, after, EXPORT_PAGE);
    for (const r of page) {
      if (r.user_id !== userId) throw new ExportError('foreign_row');   // service role 绕过 RLS：读到别人的行就整次失败，不往包里放
    }
    n += page.length;
    if (n > t.maxRows) throw new ExportError('too_many_rows');
    const rows = exportRows(t, page, mode);
    if (rows.length) {
      await sink.write((first ? '' : ',') + rows.map((r) => JSON.stringify(r)).join(','));
      first = false;
    }
    if (page.length < EXPORT_PAGE) return;
    const lastRow = page.at(-1);
    const last: unknown = t.keyCol === 'user_id' ? lastRow?.user_id : lastRow?.id;   // 只有这两种主键（不用方括号取列，check_backend F7）
    if ((typeof last !== 'string' && typeof last !== 'number') || last === after) throw new ExportError('bad_page_key');   // 防止翻不动时死循环
    after = last;
  }
}

/** 整份导出（gzip）。中途失败抛 ExportError 或数据库的错，压缩到一半的块丢掉 */
async function buildExport(deps: Deps, userId: string, now: number, mode: VaultMode): Promise<ArrayBuffer> {
  const sink = new GzipSink(deps.exportMaxRawBytes ?? EXPORT_MAX_RAW_BYTES);
  try {
    const head = { format: 'lemomemo-export', version: 1, exported_at: new Date(now).toISOString(), user_id: userId, vault: mode };
    await sink.write(`${JSON.stringify(head).slice(0, -1)},"tables":{`);
    let firstTable = true;
    for (const t of deps.exportTables) {
      await sink.write(`${firstTable ? '' : ','}${JSON.stringify(t.name)}:[`);
      firstTable = false;
      await writeTable(deps, sink, t, userId, mode);
      await sink.write(']');
    }
    await sink.write('}}');
    return await sink.close();
  } catch (e) {
    sink.abort();
    throw e;
  }
}

// ---------------- action ----------------
export async function exportData(req: Request, body: Record<string, unknown>, user: ActiveUser, deps: Deps): Promise<Response> {
  const { store } = deps;
  const deviceId = typeof body.device_id === 'string' && UUID.test(body.device_id) ? body.device_id.toLowerCase() : null;
  if (body.device_id !== undefined && body.device_id !== null && deviceId === null) return err(400, 'bad_request');

  // ① 隐私记令牌：没带不拒（包里不放隐私记）；带了就必须有效（第 93、94 条）
  const token = req.headers.get('x-vault-token');
  let mode: VaultMode = 'omitted';
  if (token !== null) {
    if (token === '' || token.length > 2048) return err(401, 'vault_locked');
    const v = await deps.verifyVaultToken(user.userId, token);
    if (v !== 'ok') return err(401, v);
    mode = 'cipher';
  }
  // ② 每天 3 次（和 delete 合计）
  const now = deps.now();
  const rateKey = keys.account(user.userId, now);
  if (!(await store.takeRate(rateKey, ACCOUNT_DAILY_LIMIT, DAY_S))) return err(429, 'rate_limited');
  // 计次以后失败：只有临时性失败（写不进 logs、数据库出错）退回这一次，重试有望成功、不该占当天的额度；
  // 数据本身导致的失败（ExportError：too_large、too_many_rows、foreign_row、bad_page_key、bad_vault_flag）每次重试都一样，
  // 照常扣次数——否则塞满数据就能无限次触发“读几百 MB 再压缩”（K3 复审 B）
  const fail = async (code: string, refund: boolean): Promise<Response> => {
    deps.log?.(code);
    if (refund) {
      try {
        // 退回也有每天上限：反复制造临时性失败（比如故意打满数据库）不能换来无限次导出
        if (await store.takeRate(keys.exportRefund(user.userId, now), EXPORT_REFUND_DAILY_LIMIT, DAY_S)) await store.refundRate(rateKey);
        else deps.log?.('export_refund_capped');
      } catch {
        deps.log?.('export_refund_failed');
      }
    }
    return err(503, 'try_later');
  };
  // ③ 先记录：写不进就不导出（第 96 条②）
  try {
    await store.insertLog(user.userId, { t: now, device: deviceId, kind: 'run', act: 'export', src: 'account' });
  } catch {
    return await fail('export_log_failed', true);
  }
  // ④ 读各表、边读边压缩
  let gz: ArrayBuffer;
  try {
    gz = await buildExport(deps, user.userId, now, mode);
  } catch (e) {
    // 错误对象可能带连接信息、SQL，不打印；只记我们自己的码
    return e instanceof ExportError ? await fail(`export_${e.message}`, false) : await fail('db_error', true);
  }

  // ⑤ 响应之后发通知；发信失败另记一条（不当作“没导出”）
  const proxy = readProxyHeaders(req, deps.proxySecret);
  deps.background((async () => {
    let sent = false;
    try {
      const [info, label] = await Promise.all([
        mailInfo(deps, user.userId),
        deviceId ? store.deviceLabel(user.userId, deviceId).catch(() => null) : Promise.resolve(null),
      ]);
      if (info) sent = await deps.sendMail(info.email, exportMail(info.loc, now, info.tz, cleanDeviceLabel(label), proxy.geo)).catch(() => false);
    } catch {
      sent = false;
    }
    if (!sent) {
      deps.log?.('mail_failed:export');
      // t 是发信失败的时刻；code 写 export 那一行的 t（ISO），同一台设备连着导出两次也配得准
      //   （logs 没有唯一约束，两种都行；不让两行 t 相同，是为了留下失败时刻，t 也照旧是“发生时刻”）
      await store.insertLog(user.userId, {
        t: deps.now(), device: deviceId, kind: 'run', act: 'export_mail_failed', src: 'account', code: new Date(now).toISOString(),
      })
        .catch(() => deps.log?.('export_mail_log_failed'));
    }
  })());

  return new Response(gz, {
    status: 200,
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="lemomemo-export-${utcDate(now)}.json.gz"`,
      'x-content-type-options': 'nosniff',
      ...NO_STORE,
    },
  });
}
