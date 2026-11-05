// 同步冲突、gone 的提示卡宿主（K8 冲突提示，方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 3.1～3.3、4.2、4.4）
// • gate（app/sync-notice-gate.ts）对预建容器里的挂载点 createRoot 后渲染它；挂上以后一直挂着，数据和动作只经 hooks（L5）
// • 一次只显示队列第一张：冲突卡在前、gone 卡在后，有排队时说明下面另起一行“还有 {n} 条”（K-15）
// • 冲突卡 8 秒自动收起（只在页面可见、没有弹层、卡显示着、指针和焦点都不在卡上时计时）；gone 卡不自动收
// • 读屏（M3）：卡换了（或状态变了）等下一帧把“标题 + 说明”写进 gate 预建的常驻 live region；卡本身不抢焦点
// • “看另一台设备的版本”用 kit Dialog（焦点进出由它管）；自己开对话框时给容器标 data-own-dialog，样式就不把卡藏起来
// • forked（随手记）：随手记页面 B3 才做，B2 只给“知道了”
// • 轻提示“这条已彻底删除，无法恢复。”（P2）：store 的 hardDeleted 变大就出一次，UNDO_TOAST_MS 后自己消失，经 live region 播报
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FORK_SUFFIX } from '../../../../shared/sync/fork-suffix-data.ts';
import { Dialog, DialogClose } from '../../../kit/components/Dialog.tsx';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Appear } from '../../../motion/components.ts';
import { nextFrame } from '../../../motion/index.ts';
import { useSnT, type SnT } from '../hooks/useSnT.ts';
import type { ConflictNotice, Notice, SyncNoticeHostProps } from '../hooks/notice-types.ts';
import { conflictLines, useAutoDismiss, useNoticeSnapshot, useRouteHidden } from '../hooks/useSyncNotices.ts';
import styles from './SyncNoticeHost.module.css';

/** 标题里的 {title} 最多 12 个字，多了截断加“…”（3.1）；按字符算，不切开表情和谚文 */
export const TITLE_MAX = 12;
export function clipTitle(title: string): string {
  const cs = [...title];
  return cs.length > TITLE_MAX ? `${cs.slice(0, TITLE_MAX).join('')}…` : title;
}

function headOf(n: Notice, t: SnT): string {
  if (n.kind === 'gone') return n.title ? t('sn.gone.title', { title: clipTitle(n.title) }) : t('sn.gone.titleNone', {});
  return n.title ? t('sn.conflict.title', { title: clipTitle(n.title) }) : t('sn.conflict.titleNone', {});
}

function bodyOf(n: Notice, t: SnT, suffix: string): string {
  if (n.kind === 'conflict') return n.status === 'forked' ? t('sn.forked.body', { suffix }) : t('sn.conflict.body', {});
  if (n.status === 'retry') return t('sn.gone.retry', {});
  if (n.status === 'blocked') return t('sn.gone.blocked', {});
  return t('sn.gone.body', {});
}

function ConflictDialog({ notice, open, onOpenChange }: { notice: ConflictNotice; open: boolean; onOpenChange(o: boolean): void }) {
  const t = useSnT();
  const locale = useUi((s) => s.locale);
  const lines = conflictLines(notice, locale);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('sn.dialog.title', {})}>
      <ul className={styles.list} data-testid="sync-notice-lines">
        {lines.map((l, i) => (
          <li key={l.field ?? `x${i}`} className={styles.row}>
            <span className={styles.val}>{l.field === null ? l.value : t('sn.dialog.row', { field: l.field, value: l.value })}</span>
          </li>
        ))}
      </ul>
      <div className={styles.dialogActs}>
        <DialogClose className={styles.dialogBtn} data-testid="sync-notice-dialog-ok">
          {t('sn.ok', {})}
        </DialogClose>
      </div>
    </Dialog>
  );
}

