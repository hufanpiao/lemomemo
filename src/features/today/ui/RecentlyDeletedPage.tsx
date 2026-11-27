// “最近删除”页：日程、待办和随手记，最近删的在前，每条写“N 天后清理”和“恢复”
// • 恢复后出“已恢复”提示（TOAST_MS 5 秒，role=status）；写不进去出提示条
// • 永久删除、全部清空：每行“永久删除”、右上角“全部清空”，都先弹确认（kit 的 ConfirmDialog），
//   只走 RPC purge_deleted（hooks/useTrashPurge.ts、data/trash-purge-api.ts）；离线时两个按钮灰掉、页上写“要联网”，点了没反应、不进 outbox。
//   样子沿用本页“恢复”胶囊和设置页确认弹层；不加动效
// • 隐私记有自己的“最近删除”，这里的“全部清空”不含隐私记（服务器只清四张表的普通行）
// • 路由 #/trash（app/router.ts 的 ROUTE_NAMES、today/index.ts 的 routes）；返回：App 里有上一页就退回，否则换到设置
// • 只看一类：#/trash/notes 只列随手记，#/trash/todos 只列待办；先过滤再交给 useTrashPurge，所以“全部清空”也只清这一类（它只发列表里看得见的项）；
//   只看一类时每行不再写“随手记 ·”“待办 ·”。不带参数的 #/trash 三类都列（日程删了在这里找）
// • 页底提示：恢复的结果和永久删除、清空的结果是同一个 notice 状态，后到的覆盖先到的（永久删除、清空先等点过的“恢复”写完，
//   所以它的结果总在后面）；页底一个常驻的 role=status 只换文字
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoute } from '../../../app/router.ts';
import { backOr, dockOf } from '../../../app/router-levels.ts';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { deskAside } from '../../../kit/components/Desk.tsx';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import chip from '../../../kit/components/Chip.module.css';
import float from '../../../kit/components/Float.module.css';
import list from '../../../kit/components/List.module.css';
import { ReadonlyMark } from '../../../kit/components/ReadonlyMark.tsx';
import { useExpire, useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { Pressable } from '../../../motion/components.ts';
import { useTodayT } from '../hooks/useTodayT.ts';
import { useTrashT } from '../hooks/useTrashT.ts';
import { useTrash, type RestoreResult } from '../hooks/useTrash.ts';
import { useTrashPurge, type PurgeMsg } from '../hooks/useTrashPurge.ts';
import styles from './RecentlyDeletedPage.module.css';

const back = (): void => backOr('settings');

export default function RecentlyDeletedPage() {
  const t = useTrashT();
  const tToday = useTodayT();
  const { items: every, restore } = useTrash();
  const p0 = useRoute().params[0];
  const desk = useMedia(MQ_DESK_WIDE);
  const only = p0 === 'notes' || p0 === 'todos' ? p0 : null;
  const all = useMemo(() => (only ? every.filter((it) => it.table === only) : every), [every, only]);
  // 只读行（要新版本，写入入口统一拦下）进了“最近删除”也照样只读：标“要新版本”，
  // “恢复”“永久删除”都灰掉，点了只提示“这条要新版本才能修改”、不写、不调 RPC（core 也会按 readonly_row 拒，页面层先拦）；
  // 全部清空跳过它们（hooks/useTrashPurge.ts）
  const roIds = { events: useReadonlyIds('events'), todos: useReadonlyIds('todos'), notes: useReadonlyIds('notes') };
  const isRo = (table: string, id: string): boolean => (table === 'events' || table === 'todos' || table === 'notes') && roIds[table].has(id);
  // 点过、还没写完的“恢复”：永久删除、全部清空先等它们写完再定要发的项
  const restoring = useRef(new Set<Promise<unknown>>());
  const purge = useTrashPurge(all, undefined, () => Promise.allSettled([...restoring.current]), isRo);
  const { items, online, busy, confirm } = purge;
  const off = !online || busy;

  const { msg: pmsg, roN } = purge;
  const [notice, setNotice] = useState<Notice | null>(null);
  // 永久删除、清空的结果到了：盖掉之前的提示（askOne / askAll 一开始就把 pmsg 清成 null，同样的结果再来一次照样会触发）
  useEffect(() => {
    if (pmsg !== null) setNotice({ kind: 'purge', m: pmsg });
  }, [pmsg]);
  // 全部清空跳过了只读行：结果提示后面接“另有 N 项要新版本才能删除，留在列表里”，这时“已清空”也不自动收起
  const roTail = notice?.kind === 'purge' && roN > 0 && (notice.m === 'cleared' || notice.m === 'partial' || notice.m === 'not_synced') ? t('trash.ro.tail', { n: roN }) : '';
  const fleeting = notice !== null && roTail === '' && (notice.kind === 'restore' ? notice.r === 'ok' : notice.m === 'purged' || notice.m === 'cleared' || notice.m === 'syncing');
  // 成功的提示 TOAST_MS 后收起（kit 的 useExpire）；出错的、带只读尾巴的留着
  useExpire(fleeting ? notice : null, () => setNotice(null));
  /** 只读行点了“恢复”“永久删除”：提示“这条要新版本才能修改”，不写、不调 RPC；返回 true 表示拦下了（两个按钮共用） */
  const stopReadonly = (table: string, id: string): boolean => {
    if (!isRo(table, id)) return false;
    setNotice({ kind: 'restore', r: 'readonly' });
    return true;
  };
  const onRestore = (table: (typeof items)[number]['table'], id: string): void => {
    // 永久删除、全部清空的请求在路上时不能恢复：要删的项已经发出去了，恢复那次修改会回 not_found 被丢掉
    if (purge.busy || stopReadonly(table, id)) return;
    setNotice(null);
    const job = restore(table, id);
    restoring.current.add(job);
    void job.finally(() => restoring.current.delete(job)).catch(() => undefined);
    void job.then((r) => setNotice({ kind: 'restore', r }));
  };
  const onPurge = (table: (typeof items)[number]['table'], id: string): void => {
    if (purge.busy || stopReadonly(table, id)) return;
    setNotice(null);
    purge.askOne(table, id);
  };
  const noticeText =
    notice === null
      ? ''
      : notice.kind === 'restore'
        ? notice.r === 'ok'
          ? t('trash.restored', {})
          : tToday(notice.r === 'readonly' ? 'err.readonly' : 'err.save', {})
        : notice.m === 'readonly'
          ? tToday('err.readonly', {})
          : notice.m === 'kept'
            ? t('trash.ro.kept', { n: roN })
            : t(PURGE_MSG[notice.m], {}) + roTail;

  return (
    // 网页版宽屏：左边侧栏、右边常驻 AI 栏照设置页（app/router.ts LEVELS 的 dock），内容列宽不变、夹在两边中间（kit Desk 的 deskAside）
    <main className={desk && dockOf('trash') ? `${styles.page} ${deskAside}` : styles.page} data-feature="trash" data-testid="trash" data-only={only ?? undefined}>
      <header className={styles.top}>
        <BackLink label={t('trash.back', {})} onBack={back} testId="trash-back" />
        <h1 className={styles.h1}>{t('trash.title', {})}</h1>
        {items.length > 0 ? (
          <Pressable className={styles.clear} aria-disabled={off || undefined} onClick={() => { setNotice(null); purge.askAll(); }} data-testid="trash-clear">
            {t('trash.clear', {})}
          </Pressable>
        ) : (
          <span />
        )}
      </header>
      <p className={styles.note}>{t('trash.note', {})}</p>
      {/* 常驻的 role=status：离线说明后填进来，读屏才播报 */}
      <p className={styles.offline} role="status" data-testid="trash-offline">
        {!online && items.length > 0 ? t('trash.offline', {}) : null}
      </p>
      {items.length === 0 ? <p className={list.empty} data-testid="trash-empty">{t('trash.empty', {})}</p> : null}
      {/* 行高 56、左右 16（kit 列表的 .roomy，同今天页、待办页）；“恢复”“永久删除”用 kit 胶囊（Chip.module.css .chip，同待办页筛选），永久删除只换危险色字 */}
      <ul className={`${list.list} ${list.roomy}`}>
        {items.map((it) => (
          <li key={`${it.table}:${it.id}`} className={list.row} data-testid={`trash-row-${it.id}`}>
            <span className={list.main}>
              <span className={list.text}>
                <span className={list.title}>{it.title}</span>
                <span className={list.meta}>
                  {only ? null : `${t(it.table === 'events' ? 'trash.kind.events' : it.table === 'notes' ? 'trash.kind.notes' : 'trash.kind.todos', {})} · `}
                  {t('trash.left', { n: it.daysLeft })}
                </span>
                {isRo(it.table, it.id) ? (
                  <span className={styles.ro}>
                    <ReadonlyMark testId={`trash-ro-${it.id}`} />
                  </span>
                ) : null}
              </span>
            </span>
            <span className={styles.acts}>
              <Pressable className={chip.chip} aria-disabled={busy || isRo(it.table, it.id) || undefined} onClick={() => onRestore(it.table, it.id)} data-testid={`trash-restore-${it.id}`}>
                {t('trash.restore', {})}
              </Pressable>
              <Pressable
                className={`${chip.chip} ${styles.danger}`}
                aria-disabled={off || isRo(it.table, it.id) || undefined}
                onClick={() => onPurge(it.table, it.id)}
                data-testid={`trash-purge-${it.id}`}
              >
                {t('trash.purge', {})}
              </Pressable>
            </span>
          </li>
        ))}
      </ul>
      <p className={`${float.float} ${styles.toast}`} role="status" data-testid="trash-msg" data-kind={notice?.kind}>
        {noticeText}
      </p>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'all' ? t('trash.clear.title', {}) : t('trash.purge.title', {})}
        body={
          confirm?.kind === 'all'
            ? t('trash.clear.body', { n: confirm.n }) + (confirm.skip > 0 ? t('trash.clear.skip', { n: confirm.skip }) : '') + (confirm.ro > 0 ? t('trash.clear.ro', { n: confirm.ro }) : '')
            : t('trash.purge.body', {})
        }
        okLabel={confirm?.kind === 'all' ? t('trash.clear', {}) : t('trash.purge', {})}
        cancelLabel={t('trash.cancel', {})}
        danger
        testId="trash-confirm"
        onOk={purge.ok}
        onCancel={purge.cancel}
      />
    </main>
  );
}

type Notice = { kind: 'restore'; r: RestoreResult } | { kind: 'purge'; m: PurgeMsg };

const PURGE_MSG = {
  purged: 'trash.purged',
  cleared: 'trash.cleared',
  partial: 'trash.err.partial',
  syncing: 'trash.syncing',
  not_synced: 'trash.err.notSynced',
  offline: 'trash.err.offline',
  failed: 'trash.err.failed',
} as const satisfies Record<Exclude<PurgeMsg, 'readonly' | 'kept'>, string>;
