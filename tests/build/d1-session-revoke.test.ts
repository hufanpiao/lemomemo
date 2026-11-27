// D1 第 6 节之三（build/d1/session-revoke.ts；迁移 20261112090000）：删 auth.sessions 只准在 private.kill_session 里、且它要调 private.revoke_session；
// 校验密码会话（not_password_session）只准在 require_live_session、is_active、rebind_device_impl 里。
// 真库上的反例是 supabase/tests/d1-fixtures/44、47（离线 PGlite 也跑）；这里只测判定逻辑。
import { describe, expect, it } from 'vitest';
import { SESSION_CHECK_FNS, sessionCheckProblems, sessionRevokeProblems } from '../../build/d1/session-revoke.ts';
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

describe('sessionCheckProblems', () => {
  it('名单钉住：只有 require_live_session、is_active、rebind_device_impl（rebind 按参数里的会话另校验）', () => {
    expect([...SESSION_CHECK_FNS]).toEqual(['require_live_session', 'is_active', 'rebind_device_impl']);
  });
  it('名单里的调 not_password_session 不报；别的 *_impl 改调 require_live_session 不报', () => {
    expect(sessionCheckProblems([
      { f: 'require_live_session', src: 'if not private.not_password_session() then raise exception' },
      { f: 'rebind_device_impl', src: 'if not Private . Not_Password_Session ( ) then' },
      { f: 'claim_endpoint_impl', src: 'sid := private.require_live_session();' },
    ])).toEqual([]);
  });
  it('名单外的函数自己调 not_password_session：报（大小写、空格都认）', () => {
    expect(sessionCheckProblems([{ f: 'x_impl', src: 'IF NOT private . NOT_PASSWORD_SESSION() THEN' }])).toEqual([
      'private.x_impl 自己校验密码会话（not_password_session），会话校验一律改调 private.require_live_session（架构约定 10.1）',
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
