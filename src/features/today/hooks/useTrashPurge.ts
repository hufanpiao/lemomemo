// “最近删除”页的永久删除和全部清空（B4 S9；TC-B4-17；0.29 续第 121 条⑧）：先弹确认，确认了才调 data/trash-purge-api.ts
// • 离线（navigator.onLine 为 false）：online 为 false，两个按钮灰掉、点了没反应（不进 outbox）；请求途中断网、超时报 offline
// • 单条：服务器回 0 条时看本机缓存里服务器那一份：还没删除（离线删的还没发上去）报 not_synced，这一条留着；
//   已经删除（之前删掉了、墓碑还没同步来）报 syncing“已删除，正在同步”，藏起来
// • 全部清空（代码审 11-11 必改）：只发列表里看得见、且服务器那一份也已删除的项（不传 null：本机刚恢复、恢复还没发上去的那条
//   不在列表里，也就不会被清掉）；确认框写的就是实际要发的条数，删除还没发上去的另写“这次先不清”；
//   超过 500 项分批发，每批条数对得上才藏这一批，对不上的、没发的都留着，给 partial 提示
// • 成功后先在界面上藏起这些行，本机的行等墓碑同步来删（0.29 续第 121 条⑤），不调 syncNow；
//   藏起来的记在模块里（按删除时间对上才藏），离开这页再回来也不会冒出来，墓碑来了行就真的没了
// • 只读行（要新版本，TC-B4-09“写入入口统一拦下”）：全部清空跳过它们（不发、留在列表里，确认框的条数不算它们、另写“会留下”），
//   跳过的条数记在 roN：清完的“已清空”、没清全的 partial / not_synced 后面接“另有 N 项要新版本才能删除，留在列表里”（页面拼）；
//   全是只读行时不弹确认、直接出 kept（“这 N 项要新版本才能删除，留在列表里”）。单条的拦截在页面上；
//   确认以后发请求前再按只读核一遍（确认框开着时变成只读的不发，增量复审 11-11）：单条出 readonly，清空时算进 roN
// • 期间 busy，重复点不重复发；页面在 busy 时把“恢复”也灰掉（请求在路上时恢复会被永久删掉，代码复审 11-11）
// • 确认时再按当前列表核一遍：弹确认前后恢复了的项（已不在列表里）不发
// • 先等恢复写完再定要发的项（代码复审 11-11）：settle 由页面给，等它点过、还没写完的“恢复”都写完；
//   全部清空等完了再按本机缓存核（服务器、本机两份都还是已删除才发），单条永久删除发请求前等完了再核本机这一份；核对期间 busy
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { localDeleted, purgeMany, purgeOne, serverDeleted, type PurgeErr, type PurgeKey, type PurgeManyResult, type PurgeResult, type PurgeTable } from '../data/trash-purge-api.ts';

export type PurgeConfirm = { kind: 'one'; table: PurgeTable; id: string } | { kind: 'all'; n: number; skip: number; ro: number; keys: PurgeKey[] };
export type PurgeMsg = 'purged' | 'cleared' | 'partial' | 'syncing' | 'readonly' | 'kept' | PurgeErr;

export interface PurgeApi {
  one(table: PurgeTable, id: string): Promise<PurgeResult>;
  many(keys: readonly PurgeKey[]): Promise<PurgeManyResult>;
  synced(keys: readonly PurgeKey[]): Promise<boolean[]>;
  /** 本机这一份还是不是已删除 */
  stillDeleted(keys: readonly PurgeKey[]): Promise<boolean[]>;
}

const defaultApi: PurgeApi = { one: (t, id) => purgeOne(t, id), many: (k) => purgeMany(k), synced: (k) => serverDeleted(k), stillDeleted: (k) => localDeleted(k) };

function subscribe(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}
const readOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

const key = (table: string, id: string): string => `${table}:${id}`;

/** 已永久删除、等墓碑的项：键 → 删除时间（同一条后来恢复了又删一次，删除时间变了，就不再藏） */
const purged = new Map<string, unknown>();
export function forgetPurgedForTest(): void {
  purged.clear();
}

const settled = (): Promise<void> => Promise.resolve();

