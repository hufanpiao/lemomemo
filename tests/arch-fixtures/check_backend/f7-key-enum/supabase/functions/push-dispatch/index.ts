// 违规 F7（代码审查第六轮必改 2）：枚举成员当键（字符串枚举的成员可以是拼出来的 constructor、Deno；数字枚举也一并不收）
enum K { C = 'constr' + 'uctor', D = 'De' + 'no' }
export const e1 = ((() => 0) as unknown as Record<string, unknown>)[K.C];
enum N { A = 0 }
export const e2 = [1, 2][N.A];
