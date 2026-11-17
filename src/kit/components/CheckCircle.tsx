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
  /**
   * 这一行刚勾上、还留在原位（负责人选“乙”，R-436 改）：勾上时填充、边画成亮柠檬黄、勾号深色；收进“已完成”以后、挂载时就勾上的照旧暗黄。
   * 由使用方按行的状态给（kit TodoRow 给 useDoneFlow 的 fresh：linger 里按“勾上”留着的那几条），不放在组件自己的状态里：
   * 今天页“已过去”展开时，收完的那一行和原来同一个 key、同一张列表，组件不重新挂载，自己的状态会一直留着
   */
  fresh?: boolean | undefined;
}

/** 做到几成的档：0 没开始，1 起步（不到一半），2 大半（一半及以上、没做完），3 全做完；待办页的“起步 / 大半”标签同一个分法（3 不出标签） */
export function partStage(done: number, total: number): 0 | 1 | 2 | 3 {
  if (total <= 0 || done <= 0) return 0;
  if (done >= total) return 3;
  return done * 2 < total ? 1 : 2;
}

/** 勾上那一下长出来的一圈小点（勾选完成时间线第 ③ 段，负责人 11-18 定稿乙4）：14 个，每 360/14 度一个 */
const SPARKS = Array.from({ length: 14 }, (_, i) => (360 / 14) * i);

export function CheckCircle({ checked, label, onChange, testId, readOnly = false, still = false, progress, fresh = false }: CheckCircleProps) {
  const state = checked ? 'on' : 'off';
  // 回弹（label 上的 .pop）、一圈小点和细正圆只在用户亲手勾上的那一下开始（key 换一次重播一次）；挂载时已经勾上的、只读拦下的、子任务（still）都不开始。
  // 清零有两处，不靠“动画一定会播完”：label 自己的回弹播完（--dur-done-pop 420ms，比小点 --dur-done-spark-at + --dur-spark = 410ms、
  // 细正圆 345ms 都晚，是最后结束的）；方框变回没勾上（点回去、撤销、写入失败照数据退回，不管动画播完没有）。
  // 所以减弱动态效果时（CSS 里这几段都是 animation: none，animationend 永远不来——独立评审提过“清不掉、之后会重播”）
  // .pop 留着也什么都不画（小点 display: none），一变回没勾上就清掉，之后照数据再显示成勾上不会重播。
  // 不在这里读 data-rm：引 motion/index.ts 会把它拆成首屏多出来的一块（构建的首屏文件数上限）
  const [pop, setPop] = useState(0);
  if (!checked && pop > 0) setPop(0);
  const popping = checked && pop > 0;
  const stage = !checked && progress ? partStage(progress.done, progress.total) : 0;
  const ratio = stage && progress ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <label
      className={popping ? `${styles.checkBox} ${styles.pop}` : styles.checkBox}
      data-still={still || undefined}
      data-fresh={fresh && checked ? '' : undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setPop(0);
      }}
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
          <b className={styles.ring} />
          {SPARKS.map((a) => (
            <i key={a} style={{ '--a': `${a}deg` } as CSSProperties} />
          ))}
        </span>
      ) : null}
    </label>
  );
}
