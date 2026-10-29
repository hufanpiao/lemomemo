// 第八轮审查必改 1 的反例（K6-sugg5 ① 撤回）：账号层面的退出不能“同账号也删”。
// clearLocalSessionIf(null) 本来就会删读不出 sid 的会话（readSessionId 读不出时也是 null）；
// 多出来的“同账号、sid 读得出但不是请求时那个”恰好是别的标签页刚登录、正在恢复的 S2，不能删。
// 已知限制：请求那一刻读不出 sid、之后又读得出的那一个作废会话会留着，登录页可能同时显示“当前已登录”和退出原因
import { afterEach, describe, expect, it } from 'vitest';
import * as session from '../session.ts';
import { clearLocalSessionIf, readSessionId, readSessionUserId } from '../session.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const KEY = 'sb-lemomemo-auth-token';
const URL_ = 'https://lemomemo.com/sb';
const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const seed = (sid: string, user = A): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));

afterEach(() => localStorage.clear());

describe('sid 为 null 时删会话（反例）', () => {
  it('wipe 期间本机写进同账号的 S2：clearLocalSessionIf(null) 不删 S2', () => {
    seed('s2');
    clearLocalSessionIf(null, localStorage, URL_);
    expect(readSessionUserId(localStorage, URL_)).toBe(A);
    expect(readSessionId(localStorage, URL_)).toBe('s2');
  });

  it('本机会话读不出 sid（令牌坏了）：clearLocalSessionIf(null) 照样删（不用另加“同账号”的规则）', () => {
    localStorage.setItem(KEY, JSON.stringify({ access_token: 'bad', user: { id: A } }));
    clearLocalSessionIf(null, localStorage, URL_);
    expect(readSessionUserId(localStorage, URL_)).toBeNull();
  });

  it('不再有 clearAccountSessionIf', () => {
    expect('clearAccountSessionIf' in session).toBe(false);
  });
});
