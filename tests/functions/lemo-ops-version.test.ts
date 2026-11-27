// R-270（K15-ver 方案 A）：lemo-ops 每 15 分钟把线上 /app/version.json 和自己 version_metadata 的 tag 比对。
// 规则本身（一致、不一致、取不到、格式不对）直接测 evaluateVersion / fetchSiteVersion；
// 宽限期（连续 2 轮才发）、去重、“已恢复”用 lemo-ops-harness 的假世界整轮跑。
import { describe, expect, it } from 'vitest';
import { RESEND_AFTER_MS, stateKey } from '../../workers/lemo-ops/src/alerts.ts';
import {
  evaluateVersion,
  fetchSiteVersion,
  SITE_ORIGIN,
  VERSION_ISSUE_KEY,
  VERSION_JSON_PATH,
  VERSION_MIN_ROUNDS,
  type SiteVersion,
} from '../../workers/lemo-ops/src/version.ts';
import { M, SECRET, world } from './lemo-ops-harness.ts';

const META = { id: 'ver-id', tag: 'v4.0.0', timestamp: '2026-10-28T23:00:00Z' };
const ok = (version: string): SiteVersion => ({ ok: true, version });
const SUBJECT = '【柠檬记监控】线上网页版本和 lemo-ops 的 tag 核对不通过';
const ROLLBACK_NOTE = '如果刚按回滚手册只回滚了函数，属预期';
const text = (ev: ReturnType<typeof evaluateVersion>) => ev.active.map((i) => i.lines.join('\n')).join('\n');

describe('R-270 规则：evaluateVersion', () => {
  it('一致：tag 去掉 v 后和 version 逐字相同 → 没事，范围含 site-version（之前的告警才能恢复）', () => {
    expect(evaluateVersion(META, ok('4.0.0'))).toEqual({ active: [], scopes: [VERSION_ISSUE_KEY] });
    expect(evaluateVersion({ tag: 'v12.3.45' }, ok('12.3.45')).active).toEqual([]);
  });

  it('不一致：写出两边的版本号，带回滚说明和防护边界，宽限 2 轮', () => {
    const ev = evaluateVersion(META, ok('4.0.1'));
    expect(ev.scopes).toEqual([VERSION_ISSUE_KEY]);
    expect(ev.active).toHaveLength(1);
    const [issue] = ev.active;
    expect(issue?.key).toBe(VERSION_ISSUE_KEY);
    expect(issue?.minRounds).toBe(VERSION_MIN_ROUNDS);
    expect(VERSION_MIN_ROUNDS).toBe(2);
    const t = text(ev);
    expect(t).toContain('线上网页是「4.0.1」，lemo-ops 是「v4.0.0」');
    expect(t).toContain(ROLLBACK_NOTE);
    expect(t).toContain('只抓误发和发布半途停下');
    expect(t).toContain('故意改 tag 或伪造 version.json 挡不住');
  });

  it('逐字比对：前导零、多余的 v、大小写都算不一致或格式不对', () => {
    for (const v of ['4.0.00', '04.0.0', 'v4.0.0', '4.0.0 ', '4.0.0\n', '4.0']) expect(evaluateVersion(META, ok(v)).active, v).toHaveLength(1);
    for (const tag of ['V4.0.0', '4.0.0', 'v4.0.0\n', 'v４.0.0', 'v4.0.0-preview.1']) expect(evaluateVersion({ tag }, ok('4.0.0')).active, tag).toHaveLength(1);
  });

  it('预览产物发到正式站：X.Y.Z-preview.N 当不一致，另提示像预览产物', () => {
    const t = text(evaluateVersion(META, ok('4.0.0-preview.3')));
    expect(t).toContain('线上网页是「4.0.0-preview.3」');
    expect(t).toContain('像是把预览产物发到了正式站');
  });

  it('取不到：原因码写进邮件，标题和 key 不变', () => {
    for (const reason of ['http_503', 'timeout', 'network', 'bad_body']) {
      const ev = evaluateVersion(META, { ok: false, reason });
      expect(ev.active.map((i) => [i.key, i.title])).toEqual([[VERSION_ISSUE_KEY, '线上网页版本和 lemo-ops 的 tag 核对不通过']]);
      expect(text(ev)).toContain(`取不到线上 ${VERSION_JSON_PATH}：${reason}。`);
      expect(text(ev)).toContain(ROLLBACK_NOTE);
    }
  });

  it('格式不对：version 不像版本号时不回显原值', () => {
    const t = text(evaluateVersion(META, ok('<script>alert(1)</script>')));
    expect(t).toContain('version 不是 X.Y.Z 格式（不显示原值）');
    expect(t).not.toContain('<script>');
  });

  it('格式不对：tag 为空（不带 tag 的部署）、tag 不像版本号（不回显）、没有绑定', () => {
    expect(text(evaluateVersion({ id: 'x', tag: '', timestamp: 't' }, ok('4.0.0')))).toContain('lemo-ops 这一版没有 tag');
    const bad = text(evaluateVersion({ tag: 'evil<b>' }, ok('4.0.0')));
    expect(bad).toContain('tag 不是 vX.Y.Z 格式（不显示原值）');
    expect(bad).not.toContain('evil');
    expect(text(evaluateVersion(undefined, ok('4.0.0')))).toContain('没拿到 version_metadata 绑定');
    // tag 坏且网页也取不到：两条都写
    const both = text(evaluateVersion({ tag: '' }, { ok: false, reason: 'network' }));
    expect(both).toContain('没有 tag');
    expect(both).toContain('取不到线上');
  });
});

