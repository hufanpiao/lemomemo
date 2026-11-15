// “最近删除”入口（审查 11-15 第 2 条：原来随手记页、隐私记页、插图提示、编辑页插图提示各写一份，合成这一个）：是链接不是按钮——
// 地址经 hrefOf（A26），能长按、Ctrl 点、中键在新标签页打开；普通点按交给路由（navigate）。kit 不引功能的词典：文案由调用方传（带不带条数也由调用方拼）
// • look 不给：列表上方居中的一颗细线胶囊（随手记页、隐私记页、待办页标题下面；外观同原来的 FormButton ghost：高 --hit、细线描边、14 号字）
// • look="inline"：句子里接在后面的一个下划线链接（插图空间满了的提示、设置里“完成 7 天后自动删除”的说明），点击区照样不小于 --hit 高
// to 是要去的路由和参数（同 navigate 的参数）：随手记、待办去 #/trash，隐私记去 #/vault/trash
import { hrefOf, navigate, plainClick, type RouteName } from '../../app/router.ts';
import styles from './TrashLink.module.css';

export interface TrashLinkProps {
  to: readonly [RouteName, ...string[]];
  label: string;
  testId: string;
  look?: 'inline' | undefined;
}

export function TrashLink({ to, label, testId, look }: TrashLinkProps) {
  const a = (
    <a className={look === 'inline' ? styles.inline : styles.pill} href={hrefOf(...to)} onClick={(e) => plainClick(e) && void navigate(...to)} data-testid={testId}>
      {label}
    </a>
  );
  return look === 'inline' ? a : <div className={styles.row}>{a}</div>;
}
