// 同步测试用的假服务器和假传输（不是测试文件本身）
// apply_patch 按架构 4.4.1 的规格在内存里实现：
// • 参数检查：停用 → account_disabled；表不在白名单 → patch_table_not_allowed；patch 不是对象、base_rev < 1 → patch_bad_args（都不记 applied_ops）
// • 行被锁（locked）→ 55P03（不记 applied_ops）；op_id 重复原样回上次结果
// • 行没了 → not_found（rev、prev_rev 为 null）；已软删且 patch 不含 deleted_at → gone
// • 冲突字段 = {k ∈ patch | fv[k] > base_rev 且 fv[k] 不在 own_revs 里}（own_revs 超过 20 个当空）；有冲突照样应用回 conflict；
//   notes 的 title、body 冲突 → forked：原行只改 title、body 以外的键，另插一条“（冲突副本）”，返回 fork_id
// • 清单的 noConflict 列（notified_for、snooze_at、updated_at、sort）不报冲突
// • sameSynced = true 时新写的行都用同一个 synced_at（测同一时间戳跨页）；pullFailAt 让第 N 次 pullRows 失败（测翻页中途失败）
// 另有 engine 测试用的 bootOf、fakeLife
// 这只是“契约替身”：真正的冲突规则只在 SQL 里（4.4 第 7 条），真库契约测试由后端的 pgTAP 和 e2e 覆盖
import type { SendFailure, ServerRowInput } from '../../outbox-types.ts';
import type { BootResult } from '../../boot.ts';
import type { Cache } from '../../cache.ts';
import type { Outbox } from '../../outbox-types.ts';
import { createUpgradeCenter } from '../../upgrade.ts';
import type { Lifecycle } from '../../../platform/net.ts';
import type { ParseServerRows, PatchArgs, PatchResponse, PullQuery, RealtimeHandlers, SessionCheck, SyncTransport, TombstoneRow } from '../types.ts';

export interface FakeRow {
  id: string;
  rev: number;
  fv: Record<string, number>;
  deleted_at: number | null;
  synced_at: string;
  [col: string]: unknown;
}

const iso = (n: number): string => new Date(Date.UTC(2026, 9, 29, 0, 0, 0) + n * 1000).toISOString();

/** 4.4.1 的表白名单 */
export const PATCH_TABLES = ['events', 'todos', 'anniversaries', 'notes', 'note_images', 'note_files', 'categories', 'settings', 'devices'];

/** 清单里 noConflict 的列（shared/manifests：anniversaries 的 notified_for、snooze_at，notes 的 updated_at，categories 的 sort） */
export const NO_CONFLICT_COLS = ['notified_for', 'snooze_at', 'updated_at', 'sort'];

export class FakeServer {
  /** 新写的行都用同一个 synced_at */
  sameSynced = false;
  tables = new Map<string, Map<string, FakeRow>>();
  /** 账号停用、冷静期 */
  disabled = false;
  /** 这些 id 的行被别的事务锁着 */
  locked = new Set<string>();
  allowedTables = new Set(PATCH_TABLES);
  private forks = 0;
  tombstones: TombstoneRow[] = [];
  applied = new Map<string, PatchResponse>();
  private tick = 0;

  table(name: string): Map<string, FakeRow> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  nextSynced(): string {
    return this.sameSynced && this.tick > 0 ? iso(this.tick) : iso(++this.tick);
  }

  insert(table: string, data: Record<string, unknown>): FakeRow {
    const id = String(data['id']);
    const t = this.table(table);
    const old = t.get(id);
    if (old) return old;
    const fv: Record<string, number> = {};
    for (const k of Object.keys(data)) if (k !== 'id') fv[k] = 1;
    const row: FakeRow = { deleted_at: null, ...data, id, rev: 1, fv, synced_at: this.nextSynced() };
    t.set(id, row);
    return row;
  }

  /** 别的设备直接改（不经 outbox） */
  edit(table: string, id: string, patch: Record<string, unknown>): FakeRow {
    const row = this.table(table).get(id);
    if (!row) throw new Error('no row');
    const rev = row.rev + 1;
    const fv = { ...row.fv };
    for (const k of Object.keys(patch)) fv[k] = rev;
    const next: FakeRow = { ...row, ...patch, rev, fv, synced_at: this.nextSynced() };
    this.table(table).set(id, next);
    return next;
  }

  hardDelete(table: string, id: string): void {
    this.table(table).delete(id);
    this.tombstones.push({ tbl: table, id, deleted_at: this.nextSynced() });
  }

