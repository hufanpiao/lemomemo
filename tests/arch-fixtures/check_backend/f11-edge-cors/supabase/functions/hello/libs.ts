// F11 违规样例：import 自带 CORS 头的库（审查 M2）；源码里没有那串字，以前不报
import { corsHeaders } from 'npm:@supabase/supabase-js@2.118.0/cors';
import { cors } from 'jsr:@hono/hono/cors';
import { corsHeaders as esm } from 'https://esm.sh/%40supabase/supabase-js@2/cors';
export { corsHeaders, cors, esm };
export const lazy = () => import('npm:cors@2.8.5');
// 拼接写法：放宽到 allow-origin 以后多拦一种（安全审查建议 1）
export const H2 = 'Access-Control-' + 'Allow-Origin';
// 复核 R1：dist 下的 cors 文件、带 .mjs/.cjs/.js 后缀，esm.sh、jsdelivr 上的同名路径
export const d1 = () => import('npm:@supabase/supabase-js@2.118.0/dist/cors.mjs');
export const d2 = () => import('https://esm.sh/@supabase/supabase-js@2/dist/module/cors.js');
export const d3 = () => import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/main/cors.cjs');
// 代码审查建议 ①：esm.sh 的 es2022/、denonext/ 目录，dist/cors.min.mjs
export const d4 = () => import('https://esm.sh/@supabase/supabase-js@2/es2022/cors.mjs');
export const d5 = () => import('https://esm.sh/@supabase/supabase-js@2.118.0/denonext/cors.mjs');
export const d6 = () => import('npm:@supabase/supabase-js@2/dist/cors.min.mjs');
