// _shared/consent.ts 的 aiAllowed（架构 5.2、15.5，第三轮安全 X5；0.40 R-238）：TC-B1-12
// 四种返回 false：consent_ai_at 为空（含撤回）；同意的版本低于 min_consent_ver；ai.enabled 不是 true；隐私记且 ai.vault = false。都满足时 true。
// 另测：版本号只认 YYYY-MM-DD(-N)、按段数字比；ai.vault 软删的 false 照样挡、ai.enabled 软删算关；读库按本人过滤；
// 读库出错或超时抛 ConsentReadError（不当成同意，也不当成不同意）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiAllowed, ConsentReadError, decideAi, policyVerAtLeast, readConsentFacts,
  type ConsentAdmin, type ConsentFacts, type ConsentQuery, type ConsentTable,
} from '../../supabase/functions/_shared/consent.ts';

const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const V = '2026-10-29';

const OK: ConsentFacts = {
  profile: { consent_ai_at: '2026-10-29T03:00:00Z', consent_policy_ver: V },
  aiEnabled: true,
  aiVault: true,
  minConsentVer: V,
};
const with_ = (p: Partial<ConsentFacts>): ConsentFacts => ({ ...OK, ...p });
const consentedAt = (ver: string | null) => ({ profile: { consent_ai_at: '2026-10-01T00:00:00Z', consent_policy_ver: ver } });

describe('decideAi：TC-B1-12 四种返回 false', () => {
  it('都满足时 true（普通内容、隐私记都放行）', () => {
    expect(decideAi(OK)).toBe(true);
    expect(decideAi(OK, { vault: true })).toBe(true);
  });

  it('① consent_ai_at 为空：从没同意过，或撤回了（撤回只清 consent_ai_at、版本照留）→ false', () => {
    expect(decideAi(with_({ profile: { consent_ai_at: null, consent_policy_ver: null } }))).toBe(false);
    expect(decideAi(with_({ profile: { consent_ai_at: null, consent_policy_ver: V } }))).toBe(false);
    // 没有 profile 行同样不放行
    expect(decideAi(with_({ profile: null }))).toBe(false);
  });

  it('② 同意的版本低于 min_consent_ver（隐私说明升版后还没重新同意）→ false', () => {
    expect(decideAi(with_(consentedAt('2026-10-28')))).toBe(false);
    expect(decideAi(with_({ ...consentedAt(V), minConsentVer: '2026-10-29-1' }))).toBe(false);
    // 版本更高照样放行
    expect(decideAi(with_(consentedAt('2026-11-01')))).toBe(true);
    // min_consent_ver 没配、同意记录没写版本、格式不对：都不放行（认不出来就不送）
    expect(decideAi(with_({ minConsentVer: null }))).toBe(false);
    expect(decideAi(with_(consentedAt(null)))).toBe(false);
    expect(decideAi(with_(consentedAt('4.0.1')))).toBe(false);
  });

  it('③ ai.enabled 不是 true（撤回时服务器写 false；没有这一行；值不是布尔）→ false', () => {
    expect(decideAi(with_({ aiEnabled: false }))).toBe(false);
    expect(decideAi(with_({ aiEnabled: undefined }))).toBe(false);
    expect(decideAi(with_({ aiEnabled: 'true' }))).toBe(false);
    expect(decideAi(with_({ aiEnabled: { v: true } }))).toBe(false);
  });

  it('④ 隐私记且 ai.vault = false → false；普通内容不看 ai.vault；没有 ai.vault 这一行按默认 true（R-82）', () => {
    expect(decideAi(with_({ aiVault: false }), { vault: true })).toBe(false);
    expect(decideAi(with_({ aiVault: false }))).toBe(true);
    expect(decideAi(with_({ aiVault: undefined }), { vault: true })).toBe(true);
  });
});

