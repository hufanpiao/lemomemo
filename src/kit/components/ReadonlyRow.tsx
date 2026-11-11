// 只读行的横幅和提示条（FA-2 只读行界面；架构 0.27 第 1 点、开发计划三之二）：日程、待办、今天页、日历共用；行尾标记在 ./ReadonlyMark.tsx
// • RepeatBanner：日历和今天页顶部“有 N 条重复事项要新版本才能完整显示 · 更新”；条数自己数（kit 的 useRepeatPending），N 为 0 时不画。
//   页面在没有只读行时不挂它（useReadonlyGuard 的 any）；今天页还把它和页底提示条一起按需下载（首屏预算 150 KB，FA-2 返工）。
//   “更新”做什么由调用方给（功能里调 platform 的 requestAppUpdate；kit 不碰 platform）
// • ReadonlyToast：点这一行、打勾、删除被拦下以后的提示条“这条要新版本才能修改 · 更新”（kit 的 UndoToast；状态在 useReadonlyGuard）。
//   role="alert"：每次拦下都新挂一条，新挂的 status 区域 iOS VoiceOver 常常不读；alert 新挂上就读（FA-2 审查第 1 条）
// • RoCheckCircle：打勾圆圈，只读时读屏名字后接“要更新到新版本才能修改”（FA-2 审查第 5 条）；词条在 ro 词典、不进首屏，
//   所以拼名字放这里、不放 CheckCircle（今天页的只读行按需下载它，11-06）
import type { ReadonlyGuard } from '../hooks/useReadonly.ts';
import { useRepeatPending } from '../hooks/useRepeatPending.ts';
import { useRoT } from '../hooks/useRoT.ts';
import { CheckCircle, type CheckCircleProps } from './CheckCircle.tsx';
import { UndoToast } from './UndoToast.tsx';
import styles from './ReadonlyRow.module.css';

export { ReadonlyMark } from './ReadonlyMark.tsx';

export function RepeatBanner({ onUpdate, testId }: { onUpdate(): void; testId?: string }) {
  const t = useRoT();
  const n = useRepeatPending();
  if (n <= 0) return null;
  return (
    <div className={`${styles.banner} ${styles.repeat}`} data-testid={testId}>
      <p className={styles.text}>{t('ro.repeat', { n })}</p>
      <button type="button" className={styles.update} onClick={onUpdate} data-testid={testId ? `${testId}-update` : undefined}>
        {t('ro.update', {})}
      </button>
    </div>
  );
}

/** message：各功能自己词典里的“这条要新版本才能修改”（和编辑页同一句） */
export function ReadonlyToast<T>({ guard, message, testId }: { guard: ReadonlyGuard<T>; message: string; testId: string }) {
  const t = useRoT();
  const at = guard.toastAt;
  if (at === null) return null;
  return (
    <UndoToast key={at} role="alert" message={message} undoLabel={t('ro.update', {})} onUndo={guard.update} onClose={() => guard.close(at)} data-testid={testId} />
  );
}

export function RoCheckCircle(p: CheckCircleProps) {
  const t = useRoT();
  return <CheckCircle {...p} label={p.readOnly ? t('ro.named', { label: p.label }) : p.label} />;
}
