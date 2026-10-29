// 违规 F7：别的文件不准起 globalThis 的别名（白名单只有 _shared/gen/objstore-net.ts 的 G）
const G = globalThis as unknown as object;
export const x = G;
