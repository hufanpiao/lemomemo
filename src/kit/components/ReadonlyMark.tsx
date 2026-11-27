// 只读行的行尾小标记：看得见的字“要新版本”，读屏读整句“要更新到新版本才能修改”。
// 单独一个小文件：今天页首屏只带它，横幅和提示条（ReadonlyRow.tsx，连着 UndoToast）按需下载（首屏预算 150 KB）
// RoCheckCircle（打勾方框，只读时读屏名字后接“要更新到新版本才能修改”）也在这里；
// ReadonlyPart 是 kit TodoRow 的只读部件（useTodoRows 的 TodoRowParts.Ro）：待办页、日历静态给它，今天页经 TodayToasts.tsx 按需下载（只读词典不进首屏）
import { useRoT } from '../hooks/useRoT.ts';
import { CheckCircle, type CheckCircleProps } from './CheckCircle.tsx';
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

export function RoCheckCircle(p: CheckCircleProps) {
  const t = useRoT();
  return <CheckCircle {...p} label={p.readOnly ? t('ro.named', { label: p.label }) : p.label} />;
}

/** 只读行的两块：行尾标记（mark）、打勾方框（check） */
export type ReadonlyPartProps = { part: 'mark'; testId: string } | ({ part: 'check' } & CheckCircleProps);

export function ReadonlyPart(p: ReadonlyPartProps) {
  if (p.part === 'mark') return <ReadonlyMark testId={p.testId} />;
  const { part: _, ...c } = p;
  return <RoCheckCircle {...c} />;
}
