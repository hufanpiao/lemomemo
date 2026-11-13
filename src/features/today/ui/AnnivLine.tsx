// 今天页顶部的纪念日一行（B5 S14；定稿线框 s1 ANNLINE、皮肤视觉稿今天页胶囊）：“3 天后 김지민 生日”，前面小头像（kit 的 AnnivAvatar，xs）
// 只有 7 天内有纪念日、纪念日开关开着时 TodayPage 才挂它（按需下载）；点了进纪念日页的这一条
import { navigate } from '../../../app/router.ts';
import { AnnivAvatar } from '../../../kit/components/AnnivAvatar.tsx';
import { Pressable } from '../../../motion/components.ts';
import type { AnnivSoon } from '../data/anniv-soon.ts';
import { useTodayT } from '../hooks/useTodayT.ts';
import styles from './TodayPage.module.css';

export default function AnnivLine({ soon }: { soon: AnnivSoon }) {
  const t = useTodayT();
  const { row, days } = soon;
  const name = typeof row['name'] === 'string' ? row['name'] : '';
  const when = days === 0 ? t('today.anniv.today', {}) : days === 1 ? t('today.anniv.tomorrow', {}) : t('today.anniv.in', { n: days });
  return (
    <Pressable type="button" className={styles.anniv} onClick={() => void navigate('anniv', row.id)} data-testid="today-anniv">
      <AnnivAvatar id={row.id} avatarId={row['avatar_id']} name={name} kind={row['kind']} size="xs" />
      <span className={styles.annivWhen}>{when}</span>
      <span className={styles.annivName}>{name}</span>
    </Pressable>
  );
}
