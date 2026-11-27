// 本机推送替身（tests/fakes/push-service.ts）的自测：替身自己的行为不对，拿它测 push-dispatch 得出的“通过”就不可信。
// 覆盖：201 / 404 / 410 / 429（Retry-After）/ 3xx（Location）/ 挂住 / 每个请求拖 N 毫秒（互不阻塞）/ 按路径的规则和次数 /
// 请求记录 / 只听 127.0.0.1、端口可指定 / 进程内 fetch 和端口两种用法一致 / 命令行参数和控制接口。
// VAPID 和订阅方在 push-service-fake-vapid.test.ts，固定向量在 push-service-fake-crypto.test.ts，配错、网络错误、大响应体在 push-service-fake-errors.test.ts。
// TC-B2-80 新增的一条（安全审查第六节）在这里先验替身一侧：301、302、307、308 的 Location 指向 127.0.0.1 的另一个端口，
// 发送方写 redirect: 'manual' 时另一个端口一次都没被访问；不写时能被看到（证明这个断言抓得住“跟随了”）
import { describe, expect, it } from 'vitest';
import { type FakePushService, parseFakePushArgs, REDIRECT_TARGET, reply } from '../fakes/push-service.ts';
import { fakeFactory } from './push-service-fake-sender.ts';

const fake = fakeFactory();

// ---------- 两种用法跑同一组断言 ----------
type Mode = 'in-process' | 'port';
async function sender(mode: Mode, f: FakePushService): Promise<{ fetch: typeof fetch; base: string }> {
  if (mode === 'in-process') return { fetch: f.fetch, base: 'https://fcm.googleapis.com' };
  return { fetch: globalThis.fetch, base: await f.listen() };
}

