// 顶栏右上角的设置入口（头像，R-381）：今天、待办、日历、随手记四页共用这一个，同一个样式、同一个跳转。
// 负责人 11-05 ① 今天页先有；11-11 R-381“进入设置的头像页面在日历跟代办上也放一个吧，不然不和谐”。
// 点了交给路由压一条带本次编号的历史（R-372）：设置里“‹ 返回”和左滑都退回原页；新标签页打开（中键、Ctrl 点）照常。
// 圆圈、字和人形在 MeAvatar（设置首页账号一行也用）；电脑版（≥ 900px）设置入口在侧栏最下面，这里藏掉
import { hrefOf, navigateTab, plainClick } from '../../app/router.ts';
import { useT } from '../hooks/useT.ts';
import { MeAvatar } from './MeAvatar.tsx';
import styles from './MeLink.module.css';

export function MeLink({ testId }: { testId: string }) {
  const t = useT();
  return (
    <a className={styles.me} href={hrefOf('settings')} onClick={(e) => plainClick(e) && navigateTab('settings')} aria-label={t('app.settings', {})} data-testid={testId}>
      <MeAvatar />
    </a>
  );
}