  /** 参数检查和锁：命中就是错误（不记 applied_ops）；status 照 PostgREST（raise exception → 400） */
  patchError(a: PatchArgs): SendFailure | null {
    if (this.disabled) return { status: 400, code: 'account_disabled' };
    if (!this.allowedTables.has(a.p_table)) return { status: 400, code: 'patch_table_not_allowed' };
    const p: unknown = a.p_patch;
    if (typeof p !== 'object' || p === null || Array.isArray(p) || (a.p_base_rev !== null && a.p_base_rev < 1)) {
      return { status: 400, code: 'patch_bad_args' };
    }
    if (!this.applied.has(a.p_op_id) && this.locked.has(a.p_id)) return { status: 500, code: '55P03' };
    return null;
  }

  applyPatch(a: PatchArgs): PatchResponse {
    const done = this.applied.get(a.p_op_id);
    if (done) return done;
    const t = this.table(a.p_table);
    const row = t.get(a.p_id);
    let res: PatchResponse;
    if (!row) res = { status: 'not_found', rev: null as unknown as number, prev_rev: null };
    else if (row.deleted_at !== null && !('deleted_at' in a.p_patch)) res = { status: 'gone', rev: row.rev, prev_rev: row.rev };
    else {
      const base = a.p_base_rev ?? 0;
      const own = a.p_own_revs.length > 20 ? [] : a.p_own_revs;
      const conflicts = Object.keys(a.p_patch).filter((k) => !NO_CONFLICT_COLS.includes(k) && (row.fv[k] ?? 0) > base && !own.includes(row.fv[k] ?? 0));
      const old = Object.fromEntries(conflicts.map((k) => [k, row[k]]));
      const fork = a.p_table === 'notes' && conflicts.some((k) => k === 'title' || k === 'body');
      const patch = fork ? Object.fromEntries(Object.entries(a.p_patch).filter(([k]) => k !== 'title' && k !== 'body')) : a.p_patch;
      const rev = row.rev + 1;
      const fv = { ...row.fv };
      for (const k of Object.keys(patch)) fv[k] = rev;
      t.set(a.p_id, { ...row, ...patch, rev, fv, synced_at: this.nextSynced() } as FakeRow);
      if (fork) {
        const forkId = `fork-${++this.forks}`;
        this.insert('notes', { id: forkId, title: `${String(a.p_patch['title'] ?? row['title'])}（冲突副本）`, body: a.p_patch['body'] ?? row['body'] });
        res = { status: 'forked', rev, prev_rev: row.rev, conflicts, old, fork_id: forkId };
      } else res = conflicts.length ? { status: 'conflict', rev, prev_rev: row.rev, conflicts, old } : { status: 'ok', rev, prev_rev: row.rev };
    }
    this.applied.set(a.p_op_id, res);
    return res;
  }

  rows(table: string): FakeRow[] {
    return [...this.table(table).values()].sort((x, y) => (x.synced_at === y.synced_at ? (x.id < y.id ? -1 : 1) : x.synced_at < y.synced_at ? -1 : 1));
  }
}

