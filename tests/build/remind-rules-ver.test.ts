// 提醒规则版本号的 CI 检查（R-411，方案-提醒队列重写 3.3④、T22 的 CI 部分）：shared/logic/remind.ts 的 remindAtOf 在一张固定输入表（约 50 组：
// 待办两种、有时刻的日程、全天日程、跨夏令时、换时区、坏值）上的结果存成快照 remind-rules-ver.snap.json，快照里记着每个版本的结果哈希。
// 红的三种：算法结果变了而当前版本的哈希没换（忘了加版本）；快照版本 ≠ REMIND_RULES_VER；版本 > 1 却找不到调 remind_enqueue('all', …, 版本) 的迁移。
// 改了算法：先把 REMIND_RULES_VER 加 1，写那一行迁移，再跑 `REMIND_SNAP_WRITE=1 npx vitest run tests/build/remind-rules-ver.test.ts` 更新快照（PowerShell 用 $env:REMIND_SNAP_WRITE='1'）；
// 版本没加时写快照会被拒。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { msAt, parseHm } from '../../shared/core/date.ts';
import { REMIND_RULES_VER, remindAtOf, type EventRemindRow, type TodoRemindRow } from '../../shared/logic/remind.ts';

const SNAP = new URL('./remind-rules-ver.snap.json', import.meta.url);
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

type Out = number | null | 'throw';
type Snap = { ver: number; history: Record<string, string>; results: Record<string, Out> };
type Case = { name: string; run: () => number | null };

const SEOUL = 'Asia/Seoul';
const NY = 'America/New_York';
const NOW = msAt('2026-11-05', parseHm('08:00'), SEOUL);
const NOW_JAN = Date.UTC(2026, 0, 1);
const todo = (o: Partial<TodoRemindRow>): TodoRemindRow => ({ due: '2026-11-06', due_time: null, remind_before_min: null, remind_days: 0, remind_time: null, ...o });
const ev = (o: Partial<EventRemindRow>): EventRemindRow => ({ date: '2026-11-06', time: '15:00', tz: SEOUL, remind_min: 15, remind_days: null, ...o });
const allDay = (o: Partial<EventRemindRow>): EventRemindRow => ev({ time: null, tz: null, remind_min: null, remind_days: 0, ...o });
const at = (d: string, hm: string, tz = SEOUL) => msAt(d, parseHm(hm), tz);

