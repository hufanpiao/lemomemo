// 登记或复用本会话的 devices 行（架构 0.38 第 62 条④、0.29 续第 99、104、109 条、4.1；接手清单 K8-tz-device）
// • 行 id 存进本机库的 meta（键 device = {id, session, ok}）：退出登录、换账号、被移除时随整库清掉，下次登录换新 id（第 99 条③：只 insert 新行，不认领旧行）
// • session_id 由服务器触发器按 JWT 填（devices_session_guard），客户端不传；本会话的行 = 服务器上 session_id 等于本机令牌里 session_id 的那一行
// • 顺序：
//   ① meta 里记的就是本会话的、已确认 → 直接用（离线也行）
//   ② meta 里记的是本会话的、insert 还没确认（上次断网、页面关了）→ 用同一个 id 再 insert 一次（upsert 忽略重复，幂等）
//   ③ 没记、或记的是别的会话（重新验证邮箱后 rebind_device 把这一行交接给了新会话，第 104 条，id 不变；或 meta 被迁移失败清掉）→
//      先拉一次本人的 devices（RLS 只给本人的，几行），有 session_id 等于本会话、没软删除的行就复用；
//      没有才生成新 id，先记进 meta（ok = false）再 insert，insert 成功记 ok = true
// • 失败（断网、session_revoked、库已关……）不抛、不提示，返回 null；之后最快隔 DEVICE_RETRY_MS 再试（调用方在拿到锁、用户操作、恢复网络时调）。
//   被移除、被停用由同步引擎和 outbox 处理，这里不管
// • 刷新 last_seen_at、app_version（K4 审查 3）：登记好以后每天最多一次经 apply_patch 改这两列；本机版本比 meta 里记的新（按 semver）时马上刷
//   （devices 的 update 授权有这两列、table_meta 的 no_conflict 也有，base_rev 填 1 不会判冲突）；刷新时刻、版本记在 meta 的 seenAt、ver。
//   本机版本比记的旧（新旧两个版本的标签页轮流当主页）：只刷 last_seen_at，不把 app_version 改回旧的，ver 也不回退（K4 复核建议 1）。
//   刷新前在锁里重读一次 meta（别的标签页刚刷过就不再刷）。不刷新的话一直在用的设备满 150 天会在设置 › 设备被标“很久没用”
//   （lastActive 只看 last_seen_at 和 created_at）。网络等失败隔 DEVICE_RETRY_MS 再试；回 not_found / gone（行被移除、软删除）
//   清掉 meta 里的 device，下一轮重新登记（登记照旧 60 秒节流，K4 复核建议 3）
// • 只在主页（拿到同步锁的页面）调；另外整段包在 deps.lock 里（navigator.locks 'lemo-device-reg:<user_id>'，K4 审查 4），
//   主页交接的空档里两个页面也不会各插一行；没有 locks 时，生成新 id 之前再读一次 meta 兜底
// 纯 TS：不准 import React 和任何功能（A1）；不准直接联网（A12：网络经注入的 transport）
import { compareVersions, parseVersion } from '../../shared/core/version.ts';
import type { Cache, DeviceMeta } from './cache.ts';
import type { NetResult, SyncLog, SyncTransport } from './sync/types.ts';

export const DEVICE_RETRY_MS = 60_000;
/** last_seen_at 至少隔这么久刷新一次 */
export const DEVICE_TOUCH_MS = 24 * 60 * 60 * 1000;
/** 找本会话那一行时一次拉多少行（一个人的设备行只有几行） */
export const DEVICE_LOOKUP_LIMIT = 200;

