// “最近的纪念日”卡：
// 宽屏今天页第三行最右、日历页下面右边各一张，同一份（日历页经 index.ts 的 SoonCard 懒加载）
// • 30 天内的纪念日全部列出；一个都没有就列离今天最近的那一个（不管多远）；一个纪念日都没有才写空状态（data/anniv-soon.ts 的 annivRecent）
// • 每行：头像（kit AnnivAvatarSlot，取图经 anniv/index.ts 懒加载 AnnivFace，没加载好先画首字圆）、“3 天后”、名字；名字、“3 天后”和手机纪念日一行同一份
// • 点一行进纪念日页的这一条，点“纪念日”进纪念日页
import type { DateStr } from '../../../../shared/core/date.ts';
import { navigate } from '../../../app/router.ts';
import { AnnivAvatarSlot, type AnnivAvatarSize } from '../../../kit/components/AnnivAvatar.tsx';
import { DeskCard } from '../../../kit/components/Desk.tsx';
import { AnnivFace } from '../../anniv/index.ts';
import { annivLabel, annivWhen, nameOf, useAnnivRecent } from '../hooks/useAnnivUpcoming.ts';
import { useTodayDeskT } from '../hooks/useTodayDeskT.ts';
import { useTodayT } from '../hooks/useTodayT.ts';
import styles from './TodayDesk.module.css';

/** 看多少天内的纪念日 */
const RECENT_DAYS = 30;
/** 每行头像 44px（md，同纪念日页手机布局“最近一个”卡） */
const RECENT_AVATAR: AnnivAvatarSize = 'md';

export default function SoonCard({ today }: { today: DateStr }) {
  const t = useTodayDeskT();
  const tt = useTodayT();
  const list = useAnnivRecent(today, RECENT_DAYS);
  return (
    <DeskCard title={t('desk.soon', {})} end={t('desk.goAnniv', {})} onGo={() => void navigate('anniv')} data-testid="today-soon">
      {list.length ? (
        <ul className={styles.slist}>
          {list.map(({ row, days }) => (
            <li key={row.id}>
              <button type="button" className={styles.srow} onClick={() => void navigate('anniv', row.id)} data-testid="today-soon-row">
                <AnnivAvatarSlot Face={AnnivFace} id={row.id} avatarId={row['avatar_id']} name={nameOf(row)} kind={row['kind']} size={RECENT_AVATAR} />
                <span className={styles.tm}>{annivWhen(days, tt)}</span>
                <span className={styles.tt}>
                  <b>{annivLabel(row, tt)}</b>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.none}>{t('desk.soonNone', {})}</p>
      )}
    </DeskCard>
  );
}
