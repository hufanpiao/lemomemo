// 全部数据清单（3.5）。加一个功能：写 <功能>.ts，加进下面的数组；D1 会核对数据库和这里一致
import type { Manifest } from '../schema/manifest.ts';
import { core } from './core.ts';
import { calendar } from './calendar.ts';
import { todos } from './todos.ts';
import { notes } from './notes.ts';
import { attachments } from './attachments.ts';
import { anniv } from './anniv.ts';
import { vault } from './vault.ts';
import { search } from './search.ts';

export const allManifests: readonly Manifest[] = [core, calendar, todos, notes, attachments, anniv, vault, search];
