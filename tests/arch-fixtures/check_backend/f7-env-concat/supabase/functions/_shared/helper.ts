// 违规 F7：共用模块里也不行（db.ts 以外没有例外）
export const read = (role: string) => Deno.env.get(URL_ENV[role]);
const URL_ENV: Record<string, string> = {};
