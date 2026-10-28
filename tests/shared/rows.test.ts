// shared/schema（架构 2.5）：严格版多一列、类型不对都拒收；有时刻必须有时区
import { describe, expect, it } from 'vitest';
import { apiError, upgradeRequired } from '../../shared/schema/api.ts';
import { eventsWrite, patchSchema, profilesWrite, rowsWrite, todosWrite } from '../../shared/schema/rows.ts';

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

  it('rowsWrite 登记了三张表', () => {
    expect(Object.keys(rowsWrite).sort()).toEqual(['events', 'profiles', 'todos']);
    expect(todosWrite.safeParse({}).success).toBe(false);
  });
});

describe('api', () => {
  it('错误只带错误码；426 带最低版本', () => {
    expect(apiError.safeParse({ code: 'upgrade_required' }).success).toBe(true);
    expect(apiError.safeParse({ code: '' }).success).toBe(false);
    expect(upgradeRequired.safeParse({ code: 'upgrade_required', min: '4.1.0' }).success).toBe(true);
    expect(upgradeRequired.safeParse({ code: 'upgrade_required', min: '4.1' }).success).toBe(false);
  });
});
