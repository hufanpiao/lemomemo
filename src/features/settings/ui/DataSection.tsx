// 设置 › 数据（R-256 ②；B1 只有“导出全部”一行；架构第 6 节 account export、0.29 续第 93、96 条；0.47 续 ④ 第 4 点）
// • 导出任务（hooks/useExport.ts）由 SettingsPage 持有、经 task 传进来：进注销页再回来，取片照常、中断的仍能“继续”
// • 按钮下常驻两句：“导出和注销每天合计最多 3 次，每点一次‘导出全部数据’算一次”（S4：start 不做幂等）、“数据多时……建议连 Wi-Fi”。
//   按钮自己的字（含右边的说明）已经是它的名字，aria-describedby 只指这两句，读屏只读一段
// • 断网时按钮不可点，右边写“联网后才能导出”
// • 导出中：按钮忙。播报区（role=status）开头说“正在导出…”，取回第一片时说一次“已取回 N MB”（只给读屏），之后不再播报；
//   屏幕上另起一行“正在导出…已取回 N MB”随每片更新（数字等宽，变化时不跳宽度；不加动效：一片几秒就变一次，是在读的数据）
// • 中断（自动重试也没过）：播报“导出中断了。1 小时内在这台设备上点‘继续’可以接着导，不另算次数”，下面“继续”“取消”，
//   焦点移到“继续”（从别的状态变成中断时才移；回到设置页时任务已经是中断的不抢焦点）；仍显示已取回多少。1 小时到了自动换成“已过期”
// • 成功：“已导出，通知邮件已发到你的邮箱”；B1 一律没带隐私记令牌，再加一句“隐私记没有导出（没解锁）”；
//   没存下来（分享面板取消等）写“还没存下来”；两种情况都给“再存一次”（不再调服务器；存的过程中按钮禁用，防连点）
import { useEffect, useRef } from 'react';
import { Pressable } from '../../../motion/components.ts';
import { fmtMb, type ExportErr, type ExportTask } from '../hooks/useExport.ts';
import { useOnline } from '../hooks/useOnline.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { accountErrText } from './AccountSection.tsx';
import styles from './SettingsPage.module.css';

type T = ReturnType<typeof useSettingsT>;

function exportErrText(e: ExportErr, t: T): string {
  if (e === 'parts_used_up') return t('settings.export.partsUsedUp', {});
  if (e === 'start_too_large') return t('settings.export.tooLargeStart', {});
  return accountErrText(e, t);
}

export function DataSection({ task }: { task: ExportTask }) {
  const t = useSettingsT();
  const online = useOnline();
  const { state, saving, run, resume, cancel, saveAgain } = task;
  const busy = state.kind === 'busy';
  const paused = state.kind === 'paused';
  const got = state.kind === 'busy' ? state.bytes : state.kind === 'paused' ? state.job.bytes : 0;
  const first = state.kind === 'busy' ? state.first : 0;

  // 变成中断时把焦点给“继续”（Pressable 不转发 ref，经外面那层 div 找第一个能点的按钮：断网时“继续”不可点，焦点落到“取消”）
  const actionsRef = useRef<HTMLDivElement>(null);
  const prevKind = useRef(state.kind);
  useEffect(() => {
    if (state.kind === 'paused' && prevKind.current !== 'paused') actionsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    prevKind.current = state.kind;
  }, [state.kind]);

  return (
    <section aria-labelledby="settings-data-title" data-section="data">
      <h2 id="settings-data-title" className={styles.gt}>
        {t('settings.data.title', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <Pressable
            className={styles.rowBtn}
            disabled={!online || busy || paused}
            aria-busy={busy}
            aria-describedby="settings-export-notes"
            onClick={() => void run()}
            data-testid="settings-export"
          >
            <span className={styles.tx}>{t('settings.account.export', {})}</span>
            <span className={styles.v}>{online ? t('settings.export.hint', {}) : t('settings.export.offline', {})}</span>
          </Pressable>
        </li>
      </ul>
      <p id="settings-export-notes" className={styles.sn} data-testid="settings-export-notes">
        {t('settings.export.quota', {})}
        <br />
        {t('settings.export.wifi', {})}
      </p>
      <div className={styles.status} role="status" data-testid="settings-export-status">
        {busy && first === 0 ? t('settings.export.busy', {}) : null}
        {busy && first > 0 ? <span className={styles.srOnly}>{t('settings.export.progress', { mb: fmtMb(first) })}</span> : null}
        {paused ? <p className={styles.line}>{t('settings.export.paused', {})}</p> : null}
        {state.kind === 'done' ? (
          <>
            <p className={styles.line}>{state.saved ? t('settings.export.done', {}) : t('settings.export.notSaved', {})}</p>
            {state.file.vaultOmitted ? <p className={styles.line}>{t('settings.export.vaultOmitted', {})}</p> : null}
          </>
        ) : null}
      </div>
      {(busy || paused) && got > 0 ? (
        <p className={`${styles.status} ${styles.num}`} data-testid="settings-export-progress">
          {t('settings.export.progress', { mb: fmtMb(got) })}
        </p>
      ) : null}
      {paused ? (
        <div ref={actionsRef} className={styles.exportActions}>
          <Pressable className={styles.primary} disabled={!online} onClick={() => void resume()} data-testid="settings-export-resume">
            {t('settings.export.resume', {})}
          </Pressable>
          <Pressable className={styles.btn} onClick={cancel} data-testid="settings-export-cancel">
            {t('settings.cancel', {})}
          </Pressable>
        </div>
      ) : null}
      {state.kind === 'done' ? (
        <Pressable
          className={styles.btn}
          disabled={saving}
          aria-busy={saving}
          onClick={() => void saveAgain()}
          data-testid="settings-export-again"
        >
          {t('settings.export.saveAgain', {})}
        </Pressable>
      ) : null}
      {state.kind === 'error' ? (
        <p className={styles.error} role="alert">
          {exportErrText(state.error, t)}
        </p>
      ) : null}
    </section>
  );
}
