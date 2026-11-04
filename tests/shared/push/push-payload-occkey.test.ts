// 推送负载的可选字段 occurrenceKey（supabase/functions/_shared/push/payload.ts；REMIND-close-occkey，11-04）：
// 只认 ① 等于 tag（<kind>:<id>:<due_at>）② 全天日程 event:<id>:allday:<YYYY-MM-DD>:<0|1> 两种写法，和本条的 kind、id（、due_at）对得上才带；
// 别的一律不带、这条照发（不抛错）；不截断；字节放不下照旧先截 body、title。
// Node（vitest）和 Deno（deno task test）各跑一遍：只用 toBe、toEqual
import { describe, expect, it } from 'vitest';
import { buildPayload, MAX_PAYLOAD_BYTES, type PayloadInput } from '../../../supabase/functions/_shared/push/payload.ts';

const td = new TextDecoder();
const parse = (b: Uint8Array) => JSON.parse(td.decode(b)) as Record<string, unknown>;
const UID = '11111111-2222-4333-8444-555555555555';
const ID = '0b9f3c2e-1111-4222-8333-444455556666';
const OTHER = '0b9f3c2e-1111-4222-8333-999999999999';
const DUE = 1_793_000_000_000;
const ev = { user_id: UID, kind: 'event' as const, id: ID, due_at: DUE };
const ALLDAY = `event:${ID}:allday:2026-11-05:1`;

describe('occurrenceKey：合格的两种写法照带', () => {
  it('remind、resolve 都带；全天写法和 tag 写法', () => {
    expect(parse(buildPayload({ ...ev, type: 'remind', occurrenceKey: ALLDAY }))['occurrenceKey']).toBe(ALLDAY);
    expect(parse(buildPayload({ ...ev, type: 'resolve', occurrenceKey: ALLDAY }))).toEqual({ v: 1, type: 'resolve', ...ev, occurrenceKey: ALLDAY });
    const todo = { ...ev, kind: 'todo' as const };
    expect(parse(buildPayload({ ...todo, type: 'remind', occurrenceKey: `todo:${ID}:${DUE}` }))['occurrenceKey']).toBe(`todo:${ID}:${DUE}`);
    const anniv = { ...ev, kind: 'anniv' as const };
    expect(parse(buildPayload({ ...anniv, type: 'resolve', occurrenceKey: `anniv:${ID}:${DUE}` }))['occurrenceKey']).toBe(`anniv:${ID}:${DUE}`);
  });
  it('不给（旧调用方）、给 null：不带这个键，其余和原来一样', () => {
    expect(parse(buildPayload({ ...ev, type: 'resolve' }))).toEqual({ v: 1, type: 'resolve', ...ev });
    expect(parse(buildPayload({ ...ev, type: 'remind', occurrenceKey: null }))).toEqual({ v: 1, type: 'remind', ...ev });
  });
});

describe('occurrenceKey：不合格的一律不带，这条照发', () => {
  const bad: unknown[] = [
    '', 'x', 42, { k: 1 },
    `event:${OTHER}:${DUE}`,                        // id 对不上
    `todo:${ID}:${DUE}`,                            // kind 对不上（本条是 event）
    `event:${ID}:${DUE + 1}`,                       // due_at 对不上
    `event:${OTHER}:allday:2026-11-05:1`,           // 全天写法 id 对不上
    `event:${ID}:allday:2026-11-05:2`,              // remind_days 只认 0、1
    `event:${ID}:allday:2026-11-5:1`,               // 日期格式不对
    `event:${ID}:allday:2026-11-05:1:x`,            // 多出尾巴
    `event:${ID}:allday:2026-11-05:1\n`,            // 控制字符
    `${ALLDAY}${'a'.repeat(5000)}`,                 // 超长
    `event:${ID}:allday:9999-99-99:1`,              // 月、日超范围（安全审查 S1）
    `event:${ID}:allday:2026-02-30:0`,              // 不存在的日期
    `event:${ID}:allday:2026-13-01:0`,
    `event:${ID}:allday:2026-00-10:0`,
    `event:${ID}:allday:2026-11-00:0`,
    `event:${ID}:allday:2025-02-29:0`,              // 平年没有 2 月 29 日
    `event:${ID}:allday:\u0662\u0660\u0662\u0666-11-05:1`,   // unicode 数字（阿拉伯-印度数字）
    `event:${ID}:allday:２０２６-１１-０５:1`,         // 全角数字
    `event:${ID.toUpperCase()}:allday:2026-11-05:1`, // 大写 id
    `event:${ID.toUpperCase()}:${DUE}`,
    ` event:${ID}:${DUE}`,                          // 前导空格
    ` ${ALLDAY}`,
    `event:${ID}:${DUE}\n`,                         // tag 末尾带换行
    `event:${ID}:${DUE} `,
    new String(`event:${ID}:${DUE}`),               // String 对象（不是原始字符串）
    new String(ALLDAY),
  ];
  it('remind：每一个坏值都不带 occurrenceKey，其余字段照常', () => {
    for (const v of bad) {
      const p = parse(buildPayload({ ...ev, type: 'remind', title: 't', occurrenceKey: v } as unknown as PayloadInput));
      expect([String(v).slice(0, 60), p['occurrenceKey']]).toEqual([String(v).slice(0, 60), undefined]);
      expect(p['title']).toBe('t');
    }
  });
  it('resolve：同一份坏值列表也一个都不带', () => {
    for (const v of bad) {
      const p = parse(buildPayload({ ...ev, type: 'resolve', occurrenceKey: v } as unknown as PayloadInput));
      expect([String(v).slice(0, 60), p['occurrenceKey']]).toEqual([String(v).slice(0, 60), undefined]);
      expect(p['type']).toBe('resolve');
    }
  });
  it('真实日期照收：闰年 2 月 29 日、月末 31 日', () => {
    for (const d of ['2028-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) {
      const k = `event:${ID}:allday:${d}:0`;
      expect(parse(buildPayload({ ...ev, type: 'remind', occurrenceKey: k }))['occurrenceKey']).toBe(k);
    }
    expect(parse(buildPayload({ ...ev, type: 'remind', occurrenceKey: `event:${ID}:allday:1900-02-29:0` }))['occurrenceKey']).toBe(undefined);
  });
  it('全天写法只给 kind = event：待办、纪念日带全天写法不带', () => {
    for (const kind of ['todo', 'anniv'] as const) {
      const p = parse(buildPayload({ ...ev, kind, type: 'remind', occurrenceKey: `${kind}:${ID}:allday:2026-11-05:1` }));
      expect(p['occurrenceKey']).toBe(undefined);
    }
  });
});

describe('occurrenceKey 不截断；字节放不下照旧先截 body、再截 title', () => {
  it('标题、正文都塞满落单代理项（每个转义成 6 字节）：occurrenceKey 原样保留，整份 ≤ 3071 字节', () => {
    const big = '\uD800'.repeat(300);
    const b = buildPayload({ ...ev, type: 'remind', occurrenceKey: ALLDAY, title: big, body: big });
    expect(b.length <= MAX_PAYLOAD_BYTES).toBe(true);
    expect(parse(b)['occurrenceKey']).toBe(ALLDAY);
  });
  it('最长的写法（全天，62 字节）', () => {
    expect(new TextEncoder().encode(ALLDAY).length).toBe(62);
  });
});