describe.each(['in-process', 'port'] as const)('推送替身（%s）', (mode) => {
  it('默认回 201，并记下时刻、方法、路径、查询串、请求头、请求体字节数', async () => {
    const f = fake();
    const s = await sender(mode, f);
    const before = Date.now();
    const r = await s.fetch(`${s.base}/fcm/send/abc?x=1`, { method: 'POST', headers: { TTL: '60', Urgency: 'high', 'X-Probe': 'p' }, body: 'hello' });
    expect(r.status).toBe(201);
    expect(f.requests).toHaveLength(1);
    const rec = f.requests[0];
    expect(rec).toMatchObject({ seq: 1, method: 'POST', path: '/fcm/send/abc', search: '?x=1', bodyBytes: 5, outcome: 'replied', status: 201, viaRedirect: false });
    expect(rec?.headers).toMatchObject({ ttl: '60', urgency: 'high', 'x-probe': 'p' });
    expect(rec?.receivedAt).toBeGreaterThanOrEqual(before);
    expect(rec?.respondedAt).toBeGreaterThanOrEqual(rec?.receivedAt ?? 0);
  });

  it('404、410、429 带 Retry-After、任意状态码（403）', async () => {
    const f = fake({
      rules: [
        { path: '/nf', reply: reply.notFound() },
        { path: '/gone', reply: reply.gone() },
        { path: '/slow', reply: reply.tooMany(120) },
        { path: '/vapid', reply: reply.status(403) },
      ],
    });
    const s = await sender(mode, f);
    const st = async (p: string) => {
      const r = await s.fetch(`${s.base}${p}`, { method: 'POST' });
      return [r.status, r.headers.get('retry-after')];
    };
    expect(await st('/nf/1')).toEqual([404, null]);
    expect(await st('/gone/1')).toEqual([410, null]);
    expect(await st('/slow/1')).toEqual([429, '120']);
    expect(await st('/vapid/1')).toEqual([403, null]);
    expect(await st('/other')).toEqual([201, null]);
  });

  it('规则可限次数：第一次 429，之后落到默认 201；正则匹配路径', async () => {
    const f = fake({ rules: [{ path: /^\/fcm\/send\/r-\d+$/, reply: reply.tooMany(), times: 1 }] });
    const s = await sender(mode, f);
    const a = await s.fetch(`${s.base}/fcm/send/r-1`, { method: 'POST' });
    const b = await s.fetch(`${s.base}/fcm/send/r-1`, { method: 'POST' });
    expect([a.status, b.status]).toEqual([429, 201]);
  });

  it('3xx 带 Location；redirect: manual 原样拿到 3xx，替身没被再访问', async () => {
    const f = fake({ defaultReply: reply.redirect() });
    const s = await sender(mode, f);
    const r = await s.fetch(`${s.base}/fcm/send/x`, { method: 'POST', body: 'b', redirect: 'manual' });
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe(REDIRECT_TARGET);
    expect(f.requests).toHaveLength(1);
    expect(f.requests.some((q) => q.viaRedirect)).toBe(false);
  });

  it('3xx 时发送方要是跟随了，记录里有 viaRedirect（证明断言抓得住）', async () => {
    const f = fake({ defaultReply: reply.redirect(REDIRECT_TARGET, 302) });
    const s = await sender(mode, f);
    const r = await s.fetch(`${s.base}/fcm/send/x`, { method: 'POST', body: 'b' });
    expect(r.status).toBe(200);
    expect(f.requests.map((q) => [q.path, q.viaRedirect])).toEqual([
      ['/fcm/send/x', false],
      [REDIRECT_TARGET, true],
    ]);
  });

  it('每个请求拖 N 毫秒，并发的请求互不阻塞（D3 第 6 点：拖 3 秒、造 300 条的缩小版）', async () => {
    const f = fake({ delayMs: 300 });
    const s = await sender(mode, f);
    const t = Date.now();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.fetch(`${s.base}/fcm/send/d${i}`, { method: 'POST' })));
    const took = Date.now() - t;
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(2000); // 串行的话要 6 秒
    expect(f.requests).toHaveLength(20);
  });

  it('挂住不回：发送方 AbortSignal.timeout 到点放弃，记 hung 和放弃时刻；close 不被挂住的请求卡住', async () => {
    const f = fake({ defaultReply: reply.hang() });
    const s = await sender(mode, f);
    const t = Date.now();
    await expect(s.fetch(`${s.base}/fcm/send/h`, { method: 'POST', signal: AbortSignal.timeout(300) })).rejects.toThrow();
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
    const rec = f.requests[0];
    expect(rec?.outcome).toBe('hung');
    expect(rec?.status).toBeNull();
    if (mode === 'in-process') {
      expect((rec?.clientClosedAt ?? 0) - (rec?.receivedAt ?? 0)).toBeGreaterThanOrEqual(250);
    } else {
      // 端口模式：发送方断开连接后服务器才知道，等一下
      await expect.poll(() => rec?.clientClosedAt ?? null).not.toBeNull();
    }
    expect(rec?.closeReason).toBe('client');
    // 再挂一个不设超时的，close 要能结束它
    const p = s.fetch(`${s.base}/fcm/send/h2`, { method: 'POST' }).catch((e: unknown) => e);
    await f.waitForRequests(2);
    const c = Date.now();
    await f.close();
    expect(Date.now() - c).toBeLessThan(1000);
    expect(await p).toBeInstanceOf(Error);
    expect(f.requests[1]?.closeReason).toBe('shutdown'); // 替身关闭和发送方放弃分开记（S7）
  });

  it('拖延期间发送方放弃：记 aborted，不再回复', async () => {
    const f = fake({ delayMs: 2000 });
    const s = await sender(mode, f);
    await expect(s.fetch(`${s.base}/fcm/send/a`, { method: 'POST', signal: AbortSignal.timeout(200) })).rejects.toThrow();
    await expect.poll(() => f.requests[0]?.outcome).toBe('aborted');
    expect(f.requests[0]?.status).toBeNull();
  });
});

