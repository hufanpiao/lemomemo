// 过去的月日先问（没写年份、已经过去的月日）：
// “10 月 30 日已经过了 · 补记今年（10/30） · 明年（2027/10/30）”；只说几号的：“补记本月（11/1） · 下个月（12/1）”
// 选了才保存这一条；“收起”= 没选，原话留在输入条（不悄悄按某一种保存）
// 两个选项的日子写法在 kit/confirm-dates.ts（AI 助手确认卡片同一份）
// 按钮用 FormButton size="compact"（无描边浅底，同打字条“展开编辑 / 收起”；点击区照样 44）
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import { confirmDates } from '../../../kit/confirm-dates.ts';
import { usePlusT } from '../hooks/usePlusT.ts';
import styles from './TypeBar.module.css';

export function ConfirmRow({ item, onChoose, onDismiss }: { item: AiItem; onChoose(c: 'past' | 'next'): void; onDismiss(): void }) {
  const t = usePlusT();
  const c = confirmDates(item);
  if (!c) return null;
  const q = t('plus.confirm.q', { date: t('plus.confirm.md', { m: c.m, d: c.d }) });
  return (
    <div className={styles.ask} role="group" aria-label={q} data-testid="type-confirm">
      <span>{q}</span>
      <FormButton type="button" size="compact" onClick={() => onChoose('past')}>
        {t(c.byMonth ? 'plus.confirm.pastMonth' : 'plus.confirm.pastYear', { date: c.past })}
      </FormButton>
      <FormButton type="button" size="compact" onClick={() => onChoose('next')}>
        {t(c.byMonth ? 'plus.confirm.nextMonth' : 'plus.confirm.nextYear', { date: c.next })}
      </FormButton>
      <FormButton type="button" variant="ghost" size="compact" onClick={onDismiss}>{t('plus.type.close', {})}</FormButton>
    </div>
  );
}
