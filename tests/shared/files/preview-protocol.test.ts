// shared/logic/files/preview-protocol.ts：App 和预览沙箱之间的消息核对（架构 5.13 第 2 点 ④ prep、第 3 点）。坏消息一律丢掉（回 null）
import { describe, expect, it } from 'vitest';
import { clipPrepText, parseFromFrame, parseToFrame, PREP_TEXT_MAX, PREP_THUMB_BYTES } from '../../../shared/logic/files/preview-protocol.ts';

const buf = (n = 8): ArrayBuffer => new ArrayBuffer(n);

describe('parseToFrame：prep', () => {
  it('合格的 prep 原样收下', () => {
    const b = buf();
    expect(parseToFrame({ t: 'prep', id: 'a1_B-2', way: 'pdf', bytes: b })).toEqual({ t: 'prep', id: 'a1_B-2', way: 'pdf', bytes: b });
    for (const way of ['docx', 'xlsx', 'pptx']) expect((parseToFrame({ t: 'prep', id: 'x', way, bytes: b }) as { way?: string } | null)?.way).toBe(way);
  });

  const badTo: [string, unknown][] = [
    ['没有 id', { t: 'prep', way: 'pdf', bytes: buf() }],
    ['id 空', { t: 'prep', id: '', way: 'pdf', bytes: buf() }],
    ['id 太长', { t: 'prep', id: 'a'.repeat(65), way: 'pdf', bytes: buf() }],
    ['id 带奇怪字符', { t: 'prep', id: '<x>', way: 'pdf', bytes: buf() }],
    ['id 不是字符串', { t: 'prep', id: 7, way: 'pdf', bytes: buf() }],
    ['不认识的格式', { t: 'prep', id: 'a', way: 'docm', bytes: buf() }],
    ['bytes 不是 ArrayBuffer', { t: 'prep', id: 'a', way: 'pdf', bytes: new Uint8Array(4) }],
    ['没有 bytes', { t: 'prep', id: 'a', way: 'pdf' }],
  ];
  // deno 的 vitest 垫片没有 it.each：逐条起一个 it
  for (const [name, m] of badTo) it(`${name} → null`, () => expect(parseToFrame(m)).toBeNull());
});

describe('parseFromFrame：prep', () => {
  it('成功：pages、text、thumb 原样收下；Word 的 pages、没有缩略图都是 null', () => {
    const png = buf(100);
    expect(parseFromFrame({ t: 'prep', id: 'r1', pages: 2, text: '出入境申请表', thumb: png })).toEqual({ t: 'prep', id: 'r1', pages: 2, text: '出入境申请表', thumb: png });
    expect(parseFromFrame({ t: 'prep', id: 'r1', pages: null, text: '', thumb: null })).toEqual({ t: 'prep', id: 'r1', pages: null, text: '', thumb: null });
  });

  it('失败：只认 bad_archive、render', () => {
    expect(parseFromFrame({ t: 'prep', id: 'r1', error: 'bad_archive' })).toEqual({ t: 'prep', id: 'r1', error: 'bad_archive' });
    expect(parseFromFrame({ t: 'prep', id: 'r1', error: 'render' })).toEqual({ t: 'prep', id: 'r1', error: 'render' });
    expect(parseFromFrame({ t: 'prep', id: 'r1', error: 'boom' })).toBeNull();
  });

  const badFrom: [string, unknown][] = [
    ['没有 id', { t: 'prep', pages: 1, text: '', thumb: null }],
    ['id 带奇怪字符', { t: 'prep', id: 'a b', pages: 1, text: '', thumb: null }],
    ['pages 负数', { t: 'prep', id: 'a', pages: -1, text: '', thumb: null }],
    ['pages 小数', { t: 'prep', id: 'a', pages: 1.5, text: '', thumb: null }],
    ['pages 缺', { t: 'prep', id: 'a', text: '', thumb: null }],
    ['text 不是字符串', { t: 'prep', id: 'a', pages: 1, text: 3, thumb: null }],
    ['text 超过上限', { t: 'prep', id: 'a', pages: 1, text: 'x'.repeat(PREP_TEXT_MAX + 1), thumb: null }],
    ['thumb 不是 ArrayBuffer', { t: 'prep', id: 'a', pages: 1, text: '', thumb: 'data:image/png;base64,' }],
    ['thumb 空', { t: 'prep', id: 'a', pages: 1, text: '', thumb: buf(0) }],
    ['thumb 太大', { t: 'prep', id: 'a', pages: 1, text: '', thumb: buf(PREP_THUMB_BYTES + 1) }],
    ['thumb 缺', { t: 'prep', id: 'a', pages: 1, text: '' }],
  ];
  for (const [name, m] of badFrom) it(`${name} → null`, () => expect(parseFromFrame(m)).toBeNull());

  it('原有消息照旧', () => {
    expect(parseFromFrame({ t: 'ready' })).toEqual({ t: 'ready' });
    expect(parseFromFrame({ t: 'error', why: 'render' })).toEqual({ t: 'error', why: 'render' });
    expect(parseFromFrame({ t: 'nope' })).toBeNull();
  });
});

describe('clipPrepText', () => {
  it('没超就原样', () => {
    expect(clipPrepText('外国人登录证')).toBe('外国人登录证');
  });
  it('超了截到上限', () => {
    expect(clipPrepText('字'.repeat(PREP_TEXT_MAX + 50))).toHaveLength(PREP_TEXT_MAX);
  });
  it('截断点落在表情的两半中间时，前一半一起去掉', () => {
    const s = 'a'.repeat(PREP_TEXT_MAX - 1) + '😀' + 'b';
    const out = clipPrepText(s);
    expect(out).toBe('a'.repeat(PREP_TEXT_MAX - 1));
  });
});
