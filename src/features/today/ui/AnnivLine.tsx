// 今天页顶部的纪念日一行（胶囊）：“3 天后 김지민 生日”，前面小头像
// • 头像经 anniv/index.ts 懒加载 AnnivFace（取图要 platform/files，不进首屏），由 kit 的 AnnivAvatarSlot 挂；没加载好、分包下不来时画首字圆
// • 纪念日开关开着、有纪念日时 TodayPage 才挂它（按需下载）；这里再挑 7 天内最近的一个，没有就不画；点了进纪念日页的这一条
// • 行尾“›”（照 今天页空白趣味 方案4.html 组合区的胶囊）
// • 外形挂 kit 胶囊（Chip.module.css .chip，高 30、无描边 --panel-2 底，同待办页筛选胶囊），“3 天后”的数字等宽
// • 生日那一种名字后面写“生日”（线框 ANNLINE“3 天后 김지민 生日”）：名字和“3 天后”都由 data/anniv-soon.ts 的 annivLabel、annivWhen 算（电脑“快到了”块同一份）
import type { DateStr } from '../../../../shared/core/date.ts';
import { navigate } from '../../../app/router.ts';
import { AnnivAvatarSlot } from '../../../kit/components/AnnivAvatar.tsx';
import chip from '../../../kit/components/Chip.module.css';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { Pressable } from '../../../motion/components.ts';
import { AnnivFace } from '../../anniv/index.ts';
import { ANNIV_SOON_DAYS, annivLabel, annivWhen, nameOf, useAnnivUpcoming } from '../hooks/useAnnivUpcoming.ts';
import { useTodayT } from '../hooks/useTodayT.ts';
import styles from './TodayPage.module.css';

export default function AnnivLine({ today }: { today: DateStr }) {
  const t = useTodayT();
  const soon = useAnnivUpcoming(today, ANNIV_SOON_DAYS, 1)[0];
  if (!soon) return null;
  const { row, days } = soon;
  return (
    <Pressable type="button" className={`${chip.chip} ${styles.anniv}`} onClick={() => void navigate('anniv', row.id)} data-testid="today-anniv">
      <AnnivAvatarSlot Face={AnnivFace} id={row.id} avatarId={row['avatar_id']} name={nameOf(row)} kind={row['kind']} size="xs" />
      <span className={styles.annivWhen}><NumIn text={annivWhen(days, t)} num={String(days)} /></span>
      <span className={styles.annivName}>{annivLabel(row, t)}</span>
      {/* 行尾 ›（方案4.html 的 .chip .gt）：读屏不念 */}
      <span className={styles.annivGt} aria-hidden="true">›</span>
    </Pressable>
  );
}