describe('R-270 取版本：fetchSiteVersion', () => {
  function stub(respond: (init: RequestInit) => Promise<Response>) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fn = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return respond(init);
    };
    return { seen, fn };
  }

  it('GET 正式站 /app/version.json?t=<now>，cache: no-store，不带任何请求头和密钥', async () => {
    const s = stub(async () => new Response('{"version":"4.0.0"}', { status: 200 }));
    expect(await fetchSiteVersion(s.fn, 1234)).toEqual({ ok: true, version: '4.0.0' });
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]?.url).toBe(`${SITE_ORIGIN}${VERSION_JSON_PATH}?t=1234`);
    expect(SITE_ORIGIN).toBe('https://lemomemo.com');
    expect(s.seen[0]?.init.method).toBe('GET');
    expect(s.seen[0]?.init.cache).toBe('no-store');
    expect(s.seen[0]?.init.headers).toBeUndefined();
    expect(s.seen[0]?.init.body).toBeUndefined();
  });

  it('非 200、网络错误、超时、不是 JSON、没有 version 字符串 → 各自的原因码', async () => {
    const cases: Array<[(init: RequestInit) => Promise<Response>, string]> = [
      [async () => new Response('busy', { status: 503 }), 'http_503'],
      [async () => new Response('{"version":"4.0.0"}', { status: 404 }), 'http_404'],
      [async () => Promise.reject(new TypeError('fetch failed')), 'network'],
      [(init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), 'timeout'],
      [async () => new Response('<html>', { status: 200 }), 'bad_body'],
      [async () => new Response('{"v":"4.0.0"}', { status: 200 }), 'bad_body'],
      [async () => new Response('{"version":400}', { status: 200 }), 'bad_body'],
      [async () => new Response('null', { status: 200 }), 'bad_body'],
    ];
    for (const [respond, reason] of cases) expect(await fetchSiteVersion(stub(respond).fn, 1, 20), reason).toEqual({ ok: false, reason });
  });
});

/** 一轮：先把已上线的心跳刷成“刚写过”，免得隔 15 分钟心跳过期混进别的告警 */
async function tick(w: ReturnType<typeof world>) {
  w.freshAll();
  await w.tick();
}

