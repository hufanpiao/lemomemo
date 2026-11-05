// account-purge 的假库（PurgeStore 的内存版），从 account-fakes.ts 拆出来（PURGE-r4-low 低 K：那个文件超了 max-lines）。
// 数据都在 FakeDb 上（pending、profiles、counters……），这里只是按 PurgeStore 的接口去读写它；语义以 index.ts 的 makeStore 和 SQL 为准，
// 这里只照着做，不另发明规则。FakeDb.purgeStore() 调的就是它，调用方不用改。
import type { PurgeStore } from '../../supabase/functions/account-purge/core.ts';
import type { FakeDb } from './account-fakes.ts';

export function fakePurgeStore(db: FakeDb): PurgeStore {
  return {
    listRemind: async (untilIso, sinceIso) => {
      db.guard('listRemind');
      return [...db.pending].filter(([, d]) => !d.notice_sent && d.purge_after <= untilIso && d.purge_after > sinceIso && d.purge_started_at === null)
        .sort((x, y) => (x[1].purge_after < y[1].purge_after ? -1 : 1)).map(([user_id, d]) => ({ user_id, purge_after: d.purge_after }));
    },
    casNotice: async (u, from, to) => {
      db.guard('casNotice');
      const d = db.pending.get(u);
      if (!d || d.notice_sent !== from) return false;
      d.notice_sent = to;
      return true;
    },
    postponeNotice: async (u, oldIso, newIso) => {
      db.guard('postponeNotice');
      db.beforePostpone?.();
      const d = db.pending.get(u);
      if (!d || d.notice_sent || d.purge_after !== oldIso || d.purge_started_at !== null) return false;
      d.notice_sent = true;
      d.purge_after = newIso;
      return true;
    },
    listDue: async (nowIso, staleIso) => {
      db.guard('listDue');
      return [...db.pending].filter(([, d]) => d.purge_after <= nowIso && (d.purge_started_at === null || d.purge_started_at < staleIso))
        .sort((x, y) => (x[1].purge_after < y[1].purge_after ? -1 : x[1].purge_after > y[1].purge_after ? 1 : x[0] < y[0] ? -1 : 1))
        .map(([user_id, d]) => ({ user_id, purge_after: d.purge_after, notice_sent: d.notice_sent }));
    },
    claim: async (u, nowIso, staleIso) => {
      db.guard('claim');
      const d = db.pending.get(u);
      if (!d || d.purge_after > nowIso || !(d.purge_started_at === null || d.purge_started_at < staleIso)) return false;
      d.purge_started_at = nowIso;
      return true;
    },
    release: async (u, iso) => { const d = db.pending.get(u); if (d && d.purge_started_at === iso) d.purge_started_at = null; },
    stillClaimed: async (u, iso) => { db.beforeStillClaimed?.(); return db.pending.get(u)?.purge_started_at === iso; },
    backupsCursor: async (u, iso) => { const d = db.pending.get(u); return d && d.purge_started_at === iso ? d.backups_done_through ?? null : null; },
    saveBackupsCursor: async (u, iso, date) => {   // 同 index.ts：只往后推、条件带认领时刻
      const d = db.pending.get(u);
      if (d && d.purge_started_at === iso && (d.backups_done_through == null || d.backups_done_through < date)) d.backups_done_through = date;
    },
    isAdmin: async (u) => db.admins.has(u),
    profile: async (u) => { const p = db.profiles.get(u); return p ? { ...p } : null; },
    deletePendingSignup: async (h) => { db.guard('deletePendingSignup'); db.pendingSignups.delete(h); },
    deleteCounterKey: async (key) => { for (const k of [...db.counters.keys()]) if (k.split('|')[0] === key) db.counters.delete(k); },
    deleteUserCounters: async (u) => {
      db.guard('deleteUserCounters');
      for (const k of [...db.counters.keys()]) if (k.split('|')[0]?.split(':')[1] === u) db.counters.delete(k);
    },
    insertDeletedAccount: async (u) => { db.guard('insertDeletedAccount'); db.deleted.add(u); },
    remainingRows: async (u) => (db.profiles.has(u) ? 1 : 0) + (db.pending.has(u) ? 1 : 0),
    writeHeartbeat: async (d) => { db.guard('writeHeartbeat'); db.heartbeat = { ...d }; },
  };
}