export default function SyncNoticeHost({ store, live, region }: SyncNoticeHostProps) {
  const t = useSnT();
  const locale = useUi((s) => s.locale);
  const snap = useNoticeSnapshot(store);
  const routeHidden = useRouteHidden();
  const [dialogKey, setDialogKey] = useState<string | null>(null);
  /** 正在出的轻提示对应的 hardDeleted 计数；0 = 没出 */
  const [flashAt, setFlashAt] = useState(0);
  const flash = flashAt !== 0;
  const seenHard = useRef(snap.hardDeleted);
  const tRef = useRef(t);
  tRef.current = t;

  const current = snap.queue[0] ?? null;
  const shown = current !== null && !routeHidden;
  const suffix = snap.forkSuffix ?? FORK_SUFFIX[locale].trim();
  const head = current ? headOf(current, t) : '';
  const body = current ? bodyOf(current, t, suffix) : '';
  const more = snap.queue.length - 1;

  // 容器挂上样式和按界面语言的 aria-label（gate 不放文字，2.1）
  useLayoutEffect(() => {
    region.classList.add(styles.region ?? '');
    live.classList.add(styles.live ?? '');
  }, [region, live]);
  // 有卡或轻提示时才给名字（代码审查 K8 界面批 L3）：没名字的 region 不算地标，队列空了读屏的地标列表里不留一个空的“同步提示”
  const hasContent = shown || flash;
  useEffect(() => {
    if (hasContent) region.setAttribute('aria-label', t('sn.region', {}));
    else region.removeAttribute('aria-label');
  }, [region, t, hasContent]);
  // 自己开的对话框不算“别的弹层”
  useEffect(() => {
    if (dialogKey === null) region.removeAttribute('data-own-dialog');
    else region.setAttribute('data-own-dialog', '');
  }, [region, dialogKey]);

  // 读屏：下一帧写，保证第一次挂上时也播报（M3）
  const said = shown ? `${head} ${body}` : '';
  useEffect(() => {
    if (!said) return undefined;
    return nextFrame(() => {
      live.textContent = said;
    });
  }, [live, said]);

  // 彻底删除的轻提示（P2）
  // 分两段：只认“计数变大”一次；播报和计时挂在 flashAt 上。不放在同一个副作用里——那样 t 换了身份或 StrictMode 重跑时，
  // 清理掉了计时和播报，重跑又因为计数已记下直接返回，提示就一直挂着
  useEffect(() => {
    if (snap.hardDeleted <= seenHard.current) return;
    seenHard.current = snap.hardDeleted;
    setFlashAt(snap.hardDeleted);
  }, [snap.hardDeleted]);
  useEffect(() => {
    if (flashAt === 0) return undefined;
    const off = nextFrame(() => {
      live.textContent = tRef.current('sn.hardDeleted', {});
    });
    const id = setTimeout(() => setFlashAt(0), UNDO_TOAST_MS);
    return () => {
      off();
      clearTimeout(id);
    };
  }, [flashAt, live]);

  const isConflict = current?.kind === 'conflict';
  const timer = useAutoDismiss(isConflict ? current.key : null, shown && dialogKey === null, (key) => store.dismiss(key));

  return (
    <>
      <Appear kind="toast" show={flash && !routeHidden}>
        <div className={styles.flash} data-testid="sync-notice-hard-deleted">
          {t('sn.hardDeleted', {})}
        </div>
      </Appear>
      <Appear kind="toast" show={shown}>
        {current ? (
          // 按卡的 key 换节点（R2-L1）：换卡时不复用上一张的按钮，焦点不会留在新卡的按钮上让连按两次 Enter 收起两张
          <div key={current.key} className={styles.card} data-testid="sync-notice-card" data-kind={current.kind} data-status={current.status}
            onMouseEnter={timer.onMouseEnter} onMouseLeave={timer.onMouseLeave} onFocus={timer.onFocus} onBlur={timer.onBlur}
          >
            <div className={styles.text}>
              <p className={styles.t1}>{head}</p>
              <p className={styles.t2}>{body}</p>
              {more > 0 ? <p className={styles.more}>{t('sn.more', { n: more })}</p> : null}
            </div>
            <div className={styles.actions}>
              {current.kind === 'conflict' ? (
                <>
                  {/* 冲突列全是不显示的列（只动了 updated_at 一类）：对话框会是空的，不给这个按钮（代码审查 K8 界面批建议） */}
                  {current.status === 'conflict' && conflictLines(current, locale).length > 0 ? (
                    <button type="button" className={styles.btn} data-testid="sync-notice-view" onClick={() => setDialogKey(current.key)}>
                      {t('sn.conflict.view', {})}
                    </button>
                  ) : null}
                  <button type="button" className={styles.btn} data-testid="sync-notice-ok" onClick={() => store.dismiss(current.key)}>
                    {t('sn.ok', {})}
                  </button>
                </>
              ) : (
                <>
                  {current.status !== 'blocked' ? (
                    <button type="button" className={styles.btn} data-testid="sync-notice-restore" disabled={current.status === 'busy'} onClick={() => store.restore(current.key)}>
                      {t('sn.gone.restore', {})}
                    </button>
                  ) : null}
                  <button type="button" className={styles.btn} data-testid="sync-notice-drop" disabled={current.status === 'busy'} onClick={() => store.drop(current.key)}>
                    {t('sn.gone.drop', {})}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}
      </Appear>
      {current?.kind === 'conflict' && current.status === 'conflict' ? (
        <ConflictDialog
          notice={current}
          open={dialogKey === current.key}
          onOpenChange={(o) => setDialogKey(o ? current.key : null)}
        />
      ) : null}
    </>
  );
}
