// 本机推送替身配错和出错时的行为（代码审查 M4、S1、S5）：
//   M4：配错的回复（状态码不在 200～599、204 带响应体……）和拖延（复核 N2：只收非负的有限数）在配置时就报错；控制接口回 400；替身内部出错回 500 并记 error，不把连接挂住
//   S1：已经中止的 signal 直接抛错，不留一条 pending 假记录
//   S5：网络错误回复（进程内 Response.error()、端口模式断开连接）；很大的流式响应体，记下发出了多少字节（测 D1-4“最多读 1 KB 后 cancel()”）
import { describe, expect, it } from 'vitest';
import { type PushReply, reply, replyProblem } from '../fakes/push-service.ts';
import { fakeFactory } from './push-service-fake-sender.ts';

const fake = fakeFactory();
const EP = 'https://fcm.googleapis.com/fcm/send/e';

describe('配错的回复（M4）', () => {
  const bad: [string, unknown][] = [
    ['状态码 99', { kind: 'status', status: 99 }],
    ['状态码 600', { kind: 'status', status: 600 }],
    ['状态码 101', { kind: 'status', status: 101 }],
    ['状态码不是整数', { kind: 'status', status: 201.5 }],
    ['204 带响应体', { kind: 'status', status: 204, body: 'x' }],
    ['304 带响应体', { kind: 'status', status: 304, body: 'x' }],
    ['header 值不是字符串', { kind: 'status', status: 201, headers: { 'retry-after': 30 } }],
    ['不认识的 kind', { kind: 'teapot' }],
    ['stream 的 bytes 是 0', { kind: 'stream', status: 201, bytes: 0 }],
    ['不是对象', 'gone'],
  ];

  it.each(bad)('%s：replyProblem 报原因；setDefault、addRule、构造时都抛错', (_, r) => {
    expect(replyProblem(r)).not.toBeNull();
    expect(() => fake({ defaultReply: r as PushReply })).toThrow(/替身回复配错了/);
    expect(() => fake().setDefault(r as PushReply)).toThrow();
    expect(() => fake().addRule({ reply: r as PushReply })).toThrow(/替身规则配错了/);
  });

  it('合法的回复都过：204 不带体、599、hang、error、bigBody', () => {
    for (const r of [reply.status(204), reply.status(599), reply.hang(), reply.error(), reply.bigBody(10), reply.tooMany('Wed, 21 Oct 2026 07:28:00 GMT')]) {
      expect(replyProblem(r)).toBeNull();
    }
  });

  it('控制接口：配错的回复、规则、拖延回 400，原来的配置不动', async () => {
    const f = fake({ control: true });
    const origin = await f.listen();
    const cfg = (body: unknown) => fetch(`${origin}/__fake/config`, { method: 'POST', body: JSON.stringify(body) });
    expect((await cfg({ defaultReply: { kind: 'status', status: 99 } })).status).toBe(400);
    expect((await cfg({ rules: [{ path: '/x', reply: { kind: 'status', status: 204, body: 'x' } }] })).status).toBe(400);
    expect((await cfg({ rules: [{ reply: reply.gone(), times: -1 }] })).status).toBe(400);
    expect((await cfg({ delayMs: 'slow' })).status).toBe(400);
    expect((await fetch(`${origin}/__fake/config`, { method: 'POST', body: '{' })).status).toBe(400);
    expect((await fetch(`${origin}/push`, { method: 'POST' })).status).toBe(201);
  });

  it.each([
    ['负数', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['字符串', '3000'],
  ])('拖延配错（%s）：构造、setDelay、规则、控制接口都拦（复核 N2）', async (_, ms) => {
    expect(() => fake({ delayMs: ms as number })).toThrow(/替身拖延配错了/);
    expect(() => fake().setDelay(ms as number)).toThrow(/替身拖延配错了/);
    expect(() => fake().addRule({ reply: reply.created(), delayMs: ms as number })).toThrow(/替身规则配错了/);
    const f = fake({ control: true });
    const origin = await f.listen();
    const body = JSON.stringify({ delayMs: ms }); // NaN、Infinity 序列化成 null，也要拦
    expect((await fetch(`${origin}/__fake/config`, { method: 'POST', body })).status).toBe(400);
  });

  it('拖延收 0 和非整数的有限正数', () => {
    expect(() => fake({ delayMs: 0 }).setDelay(1.5)).not.toThrow();
    expect(() => fake().addRule({ reply: reply.created(), delayMs: 2.5 })).not.toThrow();
  });

  it('替身内部出错：回 500，记 outcome = error 和错误信息，连接不挂住', async () => {
    const f = fake();
    const origin = await f.listen();
    // 绕过配置检查硬塞一个坏回复，模拟替身自己的毛病
    (f as unknown as { defaultReply: PushReply }).defaultReply = { kind: 'status', status: 99 };
    const r = await fetch(`${origin}/push`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    expect(r.status).toBe(500);
    expect(f.requests[0]).toMatchObject({ outcome: 'error', status: 500 });
    expect(f.requests[0]?.error).toBeTruthy();
  });
});

describe('已中止的 signal（S1）', () => {
  it('fetch、handle 直接抛错，不留记录', async () => {
    const f = fake();
    const ac = new AbortController();
    ac.abort();
    await expect(f.fetch(EP, { method: 'POST', signal: ac.signal })).rejects.toThrow();
    await expect(f.handle(new Request(EP, { method: 'POST', signal: ac.signal }))).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
});

describe('网络错误和大响应体（S5）', () => {
  it('进程内：reply.error() 回 Response.error()（status 0、type error），记 network-error', async () => {
    const f = fake({ defaultReply: reply.error() });
    const r = await f.fetch(EP, { method: 'POST', redirect: 'manual' });
    expect([r.status, r.type]).toEqual([0, 'error']);
    expect(f.requests[0]?.outcome).toBe('network-error');
  });

  it('端口模式：reply.error() 断开连接，发送方 fetch 抛错', async () => {
    const f = fake({ defaultReply: reply.error() });
    const origin = await f.listen();
    await expect(fetch(`${origin}/push`, { method: 'POST' })).rejects.toThrow();
    expect(f.requests[0]?.outcome).toBe('network-error');
  });

  it('进程内：1 MB 响应体，发送方读 1 KB 后 cancel，记录的发出字节数只到 1 KB 左右', async () => {
    const f = fake({ defaultReply: reply.bigBody() });
    const r = await f.fetch(EP, { method: 'POST' });
    const reader = r.body?.getReader();
    let got = 0;
    while (reader && got < 1024) got += (await reader.read()).value?.length ?? 0;
    await reader?.cancel();
    expect(got).toBeGreaterThanOrEqual(1024);
    expect(f.requests[0]?.responseBytesSent).toBeLessThanOrEqual(1024 + 2 * 256);
  });

  it('进程内：读完全部就是全部字节', async () => {
    const f = fake({ defaultReply: reply.bigBody(5000) });
    const r = await f.fetch(EP, { method: 'POST' });
    expect((await r.arrayBuffer()).byteLength).toBe(5000);
    expect(f.requests[0]?.responseBytesSent).toBe(5000);
  });

  it('端口模式：发送方 cancel 后替身不再写满 1 MB（记的是写进连接的字节数，含 TCP 缓冲，偏大）', async () => {
    const f = fake({ defaultReply: reply.bigBody(8 * 1024 * 1024) });
    const origin = await f.listen();
    const r = await fetch(`${origin}/push`, { method: 'POST' });
    const reader = r.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await new Promise((ok) => setTimeout(ok, 200));
    expect(f.requests[0]?.responseBytesSent).toBeLessThan(8 * 1024 * 1024);
  });
});
