// shared/schema（架构 2.5）：严格版多一列、类型不对都拒收；有时刻必须有时区
import { describe, expect, it } from 'vitest';
import { apiError, upgradeRequired } from '../../shared/schema/api.ts';
import { devicesWrite, eventsWrite, insertSchema, patchSchema, profilesWrite, rowsWrite, todosWrite } from '../../shared/schema/rows.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const event = {
  id: ID,
  title: 'A',
  date: '2026-10-28',
  time: '09:00',
  tz: 'Asia/Seoul',
  duration_min: 60,
  project: '',
  note: '',
  source: 'page',
  raw_text: '',
  location: '',
  short: null,
  short_by: null,
  push_show_title: null,
  batch_id: null,
  remind_min: 15,
  remind_days: null,
  notified_for: null,
  snooze_at: null,
  deleted_at: null,
  undone: false,
  created_at: 1,
  updated_at: 1,
};

describe('rows 严格版', () => {
  it('合法的 event 通过', () => {
    expect(eventsWrite.safeParse(event).success).toBe(true);
  });

  it('多一列被拒（客户端不能写 user_id、synced_at）', () => {
    expect(eventsWrite.safeParse({ ...event, user_id: ID }).success).toBe(false);
    expect(eventsWrite.safeParse({ ...event, synced_at: 1 }).success).toBe(false);
  });

  it('有时刻没有时区被拒；没有时刻可以没有时区', () => {
    expect(eventsWrite.safeParse({ ...event, tz: null }).success).toBe(false);
    expect(eventsWrite.safeParse({ ...event, time: null, tz: null }).success).toBe(true);
  });

  it('枚举、格式不对被拒', () => {
    expect(eventsWrite.safeParse({ ...event, source: 'web' }).success).toBe(false);
    expect(eventsWrite.safeParse({ ...event, date: '2026/10/28' }).success).toBe(false);
    expect(eventsWrite.safeParse({ ...event, remind_min: 5 }).success).toBe(false);
    expect(profilesWrite.safeParse({ display_name: null, ui_locale: 'en-US', tz_mode: 'device' }).success).toBe(false);
  });

  it('patch：只校验带上的列，仍然不准多列', () => {
    const p = patchSchema('todos');
    expect(p.safeParse({ done: true, updated_at: 2 }).success).toBe(true);
    expect(p.safeParse({ done: 'yes' }).success).toBe(false);
    expect(p.safeParse({ user_id: ID }).success).toBe(false);
  });

  it('rowsWrite 登记了四张表', () => {
    expect(Object.keys(rowsWrite).sort()).toEqual(['devices', 'events', 'profiles', 'todos']);
    expect(todosWrite.safeParse({}).success).toBe(false);
  });

  it('insert 不能带只能 update 的列（deleted_at、undone）；时刻配时区照样查', () => {
    const { deleted_at: _d, undone: _u, ...ins } = event;
    const s = insertSchema('events');
    expect(s.safeParse(ins).success).toBe(true);
    expect(s.safeParse(event).success).toBe(false);
    expect(s.safeParse({ ...ins, tz: null }).success).toBe(false);
  });

  it('patch 不能改只能 insert 的列（id、created_at、devices.platform）', () => {
    expect(patchSchema('events').safeParse({ id: ID }).success).toBe(false);
    expect(patchSchema('events').safeParse({ created_at: 1 }).success).toBe(false);
    expect(patchSchema('events').safeParse({ deleted_at: 3, undone: false }).success).toBe(true);
    expect(patchSchema('devices').safeParse({ platform: 'web' }).success).toBe(false);
    expect(patchSchema('devices').safeParse({ label: 'iPhone', last_seen_at: '2026-10-28T01:02:03Z' }).success).toBe(true);
  });

  it('devices：platform 只认四种；insert 能写 platform', () => {
    const dev = { id: ID, label: null, platform: 'ios', app_version: '4.0.0', last_seen_at: null, install_id: ID };
    expect(insertSchema('devices').safeParse(dev).success).toBe(true);
    expect(insertSchema('devices').safeParse({ ...dev, platform: 'android' }).success).toBe(false);
    expect(devicesWrite.safeParse({ ...dev, deleted_at: null, undone: false }).success).toBe(true);
  });

  it('devices.app_version 与迁移 devices_app_version_fmt 一致：1～40 个字母数字和 . + -', () => {
    const dev = { id: ID, label: null, platform: 'web', app_version: '4.0.0', last_seen_at: null, install_id: ID };
    const full = { ...dev, deleted_at: null, undone: false };
    // buildVersion 的两种输出、以及 null 都要过
    for (const v of ['4.0.0', '4.0.0-preview.12', '4.1.0+build.7', 'x'.repeat(40), null]) {
      expect(devicesWrite.safeParse({ ...full, app_version: v }).success, String(v)).toBe(true);
      expect(insertSchema('devices').safeParse({ ...dev, app_version: v }).success, String(v)).toBe(true);
    }
    for (const v of ['', '4.0.0 beta', '4.0.0/1', '版本4', '4_0_0', 'x'.repeat(41)]) {
      expect(devicesWrite.safeParse({ ...full, app_version: v }).success, v).toBe(false);
      expect(insertSchema('devices').safeParse({ ...dev, app_version: v }).success, v).toBe(false);
    }
  });

  it('events.tz 与迁移 events_tz_fmt 一致：≤ 64 字、只许字母数字和 _ + / -', () => {
    const { deleted_at: _d, undone: _u, ...ins } = event;
    for (const tz of ['Asia/Seoul', 'America/Argentina/Buenos_Aires', 'America/Port-au-Prince', 'Etc/GMT+9', 'Etc/GMT-14', 'UTC', 'a'.repeat(64)]) {
      expect(eventsWrite.safeParse({ ...event, tz }).success, tz).toBe(true);
      expect(insertSchema('events').safeParse({ ...ins, tz }).success, tz).toBe(true);
    }
    for (const tz of ['', 'Asia/ Seoul', 'Asia.Seoul', '亚洲/首尔', 'UTC;drop', 'a'.repeat(65)]) {
      expect(eventsWrite.safeParse({ ...event, tz }).success, tz).toBe(false);
      expect(insertSchema('events').safeParse({ ...ins, tz }).success, tz).toBe(false);
    }
  });

  it('本机 Intl 认得的 IANA 时区名都过得了 tz 校验', () => {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Seoul'];
    const bad = zones.filter((tz) => !eventsWrite.safeParse({ ...event, tz }).success);
    expect(bad).toEqual([]);
    expect(eventsWrite.safeParse({ ...event, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }).success).toBe(true);
  });

  it('profiles 客户端不能 insert', () => {
    expect(() => insertSchema('profiles')).toThrow('insert_not_allowed:profiles');
  });

  it('todos：有截止时刻必须有截止日期；提醒提前量只认六种', () => {
    const todo = {
      id: ID, title: 'T', done: false, due: null, important: false, project: '', note: '', source: 'page', raw_text: '',
      batch_id: null, from_note_id: null, from_anniv_id: null, short: null, short_by: null, done_at: 0, remind_days: null,
      remind_time: '09:00', due_time: null, remind_before_min: null, push_show_title: null, notified_for: null, snooze_at: null,
      deleted_at: null, undone: false, created_at: 1, updated_at: 1,
    };
    expect(todosWrite.safeParse(todo).success).toBe(true);
    expect(todosWrite.safeParse({ ...todo, due_time: '18:00' }).success).toBe(false);
    expect(todosWrite.safeParse({ ...todo, due: '2026-11-01', due_time: '18:00', remind_before_min: 30 }).success).toBe(true);
    expect(todosWrite.safeParse({ ...todo, remind_before_min: 5 }).success).toBe(false);
  });
});

describe('api', () => {
  it('错误体是 {error: 码}（0.38 第 54 条）；426 是 {code, min}', () => {
    expect(apiError.safeParse({ error: 'code_wrong' }).success).toBe(true);
    expect(apiError.safeParse({ error: '' }).success).toBe(false);
    expect(apiError.safeParse({ error: 'x'.repeat(65) }).success).toBe(false);
    // 老写法 {code} 不再算错误体
    expect(apiError.safeParse({ code: 'code_wrong' }).success).toBe(false);
    // account_pending_deletion 另带 purge_after：照样通过，只留 error
    expect(apiError.parse({ error: 'account_pending_deletion', purge_after: '2026-11-28T00:00:00Z' })).toEqual({ error: 'account_pending_deletion' });
    // 426 体不是 apiError
    expect(apiError.safeParse({ code: 'upgrade_required', min: '4.1.0' }).success).toBe(false);
    expect(upgradeRequired.safeParse({ code: 'upgrade_required', min: '4.1.0' }).success).toBe(true);
    expect(upgradeRequired.safeParse({ code: 'upgrade_required', min: '4.1' }).success).toBe(false);
  });
});
