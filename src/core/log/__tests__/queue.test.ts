// 日志上传队列（架构 0.38 第 68 条；接手清单 K8-logs、K6-log）：上限 200 丢最旧并补 log_dropped、只在主页且在线时传、
// 攒够 20 条 / 满 30 秒 / 恢复网络触发、ok 和 drop 删掉这一批、retry 留着、存储失败退回内存、几个标签页共用一个键、列截断
import { describe, expect, it, vi } from 'vitest';
import { createLogQueue, LOG_BATCH, LOG_FLUSH_AT, LOG_FLUSH_MS, LOG_QUEUE_MAX, type LogUploadResult } from '../queue.ts';
import { addN, memStore, settle, setup } from './queue-fake.ts';

describe('队列存放', () => {
  it('满 200 条丢最旧的，记下丢了几条；下次上传在这一批前面附一条 log_dropped（code = 条数）', async () => {
    const w = setup();
    addN(w.q, LOG_QUEUE_MAX + 3);
    const p = w.q.peek();
    expect(p.items).toHaveLength(LOG_QUEUE_MAX);
    expect(p.items[0]?.act).toBe('a3');
    expect(p.dropped).toBe(3);
    w.q.setLeader(true);
    await settle();
    expect(w.sent[0]?.[0]).toEqual({ t: 1_000_000, act: 'log_dropped', code: '3' });
    expect(w.sent[0]?.[1]).toMatchObject({ act: 'a3' });
    expect(w.sent[0]).toHaveLength(LOG_BATCH + 1);
    expect(w.q.peek().dropped).toBe(0);
    expect(w.q.peek().items).toHaveLength(LOG_QUEUE_MAX - LOG_BATCH);
  });

  it('存的是 JSON，键 k 只在本机（不上传）', async () => {
    const w = setup();
    w.q.add({ act: 'x', t: 5, coll: 'notes' });
    expect(JSON.parse(w.st.s.text ?? '')).toEqual({ items: [{ act: 'x', t: 5, coll: 'notes', k: 'k1' }], dropped: 0 });
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent[0]).toEqual([{ t: 5, act: 'x', coll: 'notes' }]);
  });

  it('localStorage 读写都失败：退回只放内存，照样能攒能传', async () => {
    const st = memStore();
    st.s.broken = true;
    const w = setup({ store: st });
    w.q.add({ act: 'x', t: 1 });
    w.q.add({ act: 'y', t: 2 });
    expect(w.q.peek().items.map((x) => x.act)).toEqual(['x', 'y']);
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent[0]?.map((r) => r.act)).toEqual(['x', 'y']);
    expect(w.q.peek().items).toEqual([]);
  });

  it('存的内容坏了（不是 JSON、缺字段）：当空队列，丢掉坏条目', () => {
    const st = memStore();
    st.s.text = '{oops';
    const w = setup({ store: st });
    expect(w.q.peek()).toEqual({ items: [], dropped: 0 });
    st.s.text = JSON.stringify({ items: [{ act: 'ok', t: 1, k: 'a' }, { act: 2 }, null], dropped: 'x' });
    expect(w.q.peek()).toEqual({ items: [{ act: 'ok', t: 1 }], dropped: 0 });
  });

  it('两个标签页共用一个键：各自读 → 改 → 写，不互相覆盖；主页传完只删自己传上去的那几条', async () => {
    const st = memStore();
    const a = setup({ store: st });
    const b = setup({ store: st });
    a.q.add({ act: 'from-a', t: 1 });
    b.q.add({ act: 'from-b', t: 2 });
    expect(a.q.peek().items.map((x) => x.act)).toEqual(['from-a', 'from-b']);
    // 主页正在传的时候，另一页又记了一条：传完不能把它删掉
    let done: (r: LogUploadResult) => void = () => undefined;
    const lead = createLogQueue({
      store: st.store, isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined,
      upload: () => new Promise((r) => (done = r)),
    });
    lead.setLeader(true);
    const f = lead.flush();
    await settle();
    b.q.add({ act: 'late', t: 3 });
    done('ok');
    await f;
    expect(a.q.peek().items.map((x) => x.act)).toEqual(['late']);
  });
});