/** 测试里一律原样收下（宽容读取由 K7 的测试管） */
export const identityParse: ParseServerRows = (_table, raw) => ({
  rows: raw.flatMap((r) => (typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string' ? [{ row: r } as ServerRowInput] : [])),
  bad: [],
});

export interface FakeTransport extends SyncTransport {
  server: FakeServer;
  calls: string[];
  /** 下一次 applyPatch / insertRow 回这个失败（用完即清） */
  failNext: SendFailure[];
  /** applyPatch 发出、回结果之前调（模拟在途期间本机又改了） */
  beforeReply?: (a: PatchArgs) => Promise<void> | void;
  ensure: SessionCheck;
  refresh: SessionCheck[];
  handlers: RealtimeHandlers | null;
  subscribedTables: readonly string[] | null;
  unsubscribed: number;
  offline: boolean;
  /** 第几次 pullRows（从 1 数）回失败；failure 默认断网 */
  pullFailAt: { n: number; failure?: SendFailure } | null;
  pullCount: number;
  /** pullRows 的参数（测整表 since === null） */
  pullQueries: PullQuery[];
}

export function fakeTransport(server = new FakeServer()): FakeTransport {
  const net = { ok: false as const, error: { network: true } };
  const t: FakeTransport = {
    server,
    calls: [],
    failNext: [],
    ensure: 'ok',
    refresh: [],
    handlers: null,
    subscribedTables: null,
    unsubscribed: 0,
    offline: false,
    pullFailAt: null,
    pullCount: 0,
    pullQueries: [],
    ensureSession: () => Promise.resolve(t.offline ? 'network' : t.ensure),
    refreshSession: () => Promise.resolve(t.refresh.shift() ?? 'ok'),
    async insertRow(table, data) {
      t.calls.push(`insert:${table}:${String(data['id'])}`);
      if (t.offline) return net;
      const f = t.failNext.shift();
      if (f) return { ok: false, error: f };
      return { ok: true, value: { rev: server.insert(table, { ...data }).rev } };
    },
    async applyPatch(a) {
      t.calls.push(`patch:${a.p_table}:${a.p_id}`);
      if (t.offline) return net;
      const f = t.failNext.shift() ?? server.patchError(a);
      if (f) return { ok: false, error: f };
      const res = server.applyPatch(a);
      await t.beforeReply?.(a);
      return { ok: true, value: res };
    },
    async pullRows(table, q) {
      t.calls.push(`pull:${table}`);
      t.pullQueries.push(q);
      if (t.offline) return net;
      if (t.pullFailAt && ++t.pullCount === t.pullFailAt.n) return { ok: false, error: t.pullFailAt.failure ?? { network: true } };
      let rows = server.rows(table);
      if (q.since) rows = rows.filter((r) => r.synced_at >= (q.since ?? ''));
      if (q.after) {
        const a = q.after;
        rows = rows.filter((r) => r.synced_at > a.synced_at || (r.synced_at === a.synced_at && r.id > a.id));
      }
      return { ok: true, value: rows.slice(0, q.limit).map((r) => ({ ...r })) };
    },
    async fetchByIds(table, ids) {
      t.calls.push(`refetch:${table}`);
      if (t.offline) return net;
      return { ok: true, value: server.rows(table).filter((r) => ids.includes(r.id)) };
    },
    async pullTombstones(q) {
      t.calls.push('tombstones');
      if (t.offline) return net;
      let rows = [...server.tombstones];
      if (q.since) rows = rows.filter((r) => r.deleted_at >= (q.since ?? ''));
      if (q.after) {
        const a = q.after;
        rows = rows.filter((r) => r.deleted_at > a.deleted_at || (r.deleted_at === a.deleted_at && (r.tbl > a.tbl || (r.tbl === a.tbl && r.id > a.id))));
      }
      return { ok: true, value: rows.slice(0, q.limit) };
    },
    subscribe(tables, h) {
      t.subscribedTables = tables;
      t.handlers = h;
      return () => {
        t.unsubscribed++;
        t.handlers = null;
      };
    },
    fetchConfig: () => Promise.resolve({ ok: true, value: { config: null, profile: null } }),
    reportTz: () => Promise.resolve({ ok: true, value: 'pending' }),
  };
  return t;
}

/** engine 测试用：登录好、本机库可用的 BootResult */
export function bootOf(cache: Cache | null, outbox: Outbox | null, over: Partial<BootResult> = {}): BootResult {
  return {
    status: cache ? 'ready' : 'unavailable',
    userId: '00000000-0000-4000-8000-000000000100',
    switching: false,
    cache,
    outbox,
    upgrade: createUpgradeCenter({ appVersion: '4.0.0', reload: () => undefined, swUpdate: () => Promise.resolve('none' as never), attempt: { get: () => null, set: () => undefined } }),
    config: null,
    profile: null,
    flags: null,
    fullResync: [],
    refetch: {},
    switchedUser: false,
    purged: 0,
    upgradeReport: null,
    outboxReport: null,
    error: null,
    ...over,
  };
}

/** engine 测试用：可手动切前后台、上线的 Lifecycle；listeners 数用来查 stop 后有没有泄漏 */
export function fakeLife(visible = true): Lifecycle & { goOnline(): void; setVisible(v: boolean): void; listeners(): number } {
  const online = new Set<() => void>();
  const vis = new Set<(v: boolean) => void>();
  let isVis = visible;
  const add = <T>(set: Set<T>, f: T): (() => void) => {
    set.add(f);
    return () => {
      set.delete(f);
    };
  };
  return {
    onOnline: (f) => add(online, f),
    onVisibility: (f) => add(vis, f),
    isVisible: () => isVis,
    isOnline: () => true,
    goOnline: () => online.forEach((f) => f()),
    setVisible(v) {
      isVis = v;
      vis.forEach((f) => f(v));
    },
    listeners: () => online.size + vis.size,
  };
}
