// “最近删除”入口（审查 11-15 第 2 条：原来随手记页、隐私记页、插图提示、编辑页插图提示各写一份，合成这一个）：是链接不是按钮——
// 地址经 hrefOf（A26），能长按、Ctrl 点、中键在新标签页打开；普通点按交给路由（navigate）。kit 不引功能的词典：文案由调用方传（带不带条数也由调用方拼）
// • look 不给：列表上方居中的一颗细线胶囊（R-438 起只剩电脑版随手记、隐私记列表栏上方用；外观同原来的 FormButton ghost：高 --hit、细线描边、14 号字）
// • look="inline"：句子里接在后面的一个下划线链接（插图空间满了的提示、设置里“完成 7 天后自动删除”的说明），点击区照样不小于 --hit 高
// • look="icon"（R-438，负责人 11-16 嫌标题下面那颗胶囊“太突兀”，选标题行右边小图标）：顶栏里头像左边一个垃圾桶线条图标，次要色、无描边、触控区 --hit；
//   字不显示，label 当读屏名称（aria-label）和悬停提示（title）；不加红点（红色只表示逾期）
// to 是要去的路由和参数（同 navigate 的参数）：随手记、待办去 #/trash，隐私记去 #/vault/trash
import type { MouseEvent } from 'react';
import { hrefOf, navigate, plainClick, type RouteName } from '../../app/router.ts';
import styles from './TrashLink.module.css';

export interface TrashLinkProps {
  to: readonly [RouteName, ...string[]];
  label: string;
  testId: string;
  look?: 'inline' | 'icon' | undefined;
}

export function TrashLink({ to, label, testId, look }: TrashLinkProps) {
  const go = (e: MouseEvent) => plainClick(e) && void navigate(...to);
  if (look === 'icon') {
    return (
      <a className={styles.icon} href={hrefOf(...to)} onClick={go} aria-label={label} title={label} data-testid={testId}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7M10.2 11v5.2M13.8 11v5.2" />
        </svg>
      </a>
    );
  }
  const a = (
    <a className={look === 'inline' ? styles.inline : styles.pill} href={hrefOf(...to)} onClick={go} data-testid={testId}>
      {label}
    </a>
  );
  return look === 'inline' ? a : <div className={styles.row}>{a}</div>;
}
