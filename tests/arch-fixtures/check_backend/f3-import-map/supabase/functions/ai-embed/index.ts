// 对照：名单里的 ai-embed 经别名引 db.ts、引 jsr 标准库不报
import { db } from '@db';
import { delay } from 'std/async/delay.ts';
export const x = [db, delay];
