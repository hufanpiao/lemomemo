// 随手记的显示标题（列表、转成待办 / 日程共用；“没有标题取正文第一行”只在这里定）：有标题用标题；没有取正文第一个非空行，
// rest 是其后各行（去掉首尾空行、换行保留）。单独成文件、不带 zod：列表页只要这一条规则。纯函数
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const blank = (l: string): boolean => l.trim() === '';

export function noteHeadline(title: unknown, body: unknown): { title: string; rest: string; fromBody: boolean } {
  const t = str(title).trim();
  if (t !== '') return { title: t, rest: str(body), fromBody: false };
  const lines = str(body).split('\n');
  const i = lines.findIndex((l) => !blank(l));
  if (i < 0) return { title: '', rest: '', fromBody: true };
  const rest = lines.slice(i + 1);
  while (rest.length > 0 && blank(rest[0] ?? '')) rest.shift();
  while (rest.length > 0 && blank(rest[rest.length - 1] ?? '')) rest.pop();
  return { title: (lines[i] ?? '').trim(), rest: rest.join('\n'), fromBody: true };
}