describe('什么时候上传', () => {
  it('不是主页：攒够 20 条也不传，flush 也不传', async () => {
    const w = setup();
    addN(w.q, LOG_FLUSH_AT + 5);
    await w.q.flush();
    await settle();
    expect(w.sent).toEqual([]);
  });

  it('主页：攒够 20 条马上传一批', async () => {
    const w = setup();
    w.q.setLeader(true);
    addN(w.q, LOG_FLUSH_AT - 1);
    await settle();
    expect(w.sent).toEqual([]);
    addN(w.q, 1, 100);
    await settle();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toHaveLength(LOG_FLUSH_AT);
  });

  it('拿到锁时已经攒够 20 条：马上传', async () => {
    const w = setup();
    addN(w.q, LOG_FLUSH_AT);
    w.q.setLeader(true);
    await settle();
    expect(w.sent).toHaveLength(1);
  });

  it('距上次上传满 30 秒：定时器传；不满 30 秒不传', async () => {
    const w = setup();
    w.q.setLeader(true);
    w.q.add({ act: 'x', t: 1 });
    w.tick(LOG_FLUSH_MS - 1);
    await settle();
    expect(w.sent).toEqual([]);
    w.tick(1);
    await settle();
    expect(w.sent).toHaveLength(1);
  });

  it('离线不传；恢复网络时传', async () => {
    const w = setup({ online: false });
    w.q.setLeader(true);
    addN(w.q, LOG_FLUSH_AT);
    w.tick(LOG_FLUSH_MS);
    await settle();
    expect(w.sent).toEqual([]);
    w.setOnline(true);
    w.goOnline();
    await settle();
    expect(w.sent).toHaveLength(1);
  });

  it('放开锁：停掉定时器和恢复网络的监听，之后不再传', async () => {
    const w = setup();
    w.q.setLeader(true);
    expect(w.hasTimer() && w.hasOnline()).toBe(true);
    w.q.setLeader(false);
    expect(w.hasTimer() || w.hasOnline()).toBe(false);
    addN(w.q, LOG_FLUSH_AT);
    await w.q.flush();
    expect(w.sent).toEqual([]);
  });

  it('队列空着不调上传', async () => {
    const w = setup();
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent).toEqual([]);
  });

  it('正在传的时候再触发：不并发传第二批', async () => {
    let done: (r: LogUploadResult) => void = () => undefined;
    const st = memStore();
    const upload = vi.fn(() => new Promise<LogUploadResult>((r) => (done = r)));
    const q = createLogQueue({ store: st.store, upload, isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined });
    q.add({ act: 'x', t: 1 });
    q.setLeader(true);
    const f = q.flush();
    await q.flush();
    expect(upload).toHaveBeenCalledTimes(1);
    done('ok');
    await f;
  });
});

describe('上传结果', () => {
  it('ok：删掉这一批，剩下的下次传（每批最多 50 条）', async () => {
    const w = setup();
    addN(w.q, 120);
    w.q.setLeader(true);
    await settle();
    expect(w.sent[0]).toHaveLength(LOG_BATCH);
    expect(w.q.peek().items).toHaveLength(70);
    await w.q.flush();
    await w.q.flush();
    expect(w.sent.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(w.q.peek().items).toEqual([]);
  });

  it('drop（quota、42501）：这一批也删掉、不重试，控制台留一句', async () => {
    const w = setup({ result: 'drop' });
    w.q.add({ act: 'x', t: 1 });
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.q.peek().items).toEqual([]);
    expect(w.warn).toHaveBeenCalledWith('[logs] upload rejected, dropped 1');
    await w.q.flush();
    expect(w.sent).toHaveLength(1);
  });

  it('retry（断网、5xx、401、429 等）：留着；丢弃计数也留着，下次一起附上', async () => {
    const w = setup({ result: 'retry' });
    addN(w.q, LOG_QUEUE_MAX + 1);
    w.q.setLeader(true);
    await settle();
    expect(w.q.peek()).toMatchObject({ dropped: 1 });
    expect(w.q.peek().items).toHaveLength(LOG_QUEUE_MAX);
    w.setResult('ok');
    await w.q.flush();
    expect(w.sent[1]?.[0]).toMatchObject({ act: 'log_dropped', code: '1' });
    expect(w.q.peek().dropped).toBe(0);
    expect(w.warn).not.toHaveBeenCalled();
  });

  it('只有丢弃计数、没有条目：也传一条 log_dropped', async () => {
    const st = memStore();
    st.s.text = JSON.stringify({ items: [], dropped: 7 });
    const w = setup({ store: st });
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent[0]).toEqual([{ t: 1_000_000, act: 'log_dropped', code: '7' }]);
    expect(w.q.peek().dropped).toBe(0);
  });
});
