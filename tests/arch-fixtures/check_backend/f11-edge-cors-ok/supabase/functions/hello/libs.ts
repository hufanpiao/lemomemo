// F11 对照样例：supabase-js 本体、本地叫 cors 的文件都不算
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { VARY } from '../_shared/http.ts';
export { createClient, VARY };
// dist 下不叫 cors 的文件不算（复核 R1 的对照）
export const main = () => import('npm:@supabase/supabase-js@2.118.0/dist/main/index.js');
export const corsless = () => import('https://esm.sh/@supabase/supabase-js@2/dist/module/corsless.mjs');
// 放宽目录和后缀以后的对照：文件名不是 cors 的不算
export const notCors = () => import('https://esm.sh/@supabase/supabase-js@2/es2022/cors-helper.mjs');
