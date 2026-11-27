// 两页的规则（R-494）：“XX用哪家”每家的状态、这家没有的几项、自带密钥接管哪几项（负责人 11-22“自带密钥四项都能用”）、能不能试
import { describe, expect, it } from 'vitest';
import type { AdminGetRes } from '../../../../shared/schema/ai-provider.ts';
import { canTest, clockParts, isOn, missingOf, needsModel, otherFails, ownSplit, pickList, pickState, routeOf, routeWritable, secOf, toggleWeb } from '../data/rules.ts';

const none = { model: null, last4: null, saved_at: null, has_key: false };
const has = { model: 'm', last4: 'x7Qc', saved_at: 1, has_key: true };
const keys: AdminGetRes['keys'] = { gemini: has, claude: has, openai: none, deepseek: none, brave: none, tavily: { ...has, model: null }, naver: none };

describe('联网搜索（负责人 11-23 弹窗 Brave / Tavily；11-24 加 DeepSeek、Naver；11-25 改成四家各自打勾）', () => {
  it('“联网搜索”弹层列四家（没有“三家联合”那一行），按 has_key 灰不灰；四家 AI 一律没有这项；搜索那三家不能拿去做别的；没有模型名也能试；没有“这家没有”卡', () => {
    expect(pickList('web')).toEqual(['deepseek', 'brave', 'naver', 'tavily']);
    expect(pickList('chat')).toEqual(['gemini', 'claude', 'openai', 'deepseek']);
    expect([pickState('web', 'brave', keys), pickState('web', 'tavily', keys), pickState('web', 'gemini', keys)]).toEqual(['nokey', 'ok', 'no']);
    expect(pickState('web', 'deepseek', { ...keys, deepseek: has })).toBe('ok');
    expect(pickState('chat', 'tavily', keys)).toBe('no');
    expect([needsModel('brave'), needsModel('naver'), needsModel('gemini'), needsModel('deepseek')]).toEqual([false, false, true, true]);
    expect(canTest('', 'fake-key-12345678', false, false)).toBe(true);
    expect(canTest('', 'fake-key-12345678', false)).toBe(false);
    expect(missingOf('brave')).toEqual([]);
    expect(missingOf('naver')).toEqual([]);
  });
  it('勾的几家：isOn 看在不在勾里；toggleWeb 勾上、取消都按 WEB_PROVIDERS 排；只剩一家时取消回 null（至少勾一家）', () => {
    const admin = { routes: { chat: null, stt: null, embed: null }, web: ['deepseek', 'naver'] } satisfies Pick<AdminGetRes, 'routes' | 'web'>;
    expect(pickList('web').map((p) => isOn(admin, 'web', p))).toEqual([true, false, true, false]);
    expect(isOn(admin, 'chat', 'gemini')).toBe(true);
    expect(isOn(admin, 'chat', 'claude')).toBe(false);
    expect(toggleWeb(['naver'], 'deepseek')).toEqual(['deepseek', 'naver']);
    expect(toggleWeb(['deepseek', 'brave', 'naver'], 'tavily')).toEqual(['deepseek', 'brave', 'naver', 'tavily']);
    expect(toggleWeb(['deepseek', 'naver'], 'deepseek')).toEqual(['naver']);
    expect(toggleWeb(['tavily'], 'tavily')).toBeNull();
  });
  it('Naver 的密钥要填成“Client ID:Client Secret”一个值才能试；别家不看冒号', () => {
    expect(canTest('', 'fakeNaverId01:fakeNaverSecret01', false, false, 'naver')).toBe(true);
    expect(canTest('', ' fakeNaverId01:fakeNaverSecret01 ', false, false, 'naver')).toBe(true);
    for (const bad of ['fakeNaverId01fakeSecret', 'fakeNaverId01:', ':fakeNaverSecret01', 'a:b:cdefgh']) expect(canTest('', bad, false, false, 'naver'), bad).toBe(false);
    expect(canTest('', 'fake-brave-12345678', false, false, 'brave')).toBe(true);
    expect(canTest('', '', true, false, 'naver')).toBe(true);
  });
});

