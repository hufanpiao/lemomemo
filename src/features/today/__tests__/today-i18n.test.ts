// 今天页词典（R-337，11-04 负责人定）：韩文列表标题用“오늘 일정”——列表里同时有日程和待办，“할 일”在本 App 专指待办；中文“今天的安排”不动
import { describe, expect, it } from 'vitest';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

describe('今天页列表标题（R-337）', () => {
  it('韩文“오늘 일정”，中文照旧', () => {
    expect(ko['list.title']).toBe('오늘 일정');
    expect(zh['list.title']).toBe('今天的安排');
  });
});
