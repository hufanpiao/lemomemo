// 违规 F2（B1 接手清单 C10）：不在名单里的函数用绝对路径、盘符路径、file: 地址、指到绝对路径的 import map 别名引 db.ts，每行一种
import { withUser as a } from '/home/runner/work/lemo/supabase/functions/_shared/db.ts';
import { withUser as b } from 'C:/work/lemo/supabase/functions/_shared/db.ts';
import { withUser as c } from 'file:///D:/work/lemo/supabase/functions/_shared/db.ts';
import { withUser as d } from '@db';
export const all = [a, b, c, d];
