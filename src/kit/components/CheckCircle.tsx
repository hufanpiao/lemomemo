// 打勾方框（B2 FA-5；架构 17.1“勾选完成”；负责人 11-15 R-433 从圆圈改成圆角方框，形状只在 CheckCircle.module.css）：待办页、今天页、子任务共用
// • 名字沿用 CheckCircle（R-433 交给开发定）：改名要动组件、Form 的 look="circle"、查找结果、登记册和测试十几处，行为不变，
//   只换名字的改动不值这些风险；“Circle”在这里指“完成标记”，形状以样式文件为准
// • 读屏和点按都是下面那个真的 checkbox；叠在上面的填充块、勾号只是画（aria-hidden、不接点按）
// • 方框和 checkbox 都跟 checked 走。使用方（TodosPage、TodayPage）传的是界面上该显示的值（点下去当下就是“刚点的值”、
//   留住那一拍里是留住的值，useHoldView 的 shown），所以填满动画不等保存回来，读屏读到的也和看到的一致（代码审查 FA5-CR A3：删掉了没人用的 shown 参数）
import { useState, type CSSProperties } from 'react';
import styles from './CheckCircle.module.css';

export interface CheckCircleProps {
  checked: boolean;
  label: string;
  onChange(v: boolean): void;
  testId: string;
  /**
   * 只读行（FA-2，架构 0.27 第 1 点）：aria-disabled、方框变淡；点了照样回调 onChange，由使用方拦下并出“要新版本”提示条
   * （不用 disabled：点了没反应、读屏也跳过，用户不知道为什么）。读屏名字后面接“要更新到新版本才能修改”（FA-2 审查第 5 条）
   * 由 ReadonlyMark.tsx 的 RoCheckCircle 拼进 label：那句词条不进首屏（首屏预算 150 KB，11-06），这里只用传进来的 label
   */
  readOnly?: boolean;
  /** 不播勾选动效（子任务一天勾上百次，R-350）：直接到位；样式在 CheckCircle.module.css 的 .checkBox[data-still] */
  still?: boolean;
  /**
   * 子任务做到几成（负责人 11-17 选 T-A“方框里用小表情表示子任务做到几成”）：没勾上、done 大于 0 时方框从下往上按比例填淡柠檬黄，
   * 中间一张“小脸”——不到一半一个点（起步）、一半及以上两个点（大半）；子任务全做完、主待办还没勾（编辑页改过、别处同步来的）时
   * 满填、不画脸（主持人 11-17 评审）；只是画（aria-hidden），几项做完由行里的文字和读屏说
   */
  progress?: { done: number; total: number } | undefined;
}

/** 做到几成的档：0 没开始，1 起步（不到一半），2 大半（一半及以上、没做完），3 全做完；待办页的“起步 / 大半”标签同一个分法（3 不出标签） */
export function partStage(done: number, total: number): 0 | 1 | 2 | 3 {
  if (total <= 0 || done <= 0) return 0;
  if (done >= total) return 3;
  return done * 2 < total ? 1 : 2;
}

/** 勾上那一下外扩的一圈小点（勾选完成时间线第 ③ 段，负责人 11-17）：8 个，45° 一个 */
const BURST = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export function CheckCircle({ checked, label, onChange, testId, readOnly = false, still = false, progress }: CheckCircleProps) {
  const state = checked ? 'on' : 'off';
  // 放大过头（label 上的 .pop）和一圈小点只在用户亲手勾上的那一下播（key 换一次重播一次）；挂载时已经勾上的、只读拦下的、子任务（still）都不播；
  // 外圈那道边播完（它和小点同时起、同样长，是勾选特效里最后结束的：--dur-done-burst-at + --dur-burst 晚于 --dur-done-pop）清零、拿掉这一圈，
  // 之后再重新画（例如撤销以后又照数据显示成勾上）不会重播；减弱动态效果时外圈不播，pop 留着也不画什么（.pop、.ring 都是 animation: none）；
  // 取消勾时 .pop 跟着拿掉，再勾时重新加上、重播
  const [pop, setPop] = useState(0);
  const popping = checked && pop > 0;
  const stage = !checked && progress ? partStage(progress.done, progress.total) : 0;
  const ratio = stage && progress ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <label
      className={popping ? `${styles.checkBox} ${styles.pop}` : styles.checkBox}
      data-still={still || undefined}
    >
      <input
        type="checkbox"
        className={styles.check}
        checked={checked}
        aria-label={label}
        aria-disabled={readOnly || undefined}
        onChange={(e) => {
          if (e.target.checked && !still && !readOnly) setPop((n) => n + 1);
          onChange(e.target.checked);
        }}
        data-testid={testId}
      />
      {stage ? (
        <span className={styles.part} style={{ '--part': String(ratio) } as CSSProperties} data-stage={stage} aria-hidden="true" />
      ) : null}
      <span className={styles.fill} data-state={state} aria-hidden="true" />
      <span className={styles.tick} data-state={state} aria-hidden="true" />
      {popping ? (
        <span key={pop} className={styles.burst} aria-hidden="true">
          <b className={styles.ring} onAnimationEnd={() => setPop(0)} />
          {BURST.map((a) => (
            <i key={a} style={{ '--a': `${a}deg` } as CSSProperties} />
          ))}
        </span>
      ) : null}
    </label>
  );
}
