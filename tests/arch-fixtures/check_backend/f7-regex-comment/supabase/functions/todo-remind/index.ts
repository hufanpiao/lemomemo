// 对照：真注释照样不算（注释里写 Deno.env.toObject() 不报），正则后面的注释也照样去掉
/* Deno.env.toObject() */
const re = /\/\//g; // Deno.env.toObject()
export const ok = (s: string) => re.test(s) && /[/]/.test(s);
