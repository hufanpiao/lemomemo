// 违规 F2：db.ts 以外的共用模块读连接串
export const u = Deno.env.get('FN_AI_DB_URL');
