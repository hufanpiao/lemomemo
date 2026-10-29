// 设备登记测试用的假服务器：只模拟 devices 表和 report_tz 里和设备行有关的几条规则（迁移 0001、20261029192000）
// • insert：session_id 由“触发器”按当前 JWT 的会话填（客户端传的不信）；会话已吊销回 session_revoked；同 id 已在：本人的回 rev（幂等），别人的回 insert_conflict
// • 拉取：只回本人的行（RLS）
// • apply_patch（devices）：upd 策略只放本人、本会话的那一行（看不到回 not_found）；会话已吊销回 session_revoked；只改 label、app_version、last_seen_at
// • report_tz：只认本人、本会话的那一行，否则 device_mismatch；平台和行里登记的不一致回 platform_mismatch
import type { NetResult, PatchArgs, PatchResponse, PullQuery, SyncTransport, TzReportResult } from '../sync/types.ts';

export interface FakeDeviceRow {
  id: string;
  user_id: string;
  session_id: string | null;
  platform: string;
  install_id: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  deleted_at: number | null;
  rev: number;
}

export const S1 = '11111111-1111-4111-8111-111111111111';
export const S2 = '22222222-2222-4222-8222-222222222222';
export const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const NET = { ok: false as const, error: { network: true } };

export class FakeDeviceServer implements Pick<SyncTransport, 'insertRow' | 'pullRows' | 'applyPatch' | 'reportTz'> {
  rows: FakeDeviceRow[] = [];
  /** 当前令牌里的会话 */
  session: string = S1;
  user: string = ME;
  revoked = new Set<string>();
  offline = false;
  /** 下一次 insert 服务器照常写入，但回包丢了（客户端看到断网） */
  dropNextReply = false;
  calls: string[] = [];
  patches: PatchArgs[] = [];
  tz: { tz: string; device: string; platform: string }[] = [];

  async insertRow(table: string, data: Readonly<Record<string, unknown>>): Promise<NetResult<{ rev: number }>> {
    this.calls.push(`insert:${table}`);
    if (this.offline) return NET;
    if (this.revoked.has(this.session)) return { ok: false, error: { status: 400, code: 'session_revoked' } };
    const id = String(data['id']);
    const had = this.rows.find((r) => r.id === id);
    if (had) return had.user_id === this.user ? { ok: true, value: { rev: had.rev } } : { ok: false, error: { status: 409, code: 'insert_conflict' } };
    const str = (k: string): string | null => (typeof data[k] === 'string' ? (data[k] as string) : null);
    this.rows.push({
      id, user_id: this.user, session_id: this.session, platform: str('platform') ?? '', install_id: str('install_id'),
      app_version: str('app_version'), last_seen_at: str('last_seen_at'), deleted_at: null, rev: 1,
    });
    if (this.dropNextReply) {
      this.dropNextReply = false;
      return NET;
    }
    return { ok: true, value: { rev: 1 } };
  }

  async pullRows(table: string, q: PullQuery): Promise<NetResult<unknown[]>> {
    this.calls.push(`pull:${table}`);
    if (this.offline) return NET;
    return { ok: true, value: this.rows.filter((r) => r.user_id === this.user).slice(0, q.limit).map((r) => ({ ...r })) };
  }

  async applyPatch(a: PatchArgs): Promise<NetResult<PatchResponse>> {
    this.calls.push(`patch:${a.p_table}`);
    this.patches.push(a);
    if (this.offline) return NET;
    if (this.revoked.has(this.session)) return { ok: false, error: { status: 400, code: 'session_revoked' } };
    const row = this.rows.find((r) => r.id === a.p_id && r.user_id === this.user && r.session_id === this.session);
    if (!row) return { ok: true, value: { status: 'not_found', rev: 0, prev_rev: null } };
    if (row.deleted_at !== null) return { ok: true, value: { status: 'gone', rev: row.rev, prev_rev: row.rev } };
    const prev = row.rev;
    for (const k of ['app_version', 'last_seen_at'] as const) {
      const v = a.p_patch[k];
      if (typeof v === 'string') row[k] = v;
    }
    row.rev = prev + 1;
    return { ok: true, value: { status: 'ok', rev: row.rev, prev_rev: prev } };
  }

  async reportTz(tz: string, device: string, platform: string): Promise<NetResult<TzReportResult>> {
    this.calls.push('report_tz');
    if (this.offline) return NET;
    const row = this.rows.find((r) => r.id === device && r.user_id === this.user && r.session_id === this.session);
    if (!row) return { ok: false, error: { status: 400, code: 'device_mismatch' } };
    if (row.platform !== platform) return { ok: false, error: { status: 400, code: 'platform_mismatch' } };
    this.tz.push({ tz, device, platform });
    return { ok: true, value: 'pending' };
  }

  /** 本会话、没软删除的行 */
  mine(): FakeDeviceRow[] {
    return this.rows.filter((r) => r.user_id === this.user && r.session_id === this.session && r.deleted_at === null);
  }
}

/** 内存里的 meta（只有 device 这个键） */
export function memMeta() {
  const m = new Map<string, unknown>();
  return {
    m,
    closed: false,
    getMeta<T>(k: string): Promise<T | undefined> {
      return Promise.resolve(m.get(k) as T | undefined);
    },
    setMeta(k: string, v: unknown): Promise<void> {
      if (this.closed) return Promise.reject(new Error('cache_closed'));
      m.set(k, v);
      return Promise.resolve();
    },
    deleteMeta(k: string): Promise<void> {
      if (this.closed) return Promise.reject(new Error('cache_closed'));
      m.delete(k);
      return Promise.resolve();
    },
  };
}
