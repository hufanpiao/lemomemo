// 一句译好的话里，把数字那一段（时刻“14:00”、天数“2”）换成等宽字（R-436“日期时刻等宽数字”）。
// 词条照旧整句翻译（“逾 {n} 天”“{t} 截止”），这里只在句子里找到那段数字、包一层 Refine.module.css 的 .num（胶囊里的条数传 Chip 的 .chipN）；找不到就原样输出
import r from './Refine.module.css';

export function NumIn({ text, num, className = r.num }: { text: string; num: string; className?: string | undefined }) {
  // 从后往前找：数字段都在句子后半（“会记成这样：日程 · 标题 · 11-07 15:00”），标题里碰巧有同样的串时不包错
  const i = num === '' ? -1 : text.lastIndexOf(num);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className={className}>{num}</span>
      {text.slice(i + num.length)}
    </>
  );
}
