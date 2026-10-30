// account 的 export action 的 start 一步和两步共用的挑表、隐私记过滤（ACCOUNT-sugg ①：从 core.ts 拆出；流程见 core.ts 文件头）。
// start：预检前三道闸 → 大小预检 → 扣当天次数 → 建任务 → 写 logs → 响应之后发导出通知；不读任何用户数据（架构 0.47 续 ①“开始”）。
// part（取一片）在 export-part.ts。对外经 core.ts 转出。

import { exportMail } from '../_shared/account-mail.ts';
import { readProxyHeaders } from '../_shared/proxy-headers.ts';
import {
  ACCOUNT_DAILY_LIMIT, type ActiveUser, DAY_S, DbError, type Deps, err, type ExportTable, exportLimits, json, keys, mailInfo, type VaultMode,
} from './common.ts';

// ---------------- 常量（出处见行尾） ----------------
/** 导出临时性失败每人每天最多退回 3 次，超过就照常扣（K3 复审低 2；键 export-refund:<user_id>:<UTC 日期>，和 account 键同一天口径） */
export const EXPORT_REFUND_DAILY_LIMIT = 3;
export const EXPORT_MAX_ROWS = 25_000;         // 同步表每张上限 2 万行（row_quota），多读一点余量；超过就当数据异常
/** logs 不受 row_quota 管：每人每天最多 2,000 条、保留 90 天（第 6 节 logs、3.4），最多约 18 万行，再加 2 万行余量 */
export const EXPORT_MAX_LOG_ROWS = 2000 * 90 + 20_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        // logs 是 bigserial，profiles 是本人的 user_id，其余 export: json 的表都是 uuid 主键（0001～0005）；新表主键不是 uuid 时在这里加
        keyType: t.name === 'profiles' ? ('self' as const) : t.name === 'logs' ? ('int' as const) : ('uuid' as const),
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

// ---------------- 隐私记过滤（start 不用，part 用；和 export_size_over 的过滤一致） ----------------
/** 导出中途失败的原因（写进日志的码是 export_<它>） */
export class ExportError extends Error {}

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

// ---------------- start（开始一次导出） ----------------
/**
 * 隐私记令牌定模式（第 93、94 条；start、part 都用）：没带 → omitted；带了就必须有效，否则 401 vault_locked / vault_relock
 */
export async function vaultMode(req: Request, user: ActiveUser, deps: Deps): Promise<VaultMode | Response> {
  const token = req.headers.get('x-vault-token');
  if (token === null) return 'omitted';
  if (token === '' || token.length > 2048) return err(401, 'vault_locked');
  const v = await deps.verifyVaultToken(user.userId, token);
  return v === 'ok' ? 'cipher' : err(401, v);
}

/** 预检被拒、超时、忙、限流：只记函数日志（user_id 的哈希和耗时毫秒，不带数据；不写 logs 表、不发信，Q4） */
async function sizeLog(deps: Deps, code: string, userId: string, startMs: number): Promise<void> {
  const h = deps.userHash ? await deps.userHash(userId).catch(() => '?') : '-';
  deps.log?.(`${code} u=${h} ms=${Math.max(0, deps.now() - startMs)}`);
}

