// D1 第 6 节之三：删 auth.sessions 的 private 函数必须调 private.revoke_session（build/d1/session-revoke.ts；R-382，迁移 20261111120000）。
// 真库上的反例是 supabase/tests/d1-fixtures/44（离线 PGlite 也跑）；这里只测判定逻辑。
import { describe, expect, it } from 'vitest';
import { sessionRevokeProblems } from '../../build/d1/session-revoke.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { manifestSnapshot } from '../../src/core/manifests.gen.ts';

describe('sessionRevokeProblems', () => {
  it('删会话前调了 revoke_session：不报；不删会话的函数不看（只吊销不删的 revoke_my_sessions_impl 也不看）', () => {
    expect(sessionRevokeProblems([
      { f: 'a', src: 'perform private.revoke_session(dev.session_id, uid);\n delete from auth.sessions s where s.id = dev.session_id;' },
      { f: 'b', src: 'PERFORM Private . Revoke_Session (s.id, p_user) from auth.sessions s;  DELETE  FROM  auth.sessions s where s.user_id = p_user;' },
      { f: 'c', src: 'perform private.revoke_session(r.id, uid);' },
      { f: 'd', src: 'select count(*) from auth.sessions;' },
    ])).toEqual([]);
  });
  it('只删会话、不写吊销记录：报出函数名；写成 insert into revoked_sessions 绕过统一入口也报', () => {
    expect(sessionRevokeProblems([
      { f: 'x', src: 'delete from auth.sessions s where s.id = p_old;' },
      { f: 'y', src: 'insert into private.revoked_sessions (session_id, user_id) values (p_old, p_user); delete from auth.sessions where id = p_old;' },
    ])).toEqual([
      'private.x 删了 auth.sessions，却没调 private.revoke_session（被删会话的设备会被当成登录过期、不清本机；R-382，迁移 20261111120000）',
      'private.y 删了 auth.sessions，却没调 private.revoke_session（被删会话的设备会被当成登录过期、不清本机；R-382，迁移 20261111120000）',
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
