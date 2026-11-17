// 日期数字加补班“班”标（11-17 日历整块评审第 6 条：月格、手机周泳道、电脑周表头原来各写一份，合成这一个）
// • 数字是 .dayNum 圆角小方块（今天淡黄小框、选中深色小方块、周末灰字由外面格子 / 泳道 / 表头上的 .today .sel .wkend 决定，R-445）；
//   月格用 span（字重跟格子走），泳道、表头用 b（粗字）——和抽出来之前一样，外观不变
// • 三种排法 look（样式都在 cal-common.module.css）：month 月格（数字和标一行、放不下标折行靠右）、lane 手机泳道、desk 电脑表头（放大）
// • “班”标（cal-ui.ts dayLines 的 badge；空串不画）：中文单字小圆、韩文“근무”胶囊；data-testid="cal-ban"
// • 两段字之间的 {' '}：外层是 flex，空格不画出来；给 axe 和读屏分词用（cal-ui.ts labelInName）
import type { DateStr } from '../../../../shared/core/date.ts';
import styles from './cal-common.module.css';

function lookClass(look: 'month' | 'lane' | 'desk'): string {
  if (look === 'month') return styles.numMonth ?? '';
  return look === 'lane' ? (styles.numLane ?? '') : (styles.numDesk ?? '');
}

export function DayNum({ date, badge, look, as: Tag = 'b', hidden = false }: {
  date: DateStr;
  badge: string;
  look: 'month' | 'lane' | 'desk';
  as?: 'b' | 'span';
  /** 外层加 aria-hidden（月格：格子按钮有自己的读屏名字） */
  hidden?: boolean;
}) {
  return (
    <span className={lookClass(look)} aria-hidden={hidden || undefined}>
      <Tag className={styles.dayNum}>{Number(date.slice(8))}</Tag>
      {badge !== '' ? (
        <>
          {' '}
          <span className={styles.ban} data-testid="cal-ban">
            {badge}
          </span>
        </>
      ) : null}
    </span>
  );
}