function cases(): Case[] {
  const c: Case[] = [];
  const t = (name: string, row: TodoRemindRow, tz = SEOUL, now = NOW, prev?: number | null) => c.push({ name: `todo:${name}`, run: () => remindAtOf('todo', row, tz, now, prev) });
  const e = (name: string, row: EventRemindRow, tz = SEOUL, now = NOW, defaultTime?: unknown) => c.push({ name: `event:${name}`, run: () => remindAtOf('event', row, tz, now, null, defaultTime) });
  // 待办：只有日期
  t('日期-当天-默认时刻', todo({}));
  t('日期-当天-07:30', todo({ remind_time: '07:30' }));
  t('日期-前一天-21:00', todo({ remind_days: 1, remind_time: '21:00' }));
  t('日期-不提醒', todo({ remind_days: null }));
  t('日期-remind_days=2', todo({ remind_days: 2 }));
  t('没有截止日', todo({ due: null }));
  t('已完成', todo({ done: true }));
  t('已删除', todo({ deleted_at: 1 }));
  t('日期-时刻串坏了', todo({ remind_time: '25:00' }));
  // 待办：有截止时刻
  t('时刻-提前60', todo({ due_time: '18:00', remind_before_min: 60 }));
  t('时刻-准时', todo({ due_time: '18:00', remind_before_min: 0 }));
  t('时刻-提前1天', todo({ due_time: '18:00', remind_before_min: 1440 }));
  t('时刻-不提醒', todo({ due_time: '18:00', remind_before_min: null }));
  t('时刻-提前量已过-新建回落', todo({ due: '2026-11-05', due_time: '08:30', remind_before_min: 60 }));
  t('时刻-提前量已过-原来已回落', todo({ due: '2026-11-05', due_time: '08:30', remind_before_min: 60 }), SEOUL, NOW, at('2026-11-05', '08:30'));
  t('时刻-提前量已过-重算不回落', todo({ due: '2026-11-05', due_time: '08:30', remind_before_min: 60 }), SEOUL, NOW, null);
  t('时刻-截止也过了-新建', todo({ due: '2026-11-05', due_time: '07:30', remind_before_min: 60 }));
  t('时刻-正好截止-新建', todo({ due: '2026-11-05', due_time: '08:00', remind_before_min: 30 }));
  t('时刻-换时区-洛杉矶', todo({ due_time: '18:00', remind_before_min: 60 }), 'America/Los_Angeles');
  t('日期-换时区-伦敦', todo({}), 'Europe/London');
  t('日期-换时区-奥克兰', todo({ remind_days: 1, remind_time: '23:30' }), 'Pacific/Auckland');
  t('日期-换时区-加尔各答', todo({ remind_time: '06:15' }), 'Asia/Kolkata');
  // 待办：跨夏令时（纽约 2026-03-08 拨快、11-01 拨慢）
  t('夏令时-拨快-提前1天', todo({ due: '2026-03-08', due_time: '10:00', remind_before_min: 1440 }), NY, NOW_JAN);
  t('夏令时-拨快-提前120', todo({ due: '2026-03-08', due_time: '03:30', remind_before_min: 120 }), NY, NOW_JAN);
  t('夏令时-拨快-不存在的时刻', todo({ due: '2026-03-08', remind_time: '02:30' }), NY, NOW_JAN);
  t('夏令时-拨慢-提前60', todo({ due: '2026-11-01', due_time: '01:30', remind_before_min: 60 }), NY, NOW_JAN);
  t('夏令时-拨慢-重复的时刻', todo({ due: '2026-11-01', remind_time: '01:30' }), NY, NOW_JAN);
  t('夏令时-拨慢-提前1天', todo({ due: '2026-11-02', due_time: '01:30', remind_before_min: 1440 }), NY, NOW_JAN);
  // 有时刻的日程（按日程自己的 tz，current_tz 不管用）
  e('有时刻-提前15', ev({}));
  e('有时刻-准时', ev({ remind_min: 0 }));
  e('有时刻-提前1天', ev({ remind_min: 1440 }));
  e('有时刻-不提醒', ev({ remind_min: null }));
  e('有时刻-没有tz', ev({ tz: null }));
  e('有时刻-已删除', ev({ deleted_at: 1 }));
  e('有时刻-日程在洛杉矶-人在首尔', ev({ tz: 'America/Los_Angeles' }));
  e('有时刻-人换到伦敦', ev({}), 'Europe/London');
  e('有时刻-夏令时-拨快', ev({ date: '2026-03-08', time: '03:30', tz: NY, remind_min: 60 }), SEOUL, NOW_JAN);
  e('有时刻-夏令时-拨慢', ev({ date: '2026-11-01', time: '01:30', tz: NY, remind_min: 30 }), SEOUL, NOW_JAN);
  // 全天日程（按 current_tz 和 remind.default_time）
  e('全天-当天-默认', allDay({}));
  e('全天-当天-07:00', allDay({}), SEOUL, NOW, '07:00');
  e('全天-当天-设置坏了', allDay({}), SEOUL, NOW, '7点');
  e('全天-当天-设置不是字符串', allDay({}), SEOUL, NOW, 7);
  e('全天-前一天', allDay({ remind_days: 1 }));
  e('全天-前一天-设置不影响', allDay({ remind_days: 1 }), SEOUL, NOW, '07:00');
  e('全天-不提醒', allDay({ remind_days: null }));
  e('全天-remind_days=2', allDay({ remind_days: 2 }));
  e('全天-已删除', allDay({ deleted_at: 1 }));
  e('全天-换时区-伦敦-前一天', allDay({ remind_days: 1 }), 'Europe/London');
  e('全天-夏令时-拨快-前一天', allDay({ date: '2026-03-08', remind_days: 1 }), NY, NOW_JAN);
  e('全天-奥克兰-23:30', allDay({}), 'Pacific/Auckland', NOW, '23:30');
  return c;
}

function results(): Record<string, Out> {
  const out: Record<string, Out> = {};
  for (const x of cases()) {
    if (x.name in out) throw new Error(`用例重名：${x.name}`);
    try {
      out[x.name] = x.run();
    } catch {
      out[x.name] = 'throw';
    }
  }
  return out;
}

