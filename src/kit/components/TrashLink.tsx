// “最近删除”入口（随手记页、隐私记页、插图提示、编辑页插图提示共用这一个）：是链接不是按钮——
// 地址经 hrefOf，能长按、Ctrl 点、中键在新标签页打开；普通点按交给路由（navigate）。kit 不引功能的词典：文案由调用方传（带不带条数也由调用方拼）
// • look="inline"：句子里接在后面的一个下划线链接（插图空间满了的提示、设置里“完成 7 天后自动删除”的说明），点击区照样不小于 --hit 高
// • look="icon"：顶栏里头像左边（电脑版是随手记、隐私记分类栏标题右边）一个垃圾桶线条图标，次要色、无描边、触控区 --hit；
//   字不显示，label 当读屏名称（aria-label）和悬停提示（title）；不加红点（红色只表示逾期）
// to 是要去的路由和参数（同 navigate 的参数）：随手记、待办去 #/trash，隐私记去 #/vault/trash
import type { MouseEvent } from 'react';
import { hrefOf, navigate, plainClick, type RouteName } from '../../app/router.ts';
import styles from './TrashLink.module.css';

export interface TrashLinkProps {
  to: readonly [RouteName, ...string[]];
  label: string;
  testId: string;
  look: 'inline' | 'icon';
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
  return (
    <a className={styles.inline} href={hrefOf(...to)} onClick={go} data-testid={testId}>
      {label}
    </a>
  );
}
