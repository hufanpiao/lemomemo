// 打勾圆圈（B2 FA-5；架构 17.1“勾选完成”）：待办页、今天页共用
// • 读屏和点按都是下面那个真的 checkbox；叠在上面的圆盘、勾号只是画（aria-hidden、不接点按）
// • 圆圈和 checkbox 都跟 checked 走。使用方（TodosPage、TodayPage）传的是界面上该显示的值（点下去当下就是“刚点的值”、
//   留住那一拍里是留住的值，useHoldView 的 shown），所以填满动画不等保存回来，读屏读到的也和看到的一致（代码审查 FA5-CR A3：删掉了没人用的 shown 参数）
import styles from './CheckCircle.module.css';

export interface CheckCircleProps {
  checked: boolean;
  label: string;
  onChange(v: boolean): void;
  testId: string;
}

export function CheckCircle({ checked, label, onChange, testId }: CheckCircleProps) {
  const state = checked ? 'on' : 'off';
  return (
    <span className={styles.checkBox}>
      <input type="checkbox" className={styles.check} checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className={styles.fill} data-state={state} aria-hidden="true" />
      <span className={styles.tick} data-state={state} aria-hidden="true" />
    </span>
  );
}
