// 设置 › 数据（R-256 ②；B1 只有“导出全部”一行；架构第 6 节 account export、0.29 续第 93、96 条）
// • 断网时按钮不可点，右边写“联网后才能导出”
// • 导出中：按钮忙，状态区写“正在导出…”
// • 成功：“已导出，通知邮件已发到你的邮箱”；B1 一律没带隐私记令牌，再加一句“隐私记没有导出（没解锁）”；
//   没存下来（分享面板取消等）写“还没存下来”；两种情况都给“再存一次”（不再调服务器；存的过程中按钮禁用，防连点）
import { Pressable } from '../../../motion/components.ts';
import { useExport, type AccountActionDeps } from '../hooks/useAccountActions.ts';
import { useOnline } from '../hooks/useOnline.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { accountErrText } from './AccountSection.tsx';
import styles from './SettingsPage.module.css';

export function DataSection({ account, onExported }: { account: AccountActionDeps; onExported?: () => void }) {
  const t = useSettingsT();
  const online = useOnline();
  const { state, saving, run, saveAgain } = useExport(account, onExported);
  const busy = state.kind === 'busy';
  return (
    <section aria-labelledby="settings-data-title" data-section="data">
      <h2 id="settings-data-title" className={styles.gt}>
        {t('settings.data.title', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <Pressable
            className={styles.rowBtn}
            disabled={!online || busy}
            aria-busy={busy}
            aria-describedby="settings-export-note"
            onClick={() => void run()}
            data-testid="settings-export"
          >
            <span className={styles.tx}>{t('settings.account.export', {})}</span>
            <span id="settings-export-note" className={styles.v}>
              {online ? t('settings.export.hint', {}) : t('settings.export.offline', {})}
            </span>
          </Pressable>
        </li>
      </ul>
      <div className={styles.status} role="status" data-testid="settings-export-status">
        {busy ? t('settings.export.busy', {}) : null}
        {state.kind === 'done' ? (
          <>
            <p className={styles.line}>{state.saved ? t('settings.export.done', {}) : t('settings.export.notSaved', {})}</p>
            {state.file.vaultOmitted ? <p className={styles.line}>{t('settings.export.vaultOmitted', {})}</p> : null}
          </>
        ) : null}
      </div>
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
          {accountErrText(state.error, t)}
        </p>
      ) : null}
    </section>
  );
}
