// 依据行第二行（ui/chat-parts.tsx 的 refMeta，照方案页：“今天 18:00 截止”“今天截止”“逾 2 天”标红、日程“11月25日 周三 14:00”）：R-492 第 1 段
import { describe, expect, it } from 'vitest';
import type { ChatRef } from '../../../../shared/schema/chat.ts';
import { zh } from '../i18n/zh.ts';
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
import { calbarColor, favLetter, lblOf, refMeta, type T } from '../ui/chat-parts.tsx';

const t = ((k: keyof typeof zh, p: Record<string, string | number>) => zh[k].replace(/\{(\w+)\}/g, (_, n: string) => String(p[n] ?? ''))) as unknown as T;
const TODAY = '2026-11-22';
const ref = (o: Partial<ChatRef>): ChatRef => ({ kind: 'todo', id: '70000000-0000-4000-8000-0000000000a8', title: 'x', date: null, time: null, ...o });

describe('refMeta', () => {
  it('待办：今天带时刻、今天不带时刻、逾期标红、做完、没截止', () => {
    expect(refMeta(ref({ date: TODAY, time: '18:00' }), TODAY, t, 'zh-CN')).toEqual({ text: '今天 18:00 截止', late: false });
    expect(refMeta(ref({ date: TODAY }), TODAY, t, 'zh-CN')).toEqual({ text: '今天截止', late: false });
    expect(refMeta(ref({ date: '2026-11-20' }), TODAY, t, 'zh-CN')).toEqual({ text: '逾 2 天', late: true });
    expect(refMeta(ref({ date: '2026-11-20', done: true }), TODAY, t, 'zh-CN')).toEqual({ text: '已完成', late: false });
    expect(refMeta(ref({}), TODAY, t, 'zh-CN')).toEqual({ text: '', late: false });
  });
  it('日程写日子和时刻；随手记、纪念日只写日子', () => {
    expect(refMeta(ref({ kind: 'event', date: '2026-11-25', time: '14:00' }), TODAY, t, 'zh-CN').text).toMatch(/^11月25日 周三 14:00$/);
    expect(refMeta(ref({ kind: 'note', date: '2026-11-17' }), TODAY, t, 'zh-CN').text).toMatch(/^11月17日 周二$/);
    expect(refMeta(ref({ kind: 'anniv', date: TODAY }), TODAY, t, 'zh-CN').text).toBe('今天');
  });
});

describe('calbarColor', () => {
  it('日程竖条：有项目用项目色（同日历的 projectColorIndex），没有项目用 --text-2', () => {
    expect(calbarColor('工作')).toBe(`var(--p${projectColorIndex('工作')}s)`);
    expect(calbarColor('')).toBe('var(--text-2)');
    expect(calbarColor(undefined)).toBe('var(--text-2)');
  });
});

describe('联网（第 2 段，方案页“联网”截图）', () => {
  it('网页行首字母：weather.naver.com → N、www.kma.go.kr → K；认不出网站名用标题第一个字', () => {
    expect(favLetter('weather.naver.com', '서울 날씨')).toBe('N');
    expect(favLetter('www.kma.go.kr', '기상청')).toBe('K');
    expect(favLetter('naver.com', 'x')).toBe('N');
    expect(favLetter('', '기상청 단기예보')).toBe('기');
  });
  it('灰字：联网了“联网查了 2 个网页 · 用了你的 1 条日程”；只有网页不接后半句；没联网照第 1 段', () => {
    const web = { kind: 'web' as const };
    expect(lblOf({ searched: ['event'], found: 3, webs: 2, refs: [web, web, { kind: 'event' }] }, t)).toBe('联网查了 2 个网页 · 用了你的 1 条日程');
    expect(lblOf({ searched: [], found: 0, webs: 1, refs: [web] }, t)).toBe('联网查了 1 个网页');
    expect(lblOf({ searched: ['todo', 'note'], found: 5, webs: 0, refs: [] }, t)).toBe('查了你的待办、随手记 · 找到 5 条');
    expect(lblOf({ searched: [], found: 0, webs: 0, refs: [] }, t)).toBe('');
  });
});