export interface DeviceRegDeps {
  transport: Pick<SyncTransport, 'insertRow' | 'pullRows' | 'applyPatch'>;
  cache: Pick<Cache, 'getMeta' | 'setMeta' | 'deleteMeta'>;
  /** 本机令牌里的 session_id（platform/session.ts 的 readSessionId）；读不到时不登记 */
  sessionId(): string | null;
  /** 这一份安装的 install_id（platform/device-info.ts 的 readInstallId）；null 时这一列留空 */
  installId(): string | null;
  /** devices.platform：ios / windows / web / tauri */
  platform: string;
  appVersion: string;
  /** 跨标签页互斥（platform/device-info.ts 的 withLock）；不给就直接跑 */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  newId?: () => string;
  now?: () => number;
  /** 记 device_reg_failed（0.38 第 67 条③）：coll = devices，code = 服务器错误码或 http_<状态码>；断网不记，同一个 code 只记一次 */
  log?: SyncLog;
}

export interface DeviceRegistrar {
  /** 已确认的本会话设备行 id；还没登记好时为 null（同步读内存，便宜） */
  id(): string | null;
  /** 登记或复用（顺带按天刷新 last_seen_at、app_version）；成功返回行 id，失败或还在重试间隔里返回 null。不抛 */
  ensure(): Promise<string | null>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 服务器上本会话、没软删除的那一行的 id；没有为 null；拉取失败为 undefined（失败交给 onFail 记日志） */
async function lookupRow(
  transport: Pick<SyncTransport, 'pullRows'>, sid: string, onFail: (r: NetResult<unknown>) => void,
): Promise<string | null | undefined> {
  const r = await transport.pullRows('devices', { since: null, after: null, limit: DEVICE_LOOKUP_LIMIT });
  if (!r.ok) {
    onFail(r);
    return undefined;
  }
  for (const raw of r.value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const id = str(row['id']);
    if (id && str(row['session_id'])?.toLowerCase() === sid.toLowerCase() && (row['deleted_at'] ?? null) === null) return id;
  }
  return null;
}

export function createDeviceRegistrar(deps: DeviceRegDeps): DeviceRegistrar {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const lock = deps.lock ?? (<T>(fn: () => Promise<T>) => fn());
  let mem: DeviceMeta | null = null;
  let inflight: Promise<string | null> | null = null;
  let failedAt: number | null = null;
  let touchFailedAt: number | null = null;
  const loggedCodes = new Set<string>();

  /** 登记失败记一次日志：断网不记；同一个页面（这个 registrar）同一个 code 只记一次 */
  const logFail = (r: NetResult<unknown>): void => {
    if (r.ok || r.error.network || !deps.log) return;
    const code = r.error.code ?? `http_${r.error.status ?? 0}`;
    if (loggedCodes.has(code)) return;
    loggedCodes.add(code);
    deps.log('device_reg_failed', { coll: 'devices', code });
  };

  /** 本机版本比 v 新（v 没有或认不出也算新；本机版本认不出算不新） */
  const newerThan = (v: string | undefined): boolean => {
    if (!parseVersion(deps.appVersion)) return false;
    if (v === undefined || !parseVersion(v)) return true;
    return compareVersions(deps.appVersion, v) > 0;
  };

  const touchDue = (t: number): boolean =>
    !!mem?.ok
    && !(touchFailedAt !== null && t - touchFailedAt < DEVICE_RETRY_MS)
    && (mem.seenAt === undefined || t - mem.seenAt >= DEVICE_TOUCH_MS || newerThan(mem.ver));

  const lookup = (sid: string): Promise<string | null | undefined> => lookupRow(deps.transport, sid, logFail);

  const confirm = async (rec: DeviceMeta): Promise<string> => {
    const ok: DeviceMeta = { ...rec, ok: true };
    await deps.cache.setMeta('device', ok);
    mem = ok;
    failedAt = null;
    return ok.id;
  };

  async function register(sid: string): Promise<string | null> {
    let rec = (await deps.cache.getMeta('device')) ?? null;
    if (rec && rec.session === sid && rec.ok) {
      mem = rec;
      return rec.id;
    }
    if (!rec || rec.session !== sid) {
      const found = await lookup(sid);
      if (found === undefined) return null;
      if (found) return confirm({ id: found, session: sid, ok: true });   // seenAt 没有：随后马上刷新一次
      // 没有 navigator.locks 时的兜底：拉取期间别的页面可能已经登记了，生成新 id 之前再读一次 meta
      const again = (await deps.cache.getMeta('device')) ?? null;
      if (again && again.session === sid) {
        if (again.ok) {
          mem = again;
          return again.id;
        }
        rec = again;
      } else {
        rec = { id: newId(), session: sid, ok: false };
        await deps.cache.setMeta('device', rec);   // 先记 id：insert 成功但回包丢了，下次用同一个 id 重发
      }
    }
    const t = now();
    const r = await deps.transport.insertRow('devices', {
      id: rec.id,
      platform: deps.platform,
      install_id: deps.installId(),
      app_version: deps.appVersion,
      last_seen_at: new Date(t).toISOString(),
    });
    if (r.ok) return confirm({ ...rec, seenAt: t, ver: deps.appVersion });
    logFail(r);
    if (r.error.code === 'insert_conflict') {
      // 这个 id 在服务器上已有、却读不到（不是本人的）：换一个新 id，下次再试
      await deps.cache.setMeta('device', { id: newId(), session: sid, ok: false });
    }
    return null;
  }

  /** 刷新 last_seen_at（本机版本不旧于记的才带 app_version）；行已不在（not_found、gone）时清掉 meta 里的 device、返回 false */
  async function touch(): Promise<boolean> {
    const m = mem;
    if (!m?.ok) return true;
    const t = now();
    const withVer = m.ver === undefined || newerThan(m.ver) || m.ver === deps.appVersion;
    const r = await deps.transport.applyPatch({
      p_table: 'devices',
      p_id: m.id,
      p_patch: withVer ? { last_seen_at: new Date(t).toISOString(), app_version: deps.appVersion } : { last_seen_at: new Date(t).toISOString() },
      p_base_rev: 1,
      p_op_id: newId(),
      p_own_revs: [],
    });
    if (r.ok && (r.value.status === 'not_found' || r.value.status === 'gone')) {
      mem = null;
      touchFailedAt = null;
      failedAt = now();   // 重新登记照旧 60 秒节流
      await deps.cache.deleteMeta('device');
      return false;
    }
    if (!r.ok || r.value.status !== 'ok') {
      touchFailedAt = now();
      return true;
    }
    const next: DeviceMeta = { ...m, seenAt: t, ver: withVer ? deps.appVersion : (m.ver ?? deps.appVersion) };
    mem = next;
    touchFailedAt = null;
    await deps.cache.setMeta('device', next);
    return true;
  }

  async function run(sid: string): Promise<string | null> {
    if (mem?.ok) {
      // 锁里重读 meta：别的标签页当主页时可能刚刷过（seenAt、ver 更新），或已清掉 / 换了这条记录
      const cur = (await deps.cache.getMeta('device')) ?? null;
      if (cur?.ok && cur.id === mem.id) mem = cur;
      else mem = null;
    }
    const id = mem?.ok ? mem.id : await register(sid);
    if (id && touchDue(now())) {
      try {
        if (!(await touch())) return null;
      } catch {
        touchFailedAt = now();   // 刷新失败不影响 id
      }
    }
    return id;
  }

  return {
    id: () => (mem?.ok ? mem.id : null),
    ensure() {
      if (inflight) return inflight;
      const t = now();
      if (mem?.ok) {
        if (!touchDue(t)) return Promise.resolve(mem.id);
      } else if (failedAt !== null && t - failedAt < DEVICE_RETRY_MS) {
        return Promise.resolve(null);
      }
      const sid = deps.sessionId();
      if (!sid) return Promise.resolve(mem?.ok ? mem.id : null);
      inflight = lock(() => run(sid))
        .catch(() => (mem?.ok ? mem.id : null))   // 库已关（换账号、清库中）等：不管
        .then((id) => {
          if (id === null) failedAt = now();
          return id;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
