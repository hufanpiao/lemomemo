// R-378（OUTBOX-failed-create-drops-edits）：真同步引擎 + 假服务器。新建永久失败时，排在它后面的修改不发
// （改之前会发出去、服务器回 not_found、修改被丢）；点重试以后先建、再改，服务器上是最终内容
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { clearAllCollections } from '../../store.ts';
import { createSync, type Sync } from '../engine.ts';
import { bootOf, fakeLife, FakeServer, fakeTransport, identityParse } from './fake-server.ts';

const running: Sync[] = [];
beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
});

describe('新建永久失败（R-378）', () => {
  it('后面的修改不发、本机留着；重试后先 insert 再 patch，服务器上是最终内容', async () => {
    const { cache, outbox } = await setup();
    const server = new FakeServer();
    const t = fakeTransport(server);
    const sync = createSync(bootOf(cache, outbox), { transport: t, parseRows: identityParse, lifecycle: fakeLife(), now: () => clock.t, skipConfig: true, onRemoved: () => undefined });
    running.push(sync);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改一' } });
    t.failNext.push({ status: 400, code: 'http_400' });
    await sync.syncNow();
    await sync.idle();
    expect(t.calls.filter((c) => c.endsWith(`:todos:${uid(1)}`))).toEqual([`insert:todos:${uid(1)}`]);
    expect(server.table('todos').has(uid(1))).toBe(false);
    expect((await outbox.list()).map((i) => [i.op, i.state])).toEqual([['insert', 'failed'], ['patch', 'pending']]);
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('改一');

    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '改二' } });
    await outbox.retryFailed();
    await sync.syncNow();
    await sync.idle();
    expect(server.table('todos').get(uid(1))?.['title']).toBe('改二');
    expect(await outbox.list()).toEqual([]);
    expect(outbox.getStatus().remindRecs.size).toBe(0);
  });
});