describe('有没有密钥只照服务器的 has_key（独立评审 8）', () => {
  it('Gemini 只配了环境变量（没有后四位）也算有；有后四位但 has_key 为 false 不算', () => {
    const env = { model: null, last4: null, saved_at: null, has_key: true };
    expect(pickState('chat', 'gemini', { ...keys, gemini: env })).toBe('ok');
    expect(pickState('chat', 'claude', { ...keys, claude: { ...has, has_key: false } })).toBe('nokey');
  });

  it('向量这项暂时不让写（独立评审 9）', () => {
    expect(routeWritable('embed')).toBe(false);
    expect(routeWritable('chat')).toBe(true);
  });
});

describe('清零时刻写成“下午 5 点”（负责人 11-23）', () => {
  it('24 小时制拆成上午 / 下午、12 小时制', () => {
    expect(clockParts('17:00')).toEqual({ pm: true, h: 5, m: 0 });
    expect(clockParts('16:30')).toEqual({ pm: true, h: 4, m: 30 });
    expect(clockParts('09:05')).toEqual({ pm: false, h: 9, m: 5 });
    expect(clockParts('00:00')).toEqual({ pm: false, h: 12, m: 0 });
    expect(clockParts('12:00')).toEqual({ pm: true, h: 12, m: 0 });
  });
});

describe('XX用哪家', () => {
  it('录音转文字：Gemini 能选；Claude、DeepSeek 没有这项；OpenAI 还没接上（先看能不能做，再看有没有密钥）', () => {
    expect(pickState('stt', 'gemini', keys)).toBe('ok');
    expect(pickState('stt', 'claude', keys)).toBe('no');
    expect(pickState('stt', 'openai', keys)).toBe('later');
    expect(pickState('stt', 'deepseek', keys)).toBe('no');
  });

  it('对话和整理：四家都能做；没存密钥的写“还没填密钥”', () => {
    expect(pickState('chat', 'claude', keys)).toBe('ok');
    expect(pickState('chat', 'openai', keys)).toBe('nokey');
    expect(pickState('chat', 'deepseek', keys)).toBe('nokey');
  });

  it('没配的项沿用默认的 Gemini', () => {
    expect(routeOf({ routes: { chat: 'claude', stt: null, embed: null } }, 'chat')).toBe('claude');
    expect(routeOf({ routes: { chat: null, stt: null, embed: null } }, 'stt')).toBe('gemini');
  });
});

describe('这家没有', () => {
  it('只列 no（later 是柠檬记还没接，不算这家没有）', () => {
    expect(missingOf('gemini')).toEqual([]);
    expect(missingOf('claude')).toEqual(['stt', 'embed']);
    expect(missingOf('openai')).toEqual([]);
    expect(missingOf('deepseek')).toEqual(['stt', 'embed']);
  });
});

describe('自带密钥接管哪几项（切换前提示第一、二条）', () => {
  it('Gemini 接管对话和录音；OpenAI、Claude、DeepSeek 只接管对话；剩下的仍由柠檬记的 AI 做', () => {
    expect(ownSplit('gemini')).toEqual({ covers: ['chat', 'stt'], rest: ['web', 'embed'] });
    expect(ownSplit('openai')).toEqual({ covers: ['chat'], rest: ['web', 'stt', 'embed'] });
    expect(ownSplit('claude')).toEqual({ covers: ['chat'], rest: ['web', 'stt', 'embed'] });
    expect(ownSplit('deepseek')).toEqual({ covers: ['chat'], rest: ['web', 'stt', 'embed'] });
  });
});

describe('能不能试', () => {
  it('模型名对，且贴了格式对的新密钥或库里有一把；贴了半截不能试', () => {
    expect(canTest('gpt-5-mini', 'sk-abcdefgh', false)).toBe(true);
    expect(canTest('gpt-5-mini', '', true)).toBe(true);
    expect(canTest('gpt-5-mini', '', false)).toBe(false);
    expect(canTest('gpt-5-mini', 'sk-a', true)).toBe(false);
    expect(canTest('', 'sk-abcdefgh', false)).toBe(false);
    expect(canTest('gpt 5', 'sk-abcdefgh', false)).toBe(false);
  });

  it('没通卡最后一行列其他几种（不含这一种）；耗时一位小数', () => {
    expect(otherFails('auth')).toEqual(['model', 'quota', 'timeout']);
    expect(otherFails('net')).toEqual(['auth', 'model', 'quota', 'timeout']);
    expect(secOf(812)).toBe('0.8');
    expect(secOf(1250)).toBe('1.3');
  });
});
