// D1 第 6 节之三：删 auth.sessions 只准在 private.kill_session 里、且它要调 private.revoke_session（build/d1/session-revoke.ts；迁移 20261112090000）。
// 真库上的反例是 supabase/tests/d1-fixtures/44（离线 PGlite 也跑）；这里只测判定逻辑。
import { describe, expect, it } from 'vitest';
import { sessionRevokeProblems } from '../../build/d1/session-revoke.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { manifestSnapshot } from '../../src/core/manifests.gen.ts';

describe('sessionRevokeProblems', () => {
  it('kill_session 删会话并调了 revoke_session：不报；不删会话的函数不看', () => {
    expect(sessionRevokeProblems([
      { f: 'kill_session', src: 'DELETE  FROM  auth.sessions s where s.id = p_session; if found then PERFORM Private . Revoke_Session (p_session, p_user); end if;' },
      { f: 'c', src: 'perform private.revoke_session(r.id, uid);' },
      { f: 'd', src: 'select count(*) from auth.sessions; perform private.kill_session(s.id, p_user);' },
    ])).toEqual([]);
  });
  it('别的函数直接删会话（调了 revoke_session 也报）；kill_session 不写吊销记录也报', () => {
    expect(sessionRevokeProblems([
      { f: 'x', src: 'perform private.revoke_session(p_old, p_user); delete from auth.sessions s where s.id = p_old;' },
      { f: 'kill_session', src: 'insert into private.revoked_sessions (session_id, user_id) values (p_session, p_user); delete from auth.sessions where id = p_session;' },
    ])).toEqual([
      'private.x 直接删了 auth.sessions（一律改调 private.kill_session，它同时写吊销记录；R-382）',
      'private.kill_session 删了 auth.sessions，却没调 private.revoke_session（被删会话的设备会被当成登录过期、不清本机；R-382）',
    ]);
  });
});

// 架构 3.5 第 5 点：revoked_sessions 登记 maxLifetime '30 days'（会话已不存在后 30 天；R-382 代码审、安全审 M1）
describe('清单：revoked_sessions 的保留期', () => {
  it('core 清单和生成快照里都是 30 days', () => {
    for (const ms of [allManifests, manifestSnapshot]) {
      const t = ms.find((m) => m.feature === 'core')?.tables.find((x) => x.name === 'revoked_sessions');
      expect(t?.maxLifetime).toBe('30 days');
    }
  });
});
