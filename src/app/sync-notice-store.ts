// 冲突提示的队列（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 3.1、4.1、4.2、4.4）：gate（sync-notice-gate.ts）收到的事件、
// 读到的 gone 项在这里合并、排队；宿主经 SyncNoticeStore 读快照、点按。纯逻辑，不碰 DOM，测试直接调
// • 冲突按 table:id 合并：conflicts 取并集，old 逐列取最新（L1）；名单外的表不出卡（H2）
// • gone 从 outbox.list() 读 failed && error === 'gone'，按记录分组（H1），data 按 seq 后写覆盖先写（只用来判 undone、取标题）；
//   名单外的静默 drop、记 sync_gone_drop（只记 coll）；合并后 undone === true 的同样 drop，不出卡（M1）
// • 刚恢复的那一项按 resolveGone 返回的 opId 认，连续两次读队列都不在才不再认（4.4，复审四 L1）：
//   回 conflict 去掉 deleted_at、undone，剩下为空不出卡；回 forked 不出卡（P1）；rejected / not_found 出轻提示（P2）
// • 按钮结果照 4.2：restored / dropped / nothing 收起；local_unavailable、closing 卡留着换“没能恢复”；switching 不提示；
//   rejected（restore）只剩“不用了”、记 sync_gone_restore_fail（coll、code）
import { FORK_SUFFIX } from '../../shared/sync/fork-suffix-data.ts';
import type { BootResult } from '../core/boot.ts';
import type { OutboxEvent, OutboxItem } from '../core/outbox-types.ts';
import type { SyncEvent, SyncLog } from '../core/sync/types.ts';
import type { ResolveGoneResult } from '../core/write-gone.ts';
import {
  NOTICE_TABLES,
  type ConflictNotice, type GoneNotice, type GoneStatus, type NoticeSnapshot, type NoticeTable, type SyncNoticeStore,
} from '../features/sync-notice/index.ts';

export function isNoticeTable(table: string): table is NoticeTable {
  return (NOTICE_TABLES as readonly string[]).includes(table);
}

/** 卡上的标题：分类、纪念日取 name，其余取 title；去掉首尾空白，取不到或为空返回 null（卡上写“这一条”） */
export function titleOf(table: NoticeTable, row: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const v = row?.[table === 'categories' || table === 'anniversaries' ? 'name' : 'title'];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export type Row = Readonly<Record<string, unknown>>;
export type Mode = 'restore' | 'drop';

export interface NoticeStoreDeps {
  outbox: { list(): Promise<OutboxItem[]> };
  /** 本机这一行（view，没有就 server）：取标题用；读不到为 null */
  readRow(table: string, id: string): Promise<Row | null>;
  resolveGone(table: string, id: string, mode: Mode): Promise<ResolveGoneResult>;
  log?: SyncLog | undefined;
  /** forked 说明里的后缀（已 trim）；null = 宿主按界面语言取 */
  forkSuffix: string | null;
}

export interface NoticeStore extends SyncNoticeStore {
  /** 重读 gone 项（读的时候又来了通知：读完再读一遍） */
  readGone(): Promise<void>;
  onSync(e: SyncEvent): void;
  onOutbox(e: OutboxEvent): void;
  close(): void;
}

/** 恢复项回 conflict 时不算冲突的列（4.4：服务器照样已恢复了这一行） */
const RESTORE_COLS: readonly string[] = ['deleted_at', 'undone'];
/** 下载 write-gone 失败、resolveGone 抛错：按临时失败处理（卡留着，可以再点） */
const UNAVAILABLE: ResolveGoneResult = { ok: false, reason: 'local_unavailable' };

/** gone 项按记录分组（H1）：data 按 seq 后写覆盖先写 */
interface GoneGroup {
  table: string;
  id: string;
  merged: Record<string, unknown>;
  /** 这一组 gone 项的 op_id（按 seq，用“|”连起来）：认“已处理过的是不是同一批”用 */
  sig: string;
}

function goneGroups(items: readonly OutboxItem[]): Map<string, GoneGroup> {
  const out = new Map<string, GoneGroup>();
  for (const it of [...items].sort((a, b) => a.seq - b.seq)) {
    if (it.state !== 'failed' || it.error !== 'gone') continue;
    const g = out.get(it.rec) ?? { table: it.table, id: it.id, merged: {}, sig: '' };
    Object.assign(g.merged, it.data);
    g.sig = g.sig ? `${g.sig}|${it.op_id}` : it.op_id;
    out.set(it.rec, g);
  }
  return out;
}

/** 同一条记录的冲突合并（L1）：conflicts 取并集，old 逐列以最新的为准；有过一次 forked 就算 forked */
function mergeConflict(
  prev: ConflictNotice | undefined, e: Extract<SyncEvent, { type: 'conflict' }>, table: NoticeTable, cols: readonly string[], title: string | null,
): ConflictNotice {
  return {
    kind: 'conflict', key: `${table}:${e.id}`, table, id: e.id,
    status: e.status === 'forked' || prev?.status === 'forked' ? 'forked' : 'conflict',
    conflicts: [...new Set([...(prev?.conflicts ?? []), ...cols])],
    old: prev?.old || e.old ? { ...prev?.old, ...e.old } : null,
    forkId: e.forkId ?? prev?.forkId ?? null,
    title,
  };
}

/** 点按失败后卡的状态（4.2）：换账号不提示（页面随即重载）；restore 被拒收只剩“不用了”；其余临时失败换“没能恢复”。原来已是 blocked 的保持 */
function failStatus(reason: string, mode: Mode, before: GoneStatus): GoneStatus {
  if (before === 'blocked') return 'blocked';
  if (reason === 'switching') return 'idle';
  return reason === 'rejected' && mode === 'restore' ? 'blocked' : 'retry';
}

/** 同一时间只跑一次 fn；跑的时候又被叫：跑完再跑一遍（读 gone 时又来了通知）。出错吞掉（库已关：换账号、清库中，下一次通知再读） */
function serial(fn: () => Promise<void>, closed: () => boolean): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (closed()) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await fn().catch(() => undefined);
      } while (again && !closed());
    })().finally(() => {
      running = null;
    });
    return running;
  };
}

