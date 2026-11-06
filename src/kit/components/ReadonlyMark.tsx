// 只读行的行尾小标记（FA-2 只读行界面；架构 0.27 第 1 点）：看得见的字“要新版本”，读屏读整句“要更新到新版本才能修改”（架构原文的 aria-label）。
// 单独一个小文件：今天页首屏只带它，横幅和提示条（ReadonlyRow.tsx，连着 UndoToast）按需下载（首屏预算 150 KB，FA-2 返工）
import { useRoT } from '../hooks/useRoT.ts';
import styles from './ReadonlyMark.module.css';

export function ReadonlyMark({ testId }: { testId?: string }) {
  const t = useRoT();
  return (
    <span className={styles.mark} data-testid={testId}>
      <span aria-hidden="true">{t('ro.mark', {})}</span>
      <span className={styles.sr}>{t('ro.markLabel', {})}</span>
    </span>
  );
}
