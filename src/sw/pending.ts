// SW 写 pending_actions（架构 4.1、0.29 续第 102 条③、第 107 条；接手清单 K-sw-seal，B2）
// SW 不拿存着的令牌调接口：点通知上的按键时只把“哪条提醒、按了哪个键”记进本机库 planner-v4 的 pending_actions 仓，
// 页面启动后由 core/pending-actions.ts 丢掉别的账号的、超过 24 小时的，其余经正常的 data 层转进 outbox。
// 退出时的封存（core/account.ts 的 sealForExit）管不到 SW，所以这里自己守三条（K-sw-seal 结论）：
//   ⑴ 只往**已经存在**、owner 仓里**有 user_id** 的库写：经 shared/idb-open-existing.ts 打开（不带版本号，库不存在就中止升级、
//      不建新库，2 秒没打开按没有库）；库里没有 owner / pending_actions 仓、owner 没记录，一律不写；
//      推送里带的 user_id 必须和 owner 的 user_id **一致**才写，不一致就丢——不能拿 owner 的值去填（A 账号的通知会写进 B 的库，串号）；
//   ⑵ 开库后立刻挂 onversionchange，收到就 close()：退出第 ⑤ 步删库、页面升级都不会被 SW 的连接挡住；每次写完也立刻关；
//   ⑶ 退出、换账号以后旧账号的通知不再推到这台设备：服务器一侧做（退出删本会话的 devices 行 = 删订阅；新账号 claim_endpoint 换绑，
//      架构 4.1、0.38 第 35、37 条），SW 这边由 ⑴ 兜底。
// 库名、仓名、owner 的键和 core/cache.ts、cache-schema.ts、account.ts 是同一组值（SW 不准引 core，A19），
// tests/build/sw-pending.test.ts 逐项核对两边一致
// 不准存明文标题、正文：只存 id、表名、行 id、按键和时间
// 显示通知前的账号核对（FE-1）也在这里只读开库（readSwOwner）：IndexedDB 只准在本文件里碰（tests/build/sw-no-user-data.test.ts），
// 开库那一步是和登录页共用的 shared/idb-open-existing.ts（只开库、不开事务）

import { openExistingDb } from '../../shared/idb-open-existing.ts';

export const DB_NAME = 'planner-v4';
export const OWNER_STORE = 'owner';
export const OWNER_KEY = 'user_id';
export const PENDING_STORE = 'pending_actions';

/** 通知上的“推迟”按键（“完成”见 DoneAction；iPhone 的网页推送不显示按钮、exe 的通知不带按钮，只影响 Edge 安装版） */
export interface SnoozeAction {
  readonly type: 'snooze';
  /** 推迟多少分钟 */
  readonly minutes: number;
  /** 按的是哪一次到点（推送里的 due_at，epoch ms）：页面转成 outbox 时据此判断这一次是不是已经处理过 */
  readonly due_at: number;
}

/** “完成”（只待办，R-294、R-307）：和推迟同一条 pending 路径，页面转成 outbox，整页提醒里能撤销 */
export interface DoneAction {
  readonly type: 'done';
  /** 按的是哪一次到点（同 SnoozeAction.due_at） */
  readonly due_at: number;
}

/** pending_actions 里的一项（0.29 续第 107 条②：{id, user_id, row_table, row_id, action, created_at}） */
export interface SwPendingAction {
  readonly id: string;
  readonly user_id: string;
  readonly row_table: 'events' | 'todos' | 'anniversaries';
  readonly row_id: string;
  readonly action: SnoozeAction | DoneAction;
  /** epoch ms */
  readonly created_at: number;
}

/**
 * 写的结果：ok 写进去了；no_db 本机没有库（从没登录过，或退出时刚删掉）；no_owner 库里没有 owner 仓、没记录或没有 pending_actions 仓；
 * owner_mismatch 推送的 user_id 和库的 owner 不是同一个账号（丢掉）；failed 开库、读写出错
 */
export type PendingWriteResult = 'ok' | 'no_db' | 'no_owner' | 'owner_mismatch' | 'failed';

/** 只开已经存在的库（shared/idb-open-existing.ts，⑴⑵ 都在那里：不建库、收到 versionchange 就关、2 秒没打开按没有库）；没有、打不开回 null */
async function openExisting(factory: IDBFactory): Promise<IDBDatabase | null> {
  const db = await openExistingDb<IDBDatabase>(factory, DB_NAME);
  return db === 'missing' ? null : db;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('idb_request_failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('idb_tx_aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('idb_tx_error'));
  });
}

/**
 * 只读取本机库的 owner（B2 安全审查 FE-1：显示通知前先核对账号）。不建库、不写，读完就关。
 * 返回 owner 的 user_id；没有库、没有 owner 仓或记录、读库出错一律 null（调用方按“不一致”显示兜底通知）
 */
export async function readSwOwner(factory: IDBFactory): Promise<string | null> {
  const db = await openExisting(factory);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains(OWNER_STORE)) return null;
    const tx = db.transaction([OWNER_STORE], 'readonly');
    const owner = await request<{ key: string; value: unknown } | undefined>(tx.objectStore(OWNER_STORE).get(OWNER_KEY));
    return typeof owner?.value === 'string' && owner.value !== '' ? owner.value : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * 按 K-sw-seal 写一项（⑴⑵）。读 owner 和写入在同一个 readwrite 事务里：页面换账号的 claimCache 也是一个覆盖全部仓的 readwrite 事务，
 * 两者串行，不会出现“读到旧 owner、写进新账号的库”
 */
export async function writePendingAction(factory: IDBFactory, rec: SwPendingAction): Promise<PendingWriteResult> {
  const db = await openExisting(factory);
  if (!db) return 'no_db';
  try {
    if (!db.objectStoreNames.contains(OWNER_STORE) || !db.objectStoreNames.contains(PENDING_STORE)) return 'no_owner';
    const tx = db.transaction([OWNER_STORE, PENDING_STORE], 'readwrite');
    const finished = done(tx);
    const owner = await request<{ key: string; value: unknown } | undefined>(tx.objectStore(OWNER_STORE).get(OWNER_KEY));
    if (!owner || typeof owner.value !== 'string' || owner.value === '') {
      tx.abort();
      await finished.catch(() => undefined);
      return 'no_owner';
    }
    if (owner.value !== rec.user_id) {
      tx.abort();
      await finished.catch(() => undefined);
      return 'owner_mismatch';
    }
    tx.objectStore(PENDING_STORE).put(rec);
    await finished;
    return 'ok';
  } catch {
    return 'failed';
  } finally {
    db.close();
  }
}
