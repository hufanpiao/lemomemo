// 今天页顶部的纪念日一行（B5 S14；定稿线框 s1 ANNLINE、皮肤视觉稿今天页胶囊）：“3 天后 김지민 生日”，前面小头像
// • 头像经 anniv/index.ts 懒加载 AnnivFace（取图要 platform/files，不进首屏），由 kit 的 AnnivAvatarSlot 挂；没加载好、分包下不来时画首字圆
// • 纪念日开关开着、有纪念日时 TodayPage 才挂它（按需下载）；这里再挑 7 天内最近的一个，没有就不画；点了进纪念日页的这一条
// • 生日那一种名字后面写“生日”（线框 ANNLINE“3 天后 김지민 生日”，B6 对齐线框）；名字里已经写了（“妈妈生日”）不再加。纪念日、倒数日的名字本身就是事情（“结婚纪念日”），不加
import type { DateStr } from '../../../../shared/core/date.ts';
import { navigate } from '../../../app/router.ts';
import { AnnivAvatarSlot } from '../../../kit/components/AnnivAvatar.tsx';
import { Pressable } from '../../../motion/components.ts';
import { AnnivFace } from '../../anniv/index.ts';
import { useAnnivSoon } from '../hooks/useAnnivSoon.ts';
import { useTodayT } from '../hooks/useTodayT.ts';
import styles from './TodayPage.module.css';

export default function AnnivLine({ today }: { today: DateStr }) {
  const t = useTodayT();
  const soon = useAnnivSoon(today);
  if (!soon) return null;
  const { row, days } = soon;
  const name = typeof row['name'] === 'string' ? row['name'] : '';
  const bday = t('today.anniv.bday', {});
  const label = row['kind'] === 'birthday' && !name.includes(bday) ? `${name} ${bday}` : name;
  const when = days === 0 ? t('today.anniv.today', {}) : days === 1 ? t('today.anniv.tomorrow', {}) : t('today.anniv.in', { n: days });
  return (
    <Pressable type="button" className={styles.anniv} onClick={() => void navigate('anniv', row.id)} data-testid="today-anniv">
      <AnnivAvatarSlot Face={AnnivFace} id={row.id} avatarId={row['avatar_id']} name={name} kind={row['kind']} size="xs" />
      <span className={styles.annivWhen}>{when}</span>
      <span className={styles.annivName}>{label}</span>
    </Pressable>
  );
}
