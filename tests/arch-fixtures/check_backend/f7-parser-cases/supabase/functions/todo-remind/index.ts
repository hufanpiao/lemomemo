// 对照（第三轮 b14）：除号后面同一行的普通注释（里面写 process?.env、Deno.env.toObject()）不报
const r = 4 / 2; // 这一行的注释里写 process?.env、Deno.env.toObject() 不算
export const ok = r;
