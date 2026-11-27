// 引用角标的改写和按长度截断（ai-summarize、ai-chat 共用；R-492 从 ai-summarize/core.ts 原样挪出来，行为不变，单测照旧在 tests/edge/ai-summarize.test.ts）。
// 纯逻辑，不 import 任何东西。

/** 截到最多 max 个 UTF-16 单元，不切开代理对（zod 的 string().max 按 UTF-16 长度量） */
export function cutUnits(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** 带角标的正文截到最多 max 个 UTF-16 单元：截断落在角标中间的，把那半截（结尾的“[”“[1”）去掉（ai-summarize、ai-chat 共用） */
export function cutCited(s: string, max: number): string {
  return cutUnits(s, max).replace(/\[\d*$/, '');
}

/** 正文里的引用标记：[3]、[1][2]，也认 [1,2]、[1，2]、[1、2]（模型偶尔这样写） */
const CITE = /\[(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\]/g;

/**
 * 正文里的 [n]（n 是送出去的第几条）改写成 [m]，m 是这条在 cited 里的位置（从 1 起）：
 * cited 按正文里第一次被引的顺序排，模型另给的 cited（只留送出去的）排在后面——客户端依据列表的序号就和角标对上（返工，线框 22）。
 * n 超出送出的条数、0 的标记删掉；连写、逗号写法拆成一个个 [m]
 */
export function relinkCites(summary: string, modelCited: readonly string[], order: readonly string[]): { summary: string; cited: string[] } {
  const cited: string[] = [];
  const pos = (id: string): number => {
    const i = cited.indexOf(id);
    if (i >= 0) return i + 1;
    cited.push(id);
    return cited.length;
  };
  const text = summary.replace(CITE, (_m, list: string) =>
    list
      .split(/[,，、]/)
      .map((s) => Number(s.trim()))
      .filter((k) => k >= 1 && k <= order.length)
      .map((k) => order.at(k - 1))
      .filter((id): id is string => id !== undefined)
      .map((id) => `[${pos(id)}]`)
      .join(''),
  );
  const sent = new Set(order);
  for (const id of modelCited) if (sent.has(id) && !cited.includes(id)) cited.push(id);
  return { summary: text, cited };
}
