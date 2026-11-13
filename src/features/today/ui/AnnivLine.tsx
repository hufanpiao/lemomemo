// 今天页顶部的纪念日一行（B5 S14；定稿线框 s1 ANNLINE、皮肤视觉稿今天页胶囊）：“3 天后 김지민 生日”，前面小头像
// • 头像经 anniv/index.ts 懒加载 AnnivFace（取图要 platform/files，不进首屏）；没加载好时画 kit 的首字圆（分包下不来那个圆不画，名字照常）
// • 只有 7 天内有纪念日、纪念日开关开着时 TodayPage 才挂它（按需下载）；点了进纪念日页的这一条
import { Suspense } from 'react';
import { navigate } from '../../../app/router.ts';
import { AnnivAvatar } from '../../../kit/components/AnnivAvatar.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { Pressable } from '../../../motion/components.ts';
import { AnnivFace } from '../../anniv/index.ts';
import type { AnnivSoon } from '../hooks/useAnnivSoon.ts';
import { useTodayT } from '../hooks/useTodayT.ts';
import styles from './TodayPage.module.css';

export default function AnnivLine({ soon }: { soon: AnnivSoon }) {
  const t = useTodayT();
  const { row, days } = soon;
  const name = typeof row['name'] === 'string' ? row['name'] : '';
  const when = days === 0 ? t('today.anniv.today', {}) : days === 1 ? t('today.anniv.tomorrow', {}) : t('today.anniv.in', { n: days });
  const plain = <AnnivAvatar url={null} name={name} kind={row['kind']} size="xs" />;
  return (
    <Pressable type="button" className={styles.anniv} onClick={() => void navigate('anniv', row.id)} data-testid="today-anniv">
      {row['avatar_id'] ? (
        <QuietBoundary name="anniv-face">
          <Suspense fallback={plain}>
            <AnnivFace id={row.id} avatarId={row['avatar_id']} name={name} kind={row['kind']} size="xs" />
          </Suspense>
        </QuietBoundary>
      ) : (
        plain
      )}
      <span className={styles.annivWhen}>{when}</span>
      <span className={styles.annivName}>{name}</span>
    </Pressable>
  );
}