const hashOf = (r: Record<string, Out>) => createHash('sha256').update(JSON.stringify(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
/** 迁移里有没有 remind_enqueue('all', null, null, null, <布尔>, <版本>[::smallint]) */
const hasEnqueueAll = (sqls: readonly string[], ver: number) =>
  sqls.some((s) => new RegExp(`remind_enqueue\\(\\s*'all'\\s*,\\s*null\\s*,\\s*null\\s*,\\s*null\\s*,\\s*(?:true|false)\\s*,\\s*${ver}\\s*(?:::\\s*smallint)?\\s*\\)`, 'i').test(s));

/** 三种红法；空数组 = 通过 */
function problems(snap: Snap, ver: number, now: Record<string, Out>, sqls: readonly string[]): string[] {
  const out: string[] = [];
  if (snap.ver !== ver) out.push(`快照版本 ${snap.ver} ≠ REMIND_RULES_VER ${ver}`);
  const vs = Object.keys(snap.history).map(Number).sort((a, b) => a - b);
  if (vs.join(',') !== Array.from({ length: ver }, (_, i) => i + 1).join(',')) out.push(`快照的版本历史应是 1～${ver}，实际 ${vs.join(',')}`);
  if (snap.history[String(ver)] !== hashOf(now)) out.push('算法结果和快照里当前版本的不一样：改了算法就把 REMIND_RULES_VER 加 1、写全量入队迁移、再更新快照');
  for (let v = 2; v <= ver; v++) if (!hasEnqueueAll(sqls, v)) out.push(`版本 ${v} 没有对应的迁移：select private.remind_enqueue('all', null, null, null, false, ${v}::smallint)`);
  return out;
}

const readSnap = (): Snap => JSON.parse(readFileSync(SNAP, 'utf8')) as Snap;
const migrationSqls = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(new URL(f, MIGRATIONS), 'utf8'));

describe('提醒规则版本号（REMIND_RULES_VER）', () => {
  if (process.env['REMIND_SNAP_WRITE'] === '1') {
    it('写快照（版本没加、算法却变了就拒）', () => {
      const now = results();
      const old = readSnap();
      const h = old.history[String(REMIND_RULES_VER)];
      if (h !== undefined && h !== hashOf(now)) throw new Error('当前版本的结果已经记过、而且和现在不一样：先把 REMIND_RULES_VER 加 1');
      const snap: Snap = { ver: REMIND_RULES_VER, history: { ...old.history, [String(REMIND_RULES_VER)]: hashOf(now) }, results: now };
      writeFileSync(SNAP, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
    });
  }

  it('用例约 50 组，每组的结果和快照逐条一致，三项检查都过', () => {
    const now = results();
    expect(Object.keys(now).length).toBeGreaterThanOrEqual(45);
    const snap = readSnap();
    expect(now).toEqual(snap.results);
    expect(problems(snap, REMIND_RULES_VER, now, migrationSqls())).toEqual([]);
  });

  it('三种红法都拦得住（反例）', () => {
    const now = results();
    const snap = readSnap();
    // ① 算法变了、版本没加
    const changed = { ...now, 'todo:日期-当天-默认时刻': 1 };
    expect(problems(snap, 1, changed, [])).toEqual([expect.stringContaining('算法结果和快照里当前版本的不一样')]);
    // ② 版本加了、快照没跟上
    expect(problems(snap, 2, now, [])).toEqual(expect.arrayContaining([expect.stringContaining('快照版本 1 ≠ REMIND_RULES_VER 2')]));
    // ③ 版本 2 的快照齐了、迁移没写；写了就过
    const v2: Snap = { ver: 2, history: { ...snap.history, 2: hashOf(changed) }, results: changed };
    expect(problems(v2, 2, changed, [])).toEqual([expect.stringContaining('版本 2 没有对应的迁移')]);
    expect(problems(v2, 2, changed, ["select private.remind_enqueue('all', null, null, null, false, 2::smallint);"])).toEqual([]);
    expect(problems(v2, 2, changed, ["select private.remind_enqueue('all', null, null, null, false, 3::smallint);"])).toHaveLength(1);
  });
});