/** 逐个通知、各自兜底（代码审查 K8 界面批 L2）：一个抛错不挡后面的；错误放到微任务里再抛，照样进全局错误上报 */
function notifyAll(listeners: ReadonlySet<() => void>): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (e) {
      queueMicrotask(() => {
        throw e;
      });
    }
  }
}

/** 排队、合并、刚恢复的认法都在这里（纯逻辑，不碰 DOM；测试直接调） */
export function createNoticeStore(deps: NoticeStoreDeps): NoticeStore {
  const conflicts = new Map<string, ConflictNotice>();
  let gones = new Map<string, GoneNotice>();
  /** 刚恢复的那一项：op_id → 连续几次读队列没看到它 */
  const restored = new Map<string, number>();
  /**
   * 按过按钮、处理成功的记录 → 当时那一批 gone 项的 sig（代码审查 K8 界面批 M2）：读队列时那一批还在（删除和读队列赛跑）就先不出卡；
   * 换了一批（恢复后在途项又回 gone、别的修改又 gone）照常出卡。不按记录一刀切地藏，免得卡永远不出、gone 项一直挡着这条记录后面的同步
   */
  const handled = new Map<string, string>();
  /** 当前每条 gone 卡对应的那一批的 sig */
  const sigs = new Map<string, string>();
  const dropping = new Set<string>();
  const listeners = new Set<() => void>();
  let hardDeleted = 0;
  let closed = false;
  let snap: NoticeSnapshot = { queue: [], hardDeleted: 0, forkSuffix: deps.forkSuffix };

  const emit = (): void => {
    if (closed) return;
    snap = { queue: [...conflicts.values(), ...gones.values()], hardDeleted, forkSuffix: deps.forkSuffix };
    notifyAll(listeners);
  };
  const call = (table: string, id: string, mode: Mode): Promise<ResolveGoneResult> =>
    deps.resolveGone(table, id, mode).catch(() => UNAVAILABLE);
  const log = (act: string, f: { coll: string; code?: string }): void => {
    try {
      deps.log?.(act, f);
    } catch {
      // 日志出错不挡提示
    }
  };
  const titleFor = async (table: NoticeTable, id: string, data: Row | null): Promise<string | null> =>
    titleOf(table, data) ?? titleOf(table, await deps.readRow(table, id).catch(() => null));

  /** 静默丢掉（名单外的表、撤销类的修改）：同一条在办时不重复调；名单外的记 sync_gone_drop */
  const dropQuiet = (table: string, id: string, logIt: boolean): void => {
    const key = `${table}:${id}`;
    if (dropping.has(key)) return;
    dropping.add(key);
    void call(table, id, 'drop')
      .then((r) => {
        if (logIt && r.ok && r.done === 'dropped') log('sync_gone_drop', { coll: table });
      })
      .finally(() => dropping.delete(key));
  };

  const readOnce = async (): Promise<void> => {
    const items = await deps.outbox.list();
    if (closed) return;
    const present = new Set(items.map((i) => i.op_id));
    for (const [op, miss] of restored) {
      if (present.has(op)) restored.set(op, 0);
      else if (miss + 1 >= 2) restored.delete(op);
      else restored.set(op, miss + 1);
    }
    const groups = goneGroups(items);
    for (const [key, sig] of [...handled]) if (groups.get(key)?.sig !== sig) handled.delete(key);
    const next = new Map<string, GoneNotice>();
    for (const [key, g] of groups) {
      const { table, id, merged } = g;
      if (!isNoticeTable(table)) {
        dropQuiet(table, id, true);
        continue;
      }
      if (merged['undone'] === true) {
        dropQuiet(table, id, false);
        continue;
      }
      if (handled.get(key) === g.sig) continue;
      sigs.set(key, g.sig);
      const prev = gones.get(key);
      next.set(key, prev ?? { kind: 'gone', key, table, id, title: await titleFor(table, id, merged), status: 'idle' });
      if (closed) return;
    }
    gones = next;
    emit();
  };

  const readGone = serial(readOnce, () => closed);

  const setStatus = (key: string, status: GoneStatus): void => {
    const g = gones.get(key);
    if (!g) return;
    gones.set(key, { ...g, status });
    emit();
  };

  const resolve = (key: string, mode: Mode): void => {
    const g = gones.get(key);
    if (!g || g.status === 'busy' || (mode === 'restore' && g.status === 'blocked')) return;
    const before = g.status;
    setStatus(key, 'busy');
    void call(g.table, g.id, mode).then((r) => {
      if (closed) return;
      if (r.ok && r.done === 'nothing') {
        // 没找到要处理的（集合刚变过）：不记“已处理”，按队列现在的样子重读一次
        setStatus(key, before);
        void readGone();
        return;
      }
      if (r.ok) {
        gones.delete(key);
        const sig = sigs.get(key);
        if (sig !== undefined) handled.set(key, sig);
        if (r.done === 'restored' && r.opId) restored.set(r.opId, 0);
        emit();
        return;
      }
      if (r.reason === 'rejected' && mode === 'restore') log('sync_gone_restore_fail', { coll: g.table, ...(r.code ? { code: r.code } : {}) });
      setStatus(key, failStatus(r.reason, mode, before));
    });
  };

  const onConflict = (e: Extract<SyncEvent, { type: 'conflict' }>): void => {
    const { table, id } = e;
    if (!isNoticeTable(table)) return;
    let cols = e.conflicts;
    if (restored.has(e.opId)) {
      if (e.status === 'forked') return;   // 刚恢复的随手记又 forked：副本照常保留，不再弹卡（P1）
      cols = cols.filter((c) => !RESTORE_COLS.includes(c));
      if (cols.length === 0) return;
    }
    const key = `${table}:${id}`;
    void titleFor(table, id, null).then((title) => {
      if (closed) return;
      conflicts.set(key, mergeConflict(conflicts.get(key), e, table, cols, title));
      emit();
    });
  };

  return {
    getState: () => snap,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    restore: (key) => resolve(key, 'restore'),
    drop: (key) => resolve(key, 'drop'),
    dismiss: (key) => {
      if (conflicts.delete(key)) emit();
    },
    readGone,
    onSync: (e) => {
      if (closed) return;
      if (e.type === 'conflict') onConflict(e);
      else void readGone();
    },
    onOutbox: (e) => {
      if (closed || e.type !== 'rejected' || e.code !== 'not_found' || !restored.has(e.item.op_id)) return;
      restored.delete(e.item.op_id);
      hardDeleted += 1;
      emit();
    },
    close: () => {
      closed = true;
      conflicts.clear();
      gones.clear();
      restored.clear();
      handled.clear();
      sigs.clear();
      listeners.clear();
    },
  };
}

/** forked 说明的后缀：按本机缓存的 profiles.ui_locale 选（和服务器选后缀用的同一个值），去掉首尾空白；缓存里没有返回 null */
export function forkSuffixOf(boot: Pick<BootResult, 'profile'>): string | null {
  const loc = boot.profile?.ui_locale;
  return loc === 'zh-CN' || loc === 'ko-KR' ? FORK_SUFFIX[loc].trim() : null;
}
