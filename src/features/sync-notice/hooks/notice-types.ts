// 冲突提示 gate 和宿主之间的约定（放在 hooks 下：ui 只能经 hooks 拿类型，index.ts 再把类型转出去给 gate）（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 2.1、4.1、4.2）
// gate（app/sync-notice-gate.ts，after-paint 块）收事件、读 gone、排队，宿主（ui/SyncNoticeHost.tsx，按需分包）只画和点按。只有类型
import type { NoticeTable } from '../data/notice-tables.ts';

/** gone 卡现在的状态：idle 平时；busy 点了正在办；retry 临时失败（说明换成“没能恢复，请稍后再试。”）；blocked 永久拒收（只剩“不用了”） */
export type GoneStatus = 'idle' | 'busy' | 'retry' | 'blocked';

export interface ConflictNotice {
  kind: 'conflict';
  /** `${table}:${id}` */
  key: string;
  table: NoticeTable;
  id: string;
  status: 'conflict' | 'forked';
  /** 冲突的列（同一条记录多次冲突取并集） */
  conflicts: readonly string[];
  /** 另一台设备上的值（逐列以最新一次为准） */
  old: Readonly<Record<string, unknown>> | null;
  forkId: string | null;
  /** 去掉首尾空白的标题；取不到为 null（卡上写“这一条”） */
  title: string | null;
}

export interface GoneNotice {
  kind: 'gone';
  key: string;
  table: NoticeTable;
  id: string;
  title: string | null;
  status: GoneStatus;
}

export type Notice = ConflictNotice | GoneNotice;

export interface NoticeSnapshot {
  /** 冲突卡在前、gone 卡在后；一次只显示第一张 */
  queue: readonly Notice[];
  /** “这条已彻底删除，无法恢复。”轻提示：每来一次加 1，0 = 从来没有；宿主看到变大就出一次 */
  hardDeleted: number;
  /** forked 说明里的后缀（FORK_SUFFIX 按 profiles.ui_locale 选、trim 过）；取不到按界面语言由宿主选，这里为 null */
  forkSuffix: string | null;
}

export interface SyncNoticeStore {
  getState(): NoticeSnapshot;
  subscribe(fn: () => void): () => void;
  /** gone 卡“恢复并保留我的修改” */
  restore(key: string): void;
  /** gone 卡“不用了” */
  drop(key: string): void;
  /** 冲突卡“知道了”、到时自动收起 */
  dismiss(key: string): void;
}

export interface SyncNoticeHostProps {
  store: SyncNoticeStore;
  /** gate 预建的常驻 live region（role="status" aria-live="polite"）：宿主只往里写字，不重建 */
  live: HTMLElement;
  /** gate 预建的外层容器（data-sync-notice role="region"）：宿主挂上后补 aria-label，自己开对话框时标 data-own-dialog */
  region: HTMLElement;
}