describe('R-270 整轮：宽限期、去重、恢复', () => {
  const versionMails = (w: ReturnType<typeof world>) => w.inbox.filter((m) => m.subject.includes('lemo-ops 的 tag 核对不通过'));

  it('一致：每轮都请求 version.json（带 no-store），一直不发信、不留状态', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) {
      await tick(w);
      w.advance(15 * M);
    }
    expect(w.inbox).toHaveLength(0);
    expect(w.siteInit?.cache).toBe('no-store');
    expect(w.kv.get(stateKey('heartbeat')) ?? '').not.toContain(VERSION_ISSUE_KEY);
  });

  it('宽限期：第 1 轮对不上不发，连续第 2 轮发 1 封；之后 6 小时内不重复，满 6 小时发“仍未恢复”', async () => {
    const w = world();
    w.setSite('4.0.1');
    await tick(w);
    expect(w.inbox).toHaveLength(0);
    w.advance(15 * M);
    await tick(w);
    expect(w.inbox.map((m) => m.subject)).toEqual([SUBJECT]);
    const body = w.inbox[0]?.text ?? '';
    expect(body).toContain('线上网页是「4.0.1」，lemo-ops 是「v4.0.0」');
    expect(body).toContain(ROLLBACK_NOTE);
    for (const s of [SECRET, 'test-anon', 'test-resend']) expect(body).not.toContain(s);
    const steps = RESEND_AFTER_MS / (15 * M);
    for (let i = 1; i < steps; i++) {
      w.advance(15 * M);
      await tick(w);
    }
    expect(versionMails(w)).toHaveLength(1);
    w.advance(15 * M);
    await tick(w);
    expect(versionMails(w).map((m) => m.subject)).toEqual([SUBJECT, `【柠檬记监控】仍未恢复：线上网页版本和 lemo-ops 的 tag 核对不通过`]);
  });

  it('只对不上 1 轮（发布中途、一次抖动）：不发信；正常 2 轮后状态悄悄删掉', async () => {
    const w = world();
    w.setSite({ fail: 'network' });
    await tick(w);
    w.setSite('4.0.0');
    for (let i = 0; i < 2; i++) {
      w.advance(15 * M);
      await tick(w);
    }
    expect(w.inbox).toHaveLength(0);
    expect(w.kv.get(stateKey('heartbeat')) ?? '').not.toContain(VERSION_ISSUE_KEY);
  });

  it('对不上、正常、对不上交替：不算“连续 2 轮”，一直不发', async () => {
    const w = world();
    for (let i = 0; i < 6; i++) {
      w.setSite(i % 2 ? '4.0.0' : '4.0.1');
      await tick(w);
      w.advance(15 * M);
    }
    expect(w.inbox).toHaveLength(0);
  });

  it('取不到、格式不对也报（同一件事）；先对不上再变成取不到不另发“有变化”', async () => {
    const w = world();
    w.setSite({ fail: 'http503' });
    await tick(w);
    w.advance(15 * M);
    w.setSite({ body: '{"version":"latest"}' });
    await tick(w);
    expect(w.inbox.map((m) => m.subject)).toEqual([SUBJECT]);
    expect(w.inbox[0]?.text).toContain('version 不是 X.Y.Z 格式');
    w.advance(15 * M);
    w.setSite({ fail: 'network' });
    await tick(w);
    expect(w.inbox).toHaveLength(1);
  });

  it('tag 为空（不带 tag 的部署）也按宽限期报', async () => {
    const w = world();
    w.env.CF_VERSION_METADATA = { id: 'x', tag: '', timestamp: 't' };
    await tick(w);
    w.advance(15 * M);
    await tick(w);
    expect(w.inbox).toHaveLength(1);
    expect(w.inbox[0]?.text).toContain('lemo-ops 这一版没有 tag');
  });

  it('恢复：通知过之后连续 2 轮一致发 1 封“已恢复”；第 1 轮一致先不发', async () => {
    const w = world();
    w.setSite('4.0.1');
    await tick(w);
    w.advance(15 * M);
    await tick(w);
    expect(w.inbox).toHaveLength(1);
    w.setSite('4.0.0');
    w.advance(15 * M);
    await tick(w);
    expect(w.inbox).toHaveLength(1);
    w.advance(15 * M);
    await tick(w);
    expect(w.inbox.map((m) => m.subject)).toEqual([SUBJECT, `【柠檬记监控】已恢复：线上网页版本和 lemo-ops 的 tag 核对不通过`]);
  });

  it('和心跳告警互不影响：usage-report 调不通时版本比对照常；版本对不上时心跳告警照常', async () => {
    const w = world();
    w.setMode('http500');
    w.setSite('4.0.1');
    await tick(w);
    w.advance(15 * M);
    await tick(w);
    expect(w.inbox.map((m) => m.subject).sort()).toEqual(['【柠檬记监控】监控连不上服务器', SUBJECT].sort());
  });
});
