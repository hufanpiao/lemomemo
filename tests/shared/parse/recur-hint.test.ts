// i18n-exempt: 解析词表
// recurHint（R-163；TC-B3-31 单元）：按原话判断有没有重复说法，中韩都认；不带重复说法的不误判
import { describe, expect, it } from 'vitest';
import { recurHint } from '../../../shared/logic/parse/index.ts';

describe('recurHint', () => {
  it('认出中韩重复说法', () => {
    const yes = ['每周一上午9点开周会', '每天晚上8点吃药', '每月5号交房租', '每个月15号交水费', '每年10月28日检查车险', '天天跑步', '每星期三游泳', '매주 월요일 9시 회의', '매일 아침 운동', '매달 15일 관리비', '매월 1일 보고', '매년 3월 5일 보험 갱신'];
    for (const s of yes) expect(recurHint(s)).toBe(true);
  });
  it('不误判', () => {
    const no = ['明天下午3点开会', '周一开会', '下个月5号交房租', '每个人都来', '내일 오후 3시 회의', '매운 음식 먹기', '일정 공유하기', ''];
    for (const s of no) expect(recurHint(s)).toBe(false);
  });
});
