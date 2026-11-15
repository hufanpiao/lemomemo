// 一句译好的话里，把数字那一段（时刻“14:00”、天数“2”）换成等宽字（R-436“日期时刻等宽数字”）。
// 词条照旧整句翻译（“逾 {n} 天”“{t} 截止”），这里只在句子里找到那段数字、包一层 Refine.module.css 的 .num；找不到就原样输出
import r from './Refine.module.css';

export function NumIn({ text, num }: { text: string; num: string }) {
  const i = num === '' ? -1 : text.indexOf(num);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className={r.num}>{num}</span>
      {text.slice(i + num.length)}
    </>
  );
}
