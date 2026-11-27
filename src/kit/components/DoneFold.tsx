// “已完成 N ›”折叠行：
// 组标题本身就是展开 / 收起的按钮（aria-expanded），› 的朝向跟着 data-open 转。待办页（TodosPage）、网页版今天页（TodayDesk）同一个。
// 分组名的字号、颜色、左右排开是 Form.module.css 的 groupLabel、groupRow（同 Form.tsx 的 groupRowClass；直接引样式表，不引 Form.tsx 那份 JS）
import form from './Form.module.css';
import styles from './DoneFold.module.css';

export function DoneFold({ title, open, onToggle, testId, className }: { title: string; open: boolean; onToggle(): void; testId: string; className?: string | undefined }) {
  return (
    <h2 className={[form.groupLabel, form.groupRow, className].filter(Boolean).join(' ')}>
      <button type="button" className={styles.fold} aria-expanded={open} onClick={onToggle} data-testid={testId}>
        {title}
        <span className={styles.chev} data-open={open ? '' : undefined} aria-hidden="true">›</span>
      </button>
    </h2>
  );
}
