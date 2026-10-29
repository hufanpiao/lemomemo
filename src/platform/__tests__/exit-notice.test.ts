// 退出原因会过期（第六轮审查建议 ②；platform/exit-notice.ts）：存时带上时刻（和 sid），读时超过 10 分钟当没有并删掉；
// 本页自己写的、别的标签页广播来的走同一套；旧格式（只有原因字符串）照样认
import { beforeEach, describe, expect, it } from 'vitest';
import { clearExitNotice, EXIT_NOTICE_TTL_MS, readExitNotice, setExitNotice } from '../exit-notice.ts';
import { readExitNotice as viaSession } from '../session.ts';

const KEY = 'lemo.exit_notice';
const T = 1_700_000_000_000;

beforeEach(() => sessionStorage.clear());

describe('退出原因带时刻、会过期', () => {
  it('写下时带时刻和 sid；10 分钟内读得到（session.ts 转出的同一个函数）', () => {
    setExitNotice('pending_deletion', undefined, { sid: 's1', now: T });
    expect(JSON.parse(sessionStorage.getItem(KEY) ?? '')).toEqual({ n: 'pending_deletion', at: T, sid: 's1' });
    expect(readExitNotice(undefined, T + EXIT_NOTICE_TTL_MS - 1)).toBe('pending_deletion');
    expect(viaSession(undefined, T + 1000)).toBe('pending_deletion');
  });

  it('没给 sid、sid 为 null：不存 sid 这一项', () => {
    setExitNotice('removed', undefined, { sid: null, now: T });
    expect(JSON.parse(sessionStorage.getItem(KEY) ?? '')).toEqual({ n: 'removed', at: T });
  });

  it('满 10 分钟：当没有，并顺手删掉', () => {
    setExitNotice('disabled', undefined, { now: T });
    expect(readExitNotice(undefined, T + EXIT_NOTICE_TTL_MS)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('时刻在将来超过 1 分钟（时钟被改过）：当没有；1 分钟以内照样认', () => {
    setExitNotice('disabled', undefined, { now: T + 30_000 });
    expect(readExitNotice(undefined, T)).toBe('disabled');
    setExitNotice('disabled', undefined, { now: T + 120_000 });
    expect(readExitNotice(undefined, T)).toBeNull();
  });

  it('不给 now 用当前时间：刚写的读得到', () => {
    setExitNotice('disabled_unsure');
    expect(readExitNotice()).toBe('disabled_unsure');
    clearExitNotice();
    expect(readExitNotice()).toBeNull();
  });

  it('旧格式（只有原因字符串）照样认；认不出的值、JSON 里原因不对或没有时刻：当没有', () => {
    sessionStorage.setItem(KEY, 'disabled');
    expect(readExitNotice(undefined, T)).toBe('disabled');
    for (const bad of ['whatever', '{"n":"oops","at":1}', '{"n":"disabled"}', '{"n":"disabled","at":"x"}', '{bad']) {
      sessionStorage.setItem(KEY, bad);
      expect(readExitNotice(undefined, T)).toBeNull();
    }
  });
});