export async function startExport(req: Request, body: Record<string, unknown>, user: ActiveUser, deps: Deps): Promise<Response> {
  const { store } = deps;
  const lim = exportLimits(deps);
  const deviceId = typeof body.device_id === 'string' && UUID.test(body.device_id) ? body.device_id.toLowerCase() : null;
  if (body.device_id !== undefined && body.device_id !== null && deviceId === null) return err(400, 'bad_request');

  // ① 隐私记令牌定模式（第 93、94 条）
  const mode = await vaultMode(req, user, deps);
  if (mode instanceof Response) return mode;

  // ② 预检前三道闸（0.47 第 19 条 Q1）：只读查当天导出次数 → 预检专用限流 → 预检函数里的全局锁
  const t0 = deps.now();
  const rateKey = keys.account(user.userId, t0);
  if ((await store.peekRate(rateKey)) >= ACCOUNT_DAILY_LIMIT) {
    await sizeLog(deps, 'export_size_rate_limited', user.userId, t0);
    return err(429, 'rate_limited');
  }
  const sizeKey = keys.exportSize(user.userId, t0);
  if (!(await store.takeRate(sizeKey, lim.sizeCheckDailyLimit, DAY_S))) {
    await sizeLog(deps, 'export_size_rate_limited', user.userId, t0);
    return err(429, 'rate_limited');
  }
  // ③ 大小预检（0.47 第 18 条）：超了 413、超时或忙或出错 try_later，都不扣导出次数、不建任务、不写 logs、不发信；回应里不带估算值
  let size: number;
  try {
    size = await store.exportSizeOver(user.userId, mode, lim.maxTotalRawBytes, lim.sizeCheckBudgetMs);
  } catch {
    await sizeLog(deps, 'export_size_failed', user.userId, t0);
    return err(503, 'try_later');
  }
  if (size === -2) {
    // 别人在预检：拿不到锁不算用掉一次预检（安全回查 R2：选“退回 export-size 这一次”，锁在函数里、拿锁和扣数分不到一个事务里）
    await store.refundRate(sizeKey).catch(() => deps.log?.('export_size_refund_failed'));
    await sizeLog(deps, 'export_size_busy', user.userId, t0);
    return err(503, 'try_later');
  }
  if (size < 0) {
    await sizeLog(deps, 'export_size_timeout', user.userId, t0);
    return err(503, 'try_later');
  }
  if (size > lim.maxTotalRawBytes) {
    await sizeLog(deps, 'export_size_rejected', user.userId, t0);
    return err(413, 'export_too_large');
  }

  // ④ 扣当天次数（和 delete 合计 3 次）
  if (!(await store.takeRate(rateKey, ACCOUNT_DAILY_LIMIT, DAY_S))) return err(429, 'rate_limited');
  // 扣了以后建任务、写 logs 失败（临时性）退回这一次（K3 安全审查必改 2），并尽力删掉已建的任务行（N2）；退回每天也有上限（K3 复审低 2）
  const exportId = (deps.newId ?? (() => crypto.randomUUID()))();
  const jobKey = keys.exportJob(user.userId, exportId, mode, user.sessionId);
  // keepJob：撞上已有的同名任务行（export_job_exists，23505）时那一行是别的导出的，不能删（TC-B1-138 ⑥）；
  //   其余失败（含超时：行可能已写进库、只是回应丢了）照旧尽力删，本次的 export_id 是新生成的，删到的只会是本次写的
  const fail = async (code: string, keepJob = false): Promise<Response> => {
    deps.log?.(code);
    if (keepJob) deps.log?.('export_job_exists');
    else await store.deleteCounterKey(jobKey).catch(() => deps.log?.('export_job_delete_failed'));
    try {
      if (await store.takeRate(keys.exportRefund(user.userId, t0), EXPORT_REFUND_DAILY_LIMIT, DAY_S)) await store.refundRate(rateKey);
      else deps.log?.('export_refund_capped');
    } catch {
      deps.log?.('export_refund_failed');
    }
    return err(503, 'try_later');
  };
  // ⑤ 建任务：开始时刻取数据库的 now()（文件头、回应、logs 的 t 都是这一刻）
  let startedAt: number;
  try {
    startedAt = Date.parse(await store.exportJobStart(user.userId, exportId, mode, user.sessionId));
    if (!Number.isFinite(startedAt)) throw new Error('bad_started_at');
  } catch (e) {
    return await fail('export_job_failed', e instanceof DbError && e.code === 'export_job_exists');
  }
  // ⑥ 记“发起了导出”（code = export_id；配不上 export_done 的，“最近的导出”标未完成）
  try {
    await store.insertLog(user.userId, { t: startedAt, device: deviceId, kind: 'run', act: 'export', src: 'account', code: exportId });
  } catch {
    return await fail('export_log_failed');
  }

  // ⑦ 响应之后发通知；发信失败另记一条（不当作“没导出”）
  exportNotice(req, user, deps, deviceId, startedAt);
  return json(200, { ok: true, export_id: exportId, exported_at: new Date(startedAt).toISOString() });
}

/** 导出通知（第 96 条）：响应之后发；发信失败另记一条 export_mail_failed（code = export 那一行 t 的 ISO） */
function exportNotice(req: Request, user: ActiveUser, deps: Deps, deviceId: string | null, at: number): void {
  const { store } = deps;
  const proxy = readProxyHeaders(req, deps.proxySecret);
  deps.background((async () => {
    let sent = false;
    try {
      const [info, label] = await Promise.all([
        mailInfo(deps, user.userId),
        deviceId ? store.deviceLabel(user.userId, deviceId).catch(() => null) : Promise.resolve(null),
      ]);
      if (info) sent = await deps.sendMail(info.email, exportMail(info.loc, at, info.tz, cleanDeviceLabel(label), proxy.geo)).catch(() => false);
    } catch {
      sent = false;
    }
    if (!sent) {
      deps.log?.('mail_failed:export');
      // t 是发信失败的时刻；code 写 export 那一行的 t（ISO），同一台设备连着导出两次也配得准
      await store.insertLog(user.userId, {
        t: deps.now(), device: deviceId, kind: 'run', act: 'export_mail_failed', src: 'account', code: new Date(at).toISOString(),
      })
        .catch(() => deps.log?.('export_mail_log_failed'));
    }
  })());
}
