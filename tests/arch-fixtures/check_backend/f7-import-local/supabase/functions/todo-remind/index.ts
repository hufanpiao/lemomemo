// 对照：没有百分号、落在 supabase/functions 里面的本地 import 不报（同目录、_shared、别的机器上的 supabase/functions 绝对路径）
import { pad } from '../_shared/helper.ts';
import { pad as pad2 } from '/ci/other/supabase/functions/_shared/helper.ts';
import { local } from './local.ts';
export const p = [pad('1'), pad2('2'), local];
