// 违规 F7（S3）：整个拿走所有 secret
export const all = Deno.env.toObject();
