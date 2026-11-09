// 过去的月日先问（R-166；架构 5.1“没写年份、已经过去的月日”）：
// “10 月 30 日已经过了 · 补记今年（10/30） · 明年（2027/10/30）”；只说几号的：“补记本月（11/1） · 下个月（12/1）”
// 选了才保存这一条；“收起”= 没选，原话留在输入条（不悄悄按某一种保存）
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import { usePlusT } from '../hooks/usePlusT.ts';
import styles from './TypeBar.module.css';

const parts = (d: string): { y: number; m: number; d: number } => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) });
const md = (s: string): string => `${parts(s).m}/${parts(s).d}`;
/** 跨年了才带年份 */
const ymd = (s: string, from: string): string => (parts(s).y === parts(from).y ? md(s) : `${parts(s).y}/${md(s)}`);

export function ConfirmRow({ item, onChoose, onDismiss }: { item: AiItem; onChoose(c: 'past' | 'next'): void; onDismiss(): void }) {
  const t = usePlusT();
  const c = item.confirm;
  if (!c) return null;
  const byMonth = item.date_basis === 'd';
  const p = parts(c.past);
  const q = t('plus.confirm.q', { date: t('plus.confirm.md', { m: p.m, d: p.d }) });
  return (
    <div className={styles.ask} role="group" aria-label={q} data-testid="type-confirm">
      <span>{q}</span>
      <FormButton type="button" onClick={() => onChoose('past')}>
        {t(byMonth ? 'plus.confirm.pastMonth' : 'plus.confirm.pastYear', { date: md(c.past) })}
      </FormButton>
      <FormButton type="button" onClick={() => onChoose('next')}>
        {t(byMonth ? 'plus.confirm.nextMonth' : 'plus.confirm.nextYear', { date: byMonth ? ymd(c.next, c.past) : `${parts(c.next).y}/${md(c.next)}` })}
      </FormButton>
      <FormButton type="button" variant="ghost" onClick={onDismiss}>{t('plus.type.close', {})}</FormButton>
    </div>
  );
}