describe('policyVerAtLeast：版本比较（R-238）', () => {
  it('按“-”切段数字比', () => {
    expect(policyVerAtLeast('2026-10-29', '2026-10-28')).toBe(true);
    expect(policyVerAtLeast('2026-09-30', '2026-10-01')).toBe(false);
    expect(policyVerAtLeast('2027-01-01', '2026-12-31')).toBe(true);
    expect(policyVerAtLeast('2026-10-29-10', '2026-10-29-9')).toBe(true);
    expect(policyVerAtLeast('2026-10-29-9', '2026-10-29-10')).toBe(false);
  });

  it('相等算满足；缺的段按 0', () => {
    expect(policyVerAtLeast(V, V)).toBe(true);
    expect(policyVerAtLeast('2026-10-29-1', V)).toBe(true);
    expect(policyVerAtLeast(V, '2026-10-29-1')).toBe(false);
  });

  it('空或格式不对一律 false（两边任何一边）', () => {
    const bad = [null, undefined, '', '4.0.1', '2026-1-5', '2026-10-29-0', '2026-10-29-100', '2026-10-29-01', ' 2026-10-29', '2026/10/29', '10', '2026-10-29-'];
    for (const b of bad) {
      expect(policyVerAtLeast(b, V), `${String(b)} >= ${V}`).toBe(false);
      expect(policyVerAtLeast('2099-12-31', b), `2099-12-31 >= ${String(b)}`).toBe(false);
    }
  });
});

// ───── 假的 admin：记下每次查询的表、列和过滤条件，按表回固定结果 ─────
type Call = { table: string; cols: string; filters: string[] };
type Reply = { data: unknown; error: unknown } | 'hang' | 'reject';

function fakeAdmin(replies: Record<string, Reply>) {
  const calls: Call[] = [];
  const admin: ConsentAdmin = {
    from(table): ConsentTable {
      return {
        select(cols) {
          const call: Call = { table, cols, filters: [] };
          calls.push(call);
          const reply = (): PromiseLike<{ data: unknown; error: unknown }> => {
            const r = replies[table] ?? { data: null, error: null };
            if (r === 'hang') return new Promise(() => undefined);
            return r === 'reject' ? Promise.reject(new Error('fetch failed')) : Promise.resolve(r);
          };
          const q: ConsentQuery = {
            eq(c, v) { call.filters.push(`eq ${c}=${String(v)}`); return q; },
            in(c, vs) { call.filters.push(`in ${c}=${vs.join(',')}`); return q; },
            maybeSingle() { call.filters.push('maybeSingle'); return reply(); },
            then(ok, bad) { return reply().then(ok, bad); },
          };
          return q;
        },
      };
    },
  };
  return { admin, calls };
}

const settingsReply = (rows: unknown[]): Reply => ({ data: rows, error: null });
const GOOD_DB: Record<string, Reply> = {
  profiles: { data: { consent_ai_at: '2026-10-29T03:00:00Z', consent_policy_ver: V }, error: null },
  settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null }, { key: 'ai.vault', value: true, deleted_at: null }]),
  app_config: { data: { notice: { policy_ver: V, min_consent_ver: V } }, error: null },
};

