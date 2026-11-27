// 从原始 URL 字符串取路径和查询串（/sb 和 /files 共用；B0 代码审查低 12：原来两处各写一份）。
// 不用 new URL().pathname：它会先把 `..`、`%2e%2e` 规整掉，判断就晚了。这里不解码、不规整，原样返回。

export interface RawParts {
  /** 以 / 开头，不含 ? 和 # */
  path: string;
  /** ? 之后、# 之前；没有就是空字符串 */
  query: string;
}

export function rawPathAndQuery(rawUrl: string): RawParts | null {
  const schemeEnd = rawUrl.indexOf('//');
  if (schemeEnd < 0) return null;
  const pathStart = rawUrl.indexOf('/', schemeEnd + 2);
  if (pathStart < 0) return null;
  const rest = rawUrl.slice(pathStart);
  const hash = rest.indexOf('#');
  const noHash = hash < 0 ? rest : rest.slice(0, hash);
  const q = noHash.indexOf('?');
  return { path: q < 0 ? noHash : noHash.slice(0, q), query: q < 0 ? '' : noHash.slice(q + 1) };
}
