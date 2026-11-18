// 打勾方框（B2 FA-5；架构 17.1“勾选完成”；负责人 11-15 R-433 从圆圈改成圆角方框，形状只在 CheckCircle.module.css）：待办页、今天页、子任务共用
// • 名字沿用 CheckCircle（R-433 交给开发定）：改名要动组件、Form 的 look="circle"、查找结果、登记册和测试十几处，行为不变，
//   只换名字的改动不值这些风险；“Circle”在这里指“完成标记”，形状以样式文件为准
// • 读屏和点按都是下面那个真的 checkbox；叠在上面的填充块、勾号只是画（aria-hidden、不接点按）
// • 方框和 checkbox 都跟 checked 走。使用方（TodosPage、TodayPage）传的是界面上该显示的值（点下去当下就是“刚点的值”、
//   留住那一拍里是留住的值，useHoldView 的 shown），所以填满动画不等保存回来，读屏读到的也和看到的一致（代码审查 FA5-CR A3：删掉了没人用的 shown 参数）
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
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
  /**
   * 子任务那一档（负责人 11-18“代办子任务点击完成时也加一个动效，用乙2（新）”，推翻 R-350 的“子任务不播动画”）：
   * 按下、回弹同主待办，小点换成 10 个淡点（更小、扩得近）、没有细正圆；样式在 CheckCircle.module.css 的 .sparkSoft。
   * 勾上一直是亮柠檬黄底、深色勾（同 data-fresh；负责人 11-18“乙2（新）那个动效有暗黄吗？”：子任务勾完留在原地，没有暗黄）
   */
  soft?: boolean;
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
/** 子任务（soft，乙2）：10 个淡点 */
const SPARKS_SOFT = Array.from({ length: 10 }, (_, i) => (360 / 10) * i);

/** 抬手离按下点不超过这么远才算轻点（再远是在滑列表、拖行） */
const TAP_SLOP_PX = 10;
/** 抬手切换以后这么久之内系统补发的 click 不再切换：日志里补发最晚 0.26 s，留足余量；人有意的第二下自己有 pointerup，不受影响 */
const CLICK_SWALLOW_MS = 800;

export function CheckCircle({ checked, label, onChange, testId, readOnly = false, soft = false, progress, fresh = false }: CheckCircleProps) {
  const state = checked ? 'on' : 'off';
  // 回弹（画面层 .face 上的 .pop）、一圈小点和细正圆只在用户亲手勾上的那一下开始（key 换一次重播一次）；挂载时已经勾上的、只读拦下的都不开始。
  // 清零有两处，不靠“动画一定会播完”：画面层自己的回弹播完（--dur-done-pop 420ms，比小点 --dur-done-spark-at + --dur-spark = 410ms、
  // 细正圆 345ms 都晚，是最后结束的）；方框变回没勾上（点回去、撤销、写入失败照数据退回，不管动画播完没有）。
  // 所以减弱动态效果时（CSS 里这几段都是 animation: none，animationend 永远不来——独立评审提过“清不掉、之后会重播”）
  // .pop 留着也什么都不画（小点 display: none），一变回没勾上就清掉，之后照数据再显示成勾上不会重播。
  // 不在这里读 data-rm：引 motion/index.ts 会把它拆成首屏多出来的一块（构建的首屏文件数上限）
  const [pop, setPop] = useState(0);
  if (!checked && pop > 0) setPop(0);
  const popping = checked && pop > 0;
  const stage = !checked && progress ? partStage(progress.done, progress.total) : 0;
  const ratio = stage && progress ? Math.min(1, progress.done / progress.total) : 0;
  // 按下缩放（定稿 ① 按下 0.45）：按在 label 任何地方（含 44 外扩区）都给画面层打 data-press，松手、取消时去掉。
  // 不用 .checkBox:active 缩 .face：lint 的 lemo/reduced-motion-override 要求状态写在缩放的元素自己身上；
  // 松手听 window：左滑行的手势可能把指针捕获到行面上，label 收不到 pointerup。直接改 DOM 属性，不走 React 重画
  const faceRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLLabelElement>(null);
  const swallowUntil = useRef(0);
  const apply = (v: boolean): void => {
    if (v && !readOnly) setPop((n) => n + 1);
    onChange(v);
  };
  // 手指抬起就切换（负责人 11-18“待办点击完成还是会有点完延迟或者不执行”）：运行日志 preview.405 里 131 次轻点，pointerup 都是当下到，
  // click 却有四十多次晚 0.2～0.26 秒、二十次两下快点只来一个（iOS 等着认双击）。所以触摸、笔在按下点 10 px 以内抬起时这里直接切换，
  // 之后 800 ms 内系统补发的 click 在 label 上拦掉（不然会再切回去）；鼠标、键盘（空格）照旧走 input 自己的 click → onChange
  useEffect(() => {
    const lb = labelRef.current;
    if (!lb) return undefined;
    const onClick = (ev: MouseEvent): void => {
      if (performance.now() >= swallowUntil.current) return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    lb.addEventListener('click', onClick, true);
    return () => lb.removeEventListener('click', onClick, true);
  }, []);
  const press = (e: ReactPointerEvent): void => {
    const el = faceRef.current;
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    el.setAttribute('data-press', '');
    const { pointerId, pointerType, clientX: x0, clientY: y0 } = e;
    const off = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      el.removeAttribute('data-press');
      window.removeEventListener('pointerup', off, true);
      window.removeEventListener('pointercancel', off, true);
      const input = inputRef.current;
      if (pointerType === 'mouse' || ev.type !== 'pointerup' || !input) return;
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > TAP_SLOP_PX) return;
      swallowUntil.current = performance.now() + CLICK_SWALLOW_MS;
      apply(!input.checked);
    };
    window.addEventListener('pointerup', off, true);
    window.addEventListener('pointercancel', off, true);
  };
  return (
    <label ref={labelRef} className={styles.checkBox} data-fresh={(fresh || soft) && checked ? '' : undefined} onPointerDown={press}>
      {/* 画面层：按下缩放、回弹缩这一层，外层 label 的 44 点击区不缩（11-18 点不中，见 CheckCircle.module.css 的 .face） */}
      <span
        ref={faceRef}
        className={popping ? `${styles.face} ${styles.pop}` : styles.face}
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
          ref={inputRef}
          onChange={(e) => apply(e.target.checked)}
          data-testid={testId}
        />
        {stage ? (
          <span className={styles.part} style={{ '--part': String(ratio) } as CSSProperties} data-stage={stage} aria-hidden="true" />
        ) : null}
        <span className={styles.fill} data-state={state} aria-hidden="true" />
        <span className={styles.tick} data-state={state} aria-hidden="true" />
        {popping ? (
          <span key={pop} className={styles.burst} aria-hidden="true">
            {soft ? null : <b className={styles.ring} />}
            {(soft ? SPARKS_SOFT : SPARKS).map((a) => (
              <i key={a} className={soft ? styles.sparkSoft : styles.spark} style={{ '--a': `${a}deg` } as CSSProperties} />
            ))}
          </span>
        ) : null}
      </span>
    </label>
  );
}
