// “最近删除”页（B2 FA-2；ADR-006；TC-B2-03 前两步；B4 S2 加随手记）：日程、待办和随手记，最近删的在前，每条写“N 天后清理”和“恢复”
// • 恢复后出“已恢复”提示（2 秒，role=status）；写不进去出提示条
// • 永久删除、全部清空（B4 S9，TC-B4-17，0.29 续第 121 条⑧）：每行“永久删除”、右上角“全部清空”，都先弹确认（kit 的 ConfirmDialog），
//   只走 RPC purge_deleted（hooks/useTrashPurge.ts、data/trash-purge-api.ts）；离线时两个按钮灰掉、页上写“要联网”，点了没反应、不进 outbox。
//   没有定稿视觉稿（线框、皮肤视觉稿里都没画这两个按钮）：沿用本页“恢复”胶囊和设置页确认弹层的样子；按 R-376 不加动效，左滑、长按菜单留到 UI 细修
// • 隐私记有自己的“最近删除”（R-193，B5），这里的“全部清空”不含隐私记（服务器只清四张表的普通行）
// • 路由 #/trash（app/router.ts 的 ROUTE_NAMES、today/index.ts 的 routes）；返回：App 里有上一页就退回，否则换到设置（S11）
// • 只看一类（R-438，负责人 11-16“每页只看到自己的删除那类吧”）：#/trash/notes 只列随手记（随手记页的图标、插图提示进来），#/trash/todos 只列待办
//   （待办页的图标、设置里自动删除的说明进来）；先过滤再交给 useTrashPurge，所以“全部清空”也只清这一类（它只发列表里看得见的项）；
//   只看一类时每行不再写“随手记 ·”“待办 ·”。不带参数的 #/trash 照旧三类都列（日程删了在这里找）
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoute } from '../../../app/router.ts';
import { backOr } from '../../../app/router-levels.ts';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { FormButton, GroupLabel } from '../../../kit/components/Form.tsx';
import list from '../../../kit/components/List.module.css';
import { ReadonlyMark } from '../../../kit/components/ReadonlyMark.tsx';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
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
  const only = p0 === 'notes' || p0 === 'todos' ? p0 : null;
  const all = useMemo(() => (only ? every.filter((it) => it.table === only) : every), [every, only]);
  const [msg, setMsg] = useState<RestoreResult | null>(null);
  // 只读行（要新版本，TC-B4-09“写入入口统一拦下”；重复事项 R-148）进了“最近删除”也照样只读：标“要新版本”，
  // “恢复”“永久删除”都灰掉，点了只提示“这条要新版本才能修改”、不写、不调 RPC（core 也会按 readonly_row 拒，页面层先拦）；
  // 全部清空跳过它们（hooks/useTrashPurge.ts）
  const roIds = { events: useReadonlyIds('events'), todos: useReadonlyIds('todos'), notes: useReadonlyIds('notes') };
  const isRo = (table: string, id: string): boolean => (table === 'events' || table === 'todos' || table === 'notes') && roIds[table].has(id);
  // 点过、还没写完的“恢复”：永久删除、全部清空先等它们写完再定要发的项（代码复审 11-11）
  const restoring = useRef(new Set<Promise<unknown>>());
  const purge = useTrashPurge(all, undefined, () => Promise.allSettled([...restoring.current]), isRo);
  const { items, online, busy, confirm } = purge;
  const off = !online || busy;

  useEffect(() => {
    if (msg !== 'ok') return undefined;
    const id = setTimeout(() => setMsg(null), 2000);
    return () => clearTimeout(id);
  }, [msg]);
  const { msg: pmsg, roN, setMsg: setPmsg } = purge;
  // 全部清空跳过了只读行：结果提示后面接“另有 N 项要新版本才能删除，留在列表里”（增量复审 11-11 必改），这时“已清空”也不自动收起
  const roTail = roN > 0 && (pmsg === 'cleared' || pmsg === 'partial' || pmsg === 'not_synced') ? t('trash.ro.tail', { n: roN }) : '';
  useEffect(() => {
    if ((pmsg !== 'purged' && pmsg !== 'cleared' && pmsg !== 'syncing') || roTail !== '') return undefined;
    const id = setTimeout(() => setPmsg(null), 2000);
    return () => clearTimeout(id);
  }, [pmsg, setPmsg, roTail]);
  // 恢复的提示和永久删除的结果提示二选一显示，按后到的算：永久删除的结果出来以后，之前点的“恢复”晚到的“已恢复”不再盖住它
  // （恢复失败照样提示）。代码复审 11-11
  const restoreSeq = useRef(0);
  useEffect(() => {
    if (pmsg === null) return;
    restoreSeq.current += 1;
    setMsg(null);
  }, [pmsg]);
  const onRestore = (table: (typeof items)[number]['table'], id: string): void => {
    // 永久删除、全部清空的请求在路上时不能恢复：要删的项已经发出去了，恢复那次修改会回 not_found 被丢掉（代码复审 11-11 必改）
    if (purge.busy) return;
    if (isRo(table, id)) {
      setPmsg(null);
      setMsg('readonly');
      return;
    }
    setPmsg(null);
    const my = ++restoreSeq.current;
    const job = restore(table, id);
    restoring.current.add(job);
    void job.finally(() => restoring.current.delete(job)).catch(() => undefined);
    void job.then((r) => {
      if (r !== 'ok' || restoreSeq.current === my) setMsg(r);
    });
  };

  return (
    <main className={styles.page} data-feature="trash" data-testid="trash" data-only={only ?? undefined}>
      <header className={styles.top}>
        <BackLink label={t('trash.back', {})} onBack={back} testId="trash-back" />
        <h1 className={styles.h1}>{t('trash.title', {})}</h1>
        {items.length > 0 ? (
          <Pressable className={styles.clear} aria-disabled={off || undefined} onClick={() => { setMsg(null); purge.askAll(); }} data-testid="trash-clear">
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
      {items.length === 0 ? <p className={list.empty} data-testid="trash-empty">{t('trash.empty', {})}</p> : <GroupLabel>{t('trash.count', { n: items.length })}</GroupLabel>}
      {/* R-436：行高 56、左右 16（kit 列表的 .roomy，同今天页、待办页）；“恢复”“永久删除”用 kit 的小号灰底按钮（FormButton compact），不再描边 */}
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
              <FormButton size="compact" aria-disabled={busy || isRo(it.table, it.id) || undefined} onClick={() => onRestore(it.table, it.id)} data-testid={`trash-restore-${it.id}`}>
                {t('trash.restore', {})}
              </FormButton>
              <FormButton
                size="compact"
                danger
                aria-disabled={off || isRo(it.table, it.id) || undefined}
                onClick={() => {
                  if (isRo(it.table, it.id)) {
                    if (purge.busy) return;
                    setPmsg(null);
                    setMsg('readonly');
                    return;
                  }
                  setMsg(null);
                  purge.askOne(it.table, it.id);
                }}
                data-testid={`trash-purge-${it.id}`}
              >
                {t('trash.purge', {})}
              </FormButton>
            </span>
          </li>
        ))}
      </ul>
      {msg === 'ok' ? (
        <p className={styles.toast} role="status" data-testid="trash-msg">
          {t('trash.restored', {})}
        </p>
      ) : msg === 'failed' || msg === 'readonly' ? (
        <p className={styles.toast} role="alert" data-testid="trash-msg">
          {tToday(msg === 'readonly' ? 'err.readonly' : 'err.save', {})}
        </p>
      ) : pmsg ? (
        <p className={styles.toast} role={pmsg === 'purged' || pmsg === 'cleared' || pmsg === 'syncing' ? 'status' : 'alert'} data-testid="trash-purge-msg">
          {pmsg === 'readonly' ? tToday('err.readonly', {}) : pmsg === 'kept' ? t('trash.ro.kept', { n: roN }) : t(PURGE_MSG[pmsg], {}) + roTail}
        </p>
      ) : null}
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

const PURGE_MSG = {
  purged: 'trash.purged',
  cleared: 'trash.cleared',
  partial: 'trash.err.partial',
  syncing: 'trash.syncing',
  not_synced: 'trash.err.notSynced',
  offline: 'trash.err.offline',
  failed: 'trash.err.failed',
} as const satisfies Record<Exclude<PurgeMsg, 'readonly' | 'kept'>, string>;
