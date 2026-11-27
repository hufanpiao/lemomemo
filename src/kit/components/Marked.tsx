// 文字里命中查询的那几段包上 <mark>（查找面板、下拉搜索共用这一份；命中位置只经 shared/logic/search.ts 的 markRanges）
// • 样子由调用方给 className：查找面板是黑底白字（FindPanel.module.css .hl），下拉搜索就地筛是字下面一道短下划线（PullSlot.module.css .hit）
// • q 为空或没命中原样回文字（不多套一层）
import type { ReactNode } from 'react';
import { markRanges } from '../../../shared/logic/search.ts';

export function Marked({ text, q, className }: { text: string; q: string; className: string | undefined }): ReactNode {
  const rs = q === '' ? [] : markRanges(text, q);
  if (rs.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of rs) {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={a} className={className}>{text.slice(a, b)}</mark>);
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
