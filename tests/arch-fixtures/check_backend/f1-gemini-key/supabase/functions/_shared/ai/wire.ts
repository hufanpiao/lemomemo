// 对照：只有这里准读 GEMINI_API_KEY
export const gateDeps = () => Deno.env.get('GEMINI_API_KEY');