describe('推送替身：端口', () => {
  it('只听 127.0.0.1，端口可指定（随机挑端口直接 listen，被占就换一个，不先占后放，S11）', async () => {
    let f: FakePushService | null = null;
    let port = 0;
    for (let i = 0; i < 20 && !f; i++) {
      port = 20000 + Math.floor(Math.random() * 20000);
      const g = fake();
      try {
        await g.listen(port);
        f = g;
      } catch (e) {
        if (!String(e).includes('EADDRINUSE')) throw e;
      }
    }
    expect(f?.origin).toBe(`http://127.0.0.1:${port}`);
    const r = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST' });
    expect(r.status).toBe(201);
  });

  it('overrideUrl：三种主机名都按 D1-8 的写法生成，监听地址不变（只听 127.0.0.1）', async () => {
    const f = fake();
    const origin = await f.listen();
    const port = new URL(origin).port;
    expect(f.overrideUrl()).toBe(`http://127.0.0.1:${port}`);
    expect(f.overrideUrl('localhost', '/push')).toBe(`http://localhost:${port}/push`);
    expect(f.overrideUrl('host.docker.internal')).toBe(`http://host.docker.internal:${port}`);
    expect(f.origin).toBe(origin);
    expect(origin.startsWith('http://127.0.0.1:')).toBe(true);
    expect(() => f.overrideUrl('127.0.0.1', '/a?x=1')).toThrow(); // 不许查询串
    expect(() => f.overrideUrl('127.0.0.1', '/a#b')).toThrow(); // 不许 #
    expect(() => fake().overrideUrl()).toThrow(); // 还没 listen
  });

  it('端口被占时 listen 报错', async () => {
    const a = fake();
    const origin = await a.listen();
    const port = Number(new URL(origin).port);
    await expect(fake().listen(port)).rejects.toThrow();
  });

  it.each([301, 302, 307, 308] as const)(
    'TC-B2-80（替身一侧）：%i 的 Location 指向 127.0.0.1 的另一个端口，redirect: manual 时那个端口一次都没被访问；跟随时能看到',
    async (code) => {
      const other = fake();
      const otherOrigin = await other.listen();
      const f = fake({ defaultReply: reply.redirect(`${otherOrigin}/stolen`, code) });
      const origin = await f.listen();
      const manual = await fetch(`${origin}/fcm/send/x`, { method: 'POST', body: 'b', redirect: 'manual' });
      expect(manual.status).toBe(code);
      expect(manual.headers.get('location')).toBe(`${otherOrigin}/stolen`);
      expect(other.requests).toHaveLength(0);
      // 对照组：不写 manual 就会跟到另一个端口，断言能抓到
      await fetch(`${origin}/fcm/send/y`, { method: 'POST', body: 'b' });
      expect(other.requests.map((q) => q.path)).toEqual(['/stolen']);
    },
  );
});

describe('推送替身：命令行参数和控制接口', () => {
  it('解析参数：端口、回复、拖延、Retry-After、Location、VAPID', () => {
    expect(parseFakePushArgs([]).port).toBe(0);
    expect(parseFakePushArgs([], { FAKE_PUSH_PORT: '9230' }).port).toBe(9230);
    expect(parseFakePushArgs(['--port', '9231'], { FAKE_PUSH_PORT: '9230' }).port).toBe(9231);
    expect(parseFakePushArgs(['--port', '1024']).port).toBe(1024);
    expect(parseFakePushArgs(['--port', '65535']).port).toBe(65535);
    expect(parseFakePushArgs(['--reply', '410']).options.defaultReply).toEqual(reply.gone());
    expect(parseFakePushArgs(['--reply', '429', '--retry-after', '7']).options.defaultReply).toEqual(reply.tooMany(7));
    expect(parseFakePushArgs(['--reply', '308', '--location', 'http://127.0.0.1:1/x']).options.defaultReply).toEqual(reply.redirect('http://127.0.0.1:1/x', 308));
    expect(parseFakePushArgs(['--reply', 'hang']).options.defaultReply).toEqual(reply.hang());
    expect(parseFakePushArgs(['--delay', '3000']).options.delayMs).toBe(3000);
    expect(parseFakePushArgs(['--vapid-report-only']).options.vapid).toEqual({ enforce: false });
    expect(parseFakePushArgs(['--reply', '201']).options.control).toBe(true);
  });

  it.each([[['--port']], [['--port', 'x']], [['--port', '70000']], [['--port', '80']], [['--port', '1023']], [['--reply', 'teapot']], [['--reply', '101']], [['--reply', '99']], [['--nope']]])('不合法的参数报错：%j', (argv) => {
    expect(() => parseFakePushArgs(argv)).toThrow();
  });

  it('控制接口：取记录、改配置、清记录；控制请求本身不记录', async () => {
    const f = fake({ control: true });
    const origin = await f.listen();
    await fetch(`${origin}/fcm/send/1`, { method: 'POST' });
    const cfg = await fetch(`${origin}/__fake/config`, {
      method: 'POST',
      body: JSON.stringify({ rules: [{ path: '/fcm/send/g', reply: reply.gone() }] }),
    });
    expect(cfg.status).toBe(204);
    expect((await fetch(`${origin}/fcm/send/g1`, { method: 'POST' })).status).toBe(410);
    const list = (await (await fetch(`${origin}/__fake/requests`)).json()) as { path: string; status: number }[];
    expect(list.map((q) => [q.path, q.status])).toEqual([
      ['/fcm/send/1', 201],
      ['/fcm/send/g1', 410],
    ]);
    expect((await fetch(`${origin}/__fake/reset`, { method: 'POST' })).status).toBe(204);
    expect(f.requests).toHaveLength(0);
  });

  it('没开 control 时 /__fake/ 路径当普通推送请求处理', async () => {
    const f = fake();
    const origin = await f.listen();
    expect((await fetch(`${origin}/__fake/requests`)).status).toBe(201);
    expect(f.requests).toHaveLength(1);
  });
});
