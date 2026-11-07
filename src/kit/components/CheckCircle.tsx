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
  /**
   * 只读行（FA-2，架构 0.27 第 1 点）：aria-disabled、圆圈变淡；点了照样回调 onChange，由使用方拦下并出“要新版本”提示条
   * （不用 disabled：点了没反应、读屏也跳过，用户不知道为什么）。读屏名字后面接“要更新到新版本才能修改”（FA-2 审查第 5 条）
   * 由 ReadonlyRow.tsx 的 RoCheckCircle 拼进 label：那句词条不进首屏（首屏预算 150 KB，11-06），这里只用传进来的 label
   */
  readOnly?: boolean;
}

export function CheckCircle({ checked, label, onChange, testId, readOnly = false }: CheckCircleProps) {
  const state = checked ? 'on' : 'off';
  return (
    <label className={styles.checkBox}>
      <input
        type="checkbox"
        className={styles.check}
        checked={checked}
        aria-label={label}
        aria-disabled={readOnly || undefined}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      <span className={styles.fill} data-state={state} aria-hidden="true" />
      <span className={styles.tick} data-state={state} aria-hidden="true" />
    </label>
  );
}
