// AI 正文里的角标：服务器改写好的 [m]（m 在 1..n 之内）画成小号上标，别的照原文（纯文本：不渲染模型给的 HTML、链接）。
// 结果层的总结（smart-search AssistPanel）和 AI 助手的回答（ai-chat AnswerBlock）共用这一份；
// 上标的字号、行高也在这里（Cites.module.css），调用方只另加颜色、字体
import type { ReactNode } from 'react';
import s from './Cites.module.css';

/** tone：调用方另加的类（颜色、字体），没有就跟正文；testId：上标的 data-testid */
export function withCites(text: string, n: number, tone: string | undefined, testId: string): ReactNode[] {
  const cls = tone ? `${s.sup} ${tone}` : s.sup;
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const k = Number(m[1]);
    if (k < 1 || k > n) continue;
    out.push(text.slice(at, m.index), <sup key={`c${m.index}`} className={cls} data-testid={testId}>{k}</sup>);
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  return out;
}
