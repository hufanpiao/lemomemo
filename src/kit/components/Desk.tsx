// 网页版宽屏的页头和卡片（右边常驻 AI 助手栏）
// 今天、日历、待办、随手记、纪念日、设置共用：页面在宽屏（kit useMedia 的 MQ_DESK_WIDE）时 main 挂 deskFrameOf(路由名)，页头用 DeskHead，内容放进 DeskCard。
// 外框、页头、卡片的数都在 Desk.module.css（读 base.css 的 --dk-*）；右边的 AI 助手栏是 ai-chat 的 ChatDock，位置用同一组数，顶底和卡片齐平。
// 右边让不让出 AI 栏只看路由表（app/router.ts LEVELS 的 dock，经 router-levels.ts 的 dockOf，同 ChatHost 挂不挂栏），页面不自己另写规则
import type { ReactNode } from 'react';
import styles from './Desk.module.css';

/** 宽屏时挂在页面 main 上的类：铺满一屏；这一页有常驻 AI 栏才让出右边，没有（隐私记）就到窗口右边 16。
 *  dock 由页面传 app/router-levels.ts 的 dockOf(本页路由名)（kit 不引 app 的这一层） */
export const deskFrameOf = (dock: string | undefined): string => (dock ? (styles.frame ?? '') : `${styles.frame ?? ''} ${styles.bare ?? ''}`);
/** 宽屏时不铺满一屏、照常整页滚的页（最近删除）挂的类：内容列宽照旧，右边让出 AI 栏（有 dock 的页才挂） */
export const deskAside: string = styles.aside ?? '';
/** 页头下面内容区的 grid（几栏几行由页面写 grid-template） */
export const deskGrid: string = styles.grid ?? '';
/** 卡片的类（自己画外层元素的卡片用，如今日运势卡、周历卡） */
export const deskCard: string = styles.card ?? '';
/** 大标题（h1 或日历的年月按钮里那段字）用的类 */
export const deskTitle: string = styles.title ?? '';

/** 页头：左边大标题 + 下一行小字，右边工具；标题由页面自己画（今天页是 h1，日历是选年月的按钮） */
export function DeskHead({ title, sub, tools }: { title: ReactNode; sub: ReactNode; tools?: ReactNode }) {
  return (
    <div className={styles.head}>
      <div className={styles.headL}>
        {title}
        {sub === null ? null : <p className={styles.sub}>{sub}</p>}
      </div>
      {tools ? <div className={styles.tools}>{tools}</div> : null}
    </div>
  );
}

export interface DeskCardProps {
  /** 卡片标题；不给就不画标题行 */
  title?: ReactNode;
  /** 标题行右边：条数，或“日历 ›”这类跳转（onGo 给了就画成按钮） */
  end?: ReactNode;
  onGo?: (() => void) | undefined;
  className?: string | undefined;
  /** 卡片用什么标签（有标题的块用 section） */
  as?: 'div' | 'section';
  children?: ReactNode;
  'data-testid'?: string;
  /** 同一页里换层时只换这一栏（打 data-swap-part，motion 的 fadeSwap part；如网页版宽屏设置的右边详情） */
  part?: boolean;
}

export function DeskCard({ title, end, onGo, className, as: Tag = 'section', children, 'data-testid': testId, part }: DeskCardProps) {
  return (
    <Tag className={className ? `${styles.card} ${className}` : styles.card} data-testid={testId} data-swap-part={part ? '' : undefined}>
      {title === undefined ? null : (
        <h2 className={styles.cardH}>
          <span>{title}</span>
          {onGo ? (
            <button type="button" className={styles.go} onClick={onGo}>
              {end}
            </button>
          ) : (
            <span>{end}</span>
          )}
        </h2>
      )}
      {children}
    </Tag>
  );
}
