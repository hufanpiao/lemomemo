// 查找面板开没开（B4b-2）：模块里一份，打字条（features/plus 的 TypeBar，判成查找后回车）和 Ctrl+K（ui/FindHost.tsx）都经 openFind 打开，
// FindHost 订阅它画面板。n 每打开一次加 1，面板按它重新挂载（换了查询从头来）。纯 TS，很小
export interface FindOpen {
  q: string;
  from: 'plus' | 'ctrlk';
  n: number;
}

let cur: FindOpen | null = null;
let seq = 0;
const subs = new Set<() => void>();
const emit = (): void => {
  for (const fn of [...subs]) fn();
};

export function openFind(q: string, from: FindOpen['from']): void {
  seq += 1;
  cur = { q, from, n: seq };
  emit();
}

export function closeFind(): void {
  if (cur === null) return;
  cur = null;
  emit();
}

export const findOpenSnapshot = (): FindOpen | null => cur;
export function subscribeFindOpen(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
