// FNV-1a 32 位散列（按 UTF-16 码元）：项目色（logic/project-color.ts）和今日运势（logic/anniv/lunar-fortune.ts）共用这一份（R-431 独立评审第 5 条）；
// 别处只经 project-color.ts 转出来引，这个文件就和项目色并在同一块（首屏不多一块）
// 纯函数，前端和 Edge Functions 共用；结果是 0～2³²−1 的无符号整数
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