export function useTrashPurge<T extends { table: string; id: string; deletedAt: unknown }>(
  all: readonly T[],
  api: PurgeApi = defaultApi,
  settle: () => Promise<unknown> = settled,
  readonly: (table: string, id: string) => boolean = () => false,
) {
  const online = useSyncExternalStore(subscribe, readOnline, () => true);
  const [confirm, setConfirm] = useState<PurgeConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<PurgeMsg | null>(null);
  /** 这次全部清空跳过的只读行条数（提示里接“另有 N 项要新版本才能删除”）；每次点永久删除、全部清空都清零 */
  const [roN, setRoN] = useState(0);
  const [tick, setTick] = useState(0);
  const busyRef = useRef(false);
  /** 列表里还看得见的（已经删掉、等墓碑的藏起来） */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick：purged 是模块里的表，变了靠它重算
  const items = useMemo(() => all.filter((i) => !(purged.has(key(i.table, i.id)) && purged.get(key(i.table, i.id)) === i.deletedAt)), [all, tick]);
  const hide = useCallback(
    (keys: readonly PurgeKey[]) => {
      for (const k of keys) {
        const it = all.find((i) => i.table === k.tbl && i.id === k.id);
        if (it) purged.set(key(k.tbl, k.id), it.deletedAt);
      }
      setTick((n) => n + 1);
    },
    [all],
  );

  const askOne = useCallback((table: PurgeTable, id: string) => {
    if (!readOnline() || busyRef.current) return;
    setMsg(null);
    setRoN(0);
    setConfirm({ kind: 'one', table, id });
  }, []);
  const askAll = useCallback(() => {
    if (!readOnline() || busyRef.current || items.length === 0) return;
    setMsg(null);
    const keys = items.filter((i) => !readonly(i.table, i.id)).map((i) => ({ tbl: i.table as PurgeTable, id: i.id }));
    const ro = items.length - keys.length;
    setRoN(ro);
    if (keys.length === 0) return setMsg('kept');
    busyRef.current = true;
    setBusy(true);
    void settle()
      .then(() => Promise.all([api.synced(keys), api.stillDeleted(keys)]))
      .then(([ok, still]) => {
        // 等恢复写完以后已经恢复了的不算（不发、也不算进“还没同步上”的条数）
        const live = keys.filter((_k, n) => still[n]);
        const send = keys.filter((_k, n) => ok[n] && still[n]);
        if (live.length === 0) return ro > 0 ? setMsg('kept') : undefined;
        if (send.length === 0) setMsg(live.length === 1 ? 'not_synced' : 'partial');
        else setConfirm({ kind: 'all', n: send.length, skip: live.length - send.length, ro, keys: send });
      })
      .catch(() => setMsg('failed'))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, [items, api, settle, readonly]);
  const cancel = useCallback(() => setConfirm(null), []);

  const runOne = useCallback(
    async (table: PurgeTable, id: string): Promise<void> => {
      await settle();
      if (!(await api.stillDeleted([{ tbl: table, id }]))[0]) return;   // 等恢复写完，它已经恢复了：不删
      if (readonly(table, id)) return setMsg('readonly');   // 确认框开着时变成只读了：不发
      const r = await api.one(table, id);
      if (r.ok) {
        hide([{ tbl: table, id }]);
        setMsg('purged');
      } else if (r.err === 'not_synced' && (await api.synced([{ tbl: table, id }]))[0]) {
        hide([{ tbl: table, id }]);
        setMsg('syncing');
      } else setMsg(r.err);
    },
    [api, hide, settle, readonly],
  );
  const runAll = useCallback(
    async (c: Extract<PurgeConfirm, { kind: 'all' }>): Promise<void> => {
      const keys = c.keys.filter((k) => items.some((i) => i.table === k.tbl && i.id === k.id));
      // 确认框开着时变成只读的：不发，算进留下的只读条数
      const send = keys.filter((k) => !readonly(k.tbl, k.id));
      const ro = c.ro + keys.length - send.length;
      setRoN(ro);
      // 确认框开着时全被恢复了、又没有只读的：什么都不发，也不出“已清空”
      if (send.length === 0) return ro > 0 ? setMsg('kept') : undefined;
      const r = await api.many(send);
      hide(r.done);
      setMsg(r.err ?? (r.left > 0 || c.skip > 0 ? 'partial' : 'cleared'));
    },
    [api, hide, items, readonly],
  );

  const ok = useCallback(() => {
    const c = confirm;
    if (!c || busyRef.current) return;
    setConfirm(null);
    busyRef.current = true;
    setBusy(true);
    (c.kind === 'one' ? runOne(c.table, c.id) : runAll(c))
      .catch(() => setMsg('failed'))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, [confirm, runOne, runAll]);

  return { items, online, busy, confirm, msg, roN, setMsg, askOne, askAll, cancel, ok };
}
