// 版本号比较（架构 0.27 第 1 点、8.5）：只看“主.次.修”三段，去掉 -preview.N 这类后缀
// 前端（功能开关、版本横幅）和转发层 version-gate（前端 B）共用

export type Semver = readonly [number, number, number];

/** '4.1.0'、'4.1.0-preview.3' → [4, 1, 0]；格式不对返回 null */
export function parseVersion(v: string): Semver | null {
  const mt = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!mt) return null;
  return [Number(mt[1]), Number(mt[2]), Number(mt[3])];
}

/** a < b 返回负数，相等 0，a > b 正数；任一格式不对时抛错 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`bad_version:${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** v 是否不低于 min（预览版不会被当成更低的版本） */
export function versionAtLeast(v: string, min: string): boolean {
  return compareVersions(v, min) >= 0;
}
