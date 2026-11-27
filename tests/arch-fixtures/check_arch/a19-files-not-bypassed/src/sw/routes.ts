// 违规 A19：只走网络的前缀表里漏了 /files（照片和附件的签名链接会被 SW 缓存）
export const NETWORK_ONLY_PREFIXES = ['/sb'] as const;