describe('aiAllowed：读库', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('只读本人的 profile 和两个 AI 设置（连“最近删除”里的一起读），app_config 读 id = 1', async () => {
    const { admin, calls } = fakeAdmin(GOOD_DB);
    await readConsentFacts(admin, USER);
    expect(calls).toEqual([
      { table: 'profiles', cols: 'consent_ai_at, consent_policy_ver', filters: [`eq user_id=${USER}`, 'maybeSingle'] },
      { table: 'settings', cols: 'key, value, deleted_at, undone', filters: [`eq user_id=${USER}`, 'in key=ai.enabled,ai.vault'] },
      { table: 'app_config', cols: 'notice', filters: ['eq id=1', 'maybeSingle'] },
    ]);
  });

  it('库里的值原样换成判断用的事实；ai.vault = false 只挡隐私记', async () => {
    const { admin } = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null }, { key: 'ai.vault', value: false, deleted_at: null }]) });
    expect(await readConsentFacts(admin, USER)).toEqual({ ...OK, aiVault: false });
    expect(await aiAllowed(admin, USER)).toBe(true);
    expect(await aiAllowed(admin, USER, { vault: true })).toBe(false);
  });

  it('审查必改 1：软删的 ai.vault = false 照样挡隐私记（不能靠删进“最近删除”绕过）', async () => {
    const { admin } = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null }, { key: 'ai.vault', value: false, deleted_at: 1761700000000 }]) });
    expect(await aiAllowed(admin, USER, { vault: true })).toBe(false);
    expect(await aiAllowed(admin, USER)).toBe(true);
  });

  it('软删的 ai.vault = true 不算数，按没有这一行（默认 true）；有一行 false 就挡', async () => {
    const a = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null }, { key: 'ai.vault', value: true, deleted_at: 1761700000000 }]) });
    expect((await readConsentFacts(a.admin, USER)).aiVault).toBeUndefined();
    const b = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null }, { key: 'ai.vault', value: true, deleted_at: null }, { key: 'ai.vault', value: false, deleted_at: 1 }]) });
    expect(await aiAllowed(b.admin, USER, { vault: true })).toBe(false);
  });

  it('ai.enabled 软删算关：软删的 true 不放行', async () => {
    const { admin } = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: 1761700000000 }]) });
    expect(await aiAllowed(admin, USER)).toBe(false);
  });

  it('撤销（undone）同软删：ai.enabled = true 但 undone = true → 当没打开，aiAllowed 为 false', async () => {
    const { admin } = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null, undone: true }]) });
    expect((await readConsentFacts(admin, USER)).aiEnabled).toBeUndefined();
    expect(await aiAllowed(admin, USER)).toBe(false);
  });

  it('撤销的 ai.vault = false 照样挡隐私记，普通内容放行', async () => {
    const { admin } = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null }, { key: 'ai.vault', value: false, deleted_at: null, undone: true }]) });
    expect(await aiAllowed(admin, USER, { vault: true })).toBe(false);
    expect(await aiAllowed(admin, USER)).toBe(true);
  });

  it('撤销的 ai.vault = true 按没有这一行（默认 true），隐私记放行', async () => {
    const { admin } = fakeAdmin({ ...GOOD_DB, settings: settingsReply([{ key: 'ai.enabled', value: true, deleted_at: null }, { key: 'ai.vault', value: true, deleted_at: null, undone: true }]) });
    expect((await readConsentFacts(admin, USER)).aiVault).toBeUndefined();
    expect(await aiAllowed(admin, USER, { vault: true })).toBe(true);
  });

  it('对照：undone = false 或没有这个字段时，ai.enabled = true 照常放行', async () => {
    for (const row of [{ key: 'ai.enabled', value: true, deleted_at: null, undone: false }, { key: 'ai.enabled', value: true, deleted_at: null }]) {
      const { admin } = fakeAdmin({ ...GOOD_DB, settings: settingsReply([row]) });
      expect(await aiAllowed(admin, USER), JSON.stringify(row)).toBe(true);
    }
  });

  it('没有 profile 行、没有设置行、notice 为空：一律不放行', async () => {
    const { admin } = fakeAdmin({ profiles: { data: null, error: null }, settings: settingsReply([]), app_config: { data: { notice: null }, error: null } });
    expect(await readConsentFacts(admin, USER)).toEqual({ profile: null, aiEnabled: undefined, aiVault: undefined, minConsentVer: null });
    expect(await aiAllowed(admin, USER)).toBe(false);
  });

  it('notice 里的 min_consent_ver 高于同意的版本 → false（版本过期，TC-B1-12 ②，从库里读出来同样生效）', async () => {
    const { admin } = fakeAdmin({ ...GOOD_DB, app_config: { data: { notice: { policy_ver: '2026-11-15', min_consent_ver: '2026-11-15' } }, error: null } });
    expect(await aiAllowed(admin, USER)).toBe(false);
  });

  it('任何一次查询出错或抛异常：抛 ConsentReadError，不回 false 也不回 true', async () => {
    for (const t of ['profiles', 'settings', 'app_config']) {
      const a = fakeAdmin({ ...GOOD_DB, [t]: { data: null, error: { message: 'boom' } } });
      await expect(aiAllowed(a.admin, USER), t).rejects.toBeInstanceOf(ConsentReadError);
      const b = fakeAdmin({ ...GOOD_DB, [t]: 'reject' });
      await expect(aiAllowed(b.admin, USER), t).rejects.toBeInstanceOf(ConsentReadError);
    }
  });

  it('超过 2 秒没回：抛 ConsentReadError（超时）', async () => {
    vi.useFakeTimers();
    const { admin } = fakeAdmin({ ...GOOD_DB, profiles: 'hang' });
    const p = aiAllowed(admin, USER);
    const check = expect(p).rejects.toThrow(/profiles:timeout/);
    await vi.advanceTimersByTimeAsync(2000);
    await check;
  });
});
