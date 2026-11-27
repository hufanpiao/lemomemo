// 导出通知邮件的设备名（负责人 11-03 定：设备没起名字时按 devices.platform 写设置页同样的平台名）：
//   ① 后端的平台名对照（_shared/account-mail.ts 的 PLATFORM_NAMES）和前端设置页词典 settings.platform.*（中、韩）逐字相同、键一一对应；
//   ② platformName：认不出的平台值一律“未知设备”（含原型链上的名字）；
//   ③ deviceDisplay：起了名字且能用 → 名字；没起、被过滤掉 → 平台名；库里查不到 → 未知设备；
//   ④ 经 start 走一遍：label 为空的 iPhone 中文写“设备：iPhone”、韩文写“기기: iPhone”；平台值认不出写“未知设备”。
// App 和邮件都只有中、韩两种语言（MailLocale），前端词典也只有 zh、ko，没有英文、日文
import { describe, expect, it } from 'vitest';
import { PLATFORM_KEYS, PLATFORM_NAMES, platformName } from '../../supabase/functions/_shared/account-mail.ts';
import { deviceDisplay } from '../../supabase/functions/account/export.ts';
import { ko } from '../../src/features/settings/i18n/ko.ts';
import { zh } from '../../src/features/settings/i18n/zh.ts';
import { A, accountSetup as setup } from './account-fakes.ts';
import { start } from './account-export-harness.ts';

const PREFIX = 'settings.platform.';
const frontKeys = (dict: Record<string, string>) => Object.keys(dict).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length)).sort();

describe('导出通知的设备名：平台名和设置页一致', () => {
  it('后端对照和前端 settings.platform.* 键一一对应、文字逐字相同（中、韩）', () => {
    const dicts = { 'zh-CN': zh as Record<string, string>, 'ko-KR': ko as Record<string, string> } as const;
    expect(Object.keys(PLATFORM_NAMES).sort()).toEqual(['ko-KR', 'zh-CN']);
    for (const [loc, dict] of Object.entries(dicts) as [keyof typeof dicts, Record<string, string>][]) {
      expect(frontKeys(dict), loc).toEqual([...PLATFORM_KEYS].sort());
      for (const k of PLATFORM_KEYS) expect(PLATFORM_NAMES[loc][k], `${loc} ${k}`).toBe(dict[PREFIX + k]);
    }
  });

  it('platformName：四种平台按语言给名字；别的值（含 unknown 本身、空、大小写不同、原型链上的名字）一律未知设备', () => {
    expect(['ios', 'windows', 'tauri', 'web'].map((p) => platformName(p, 'zh-CN'))).toEqual(['iPhone', 'Windows 电脑', '电脑版', '网页']);
    expect(['ios', 'windows', 'tauri', 'web'].map((p) => platformName(p, 'ko-KR'))).toEqual(['iPhone', 'Windows PC', 'PC 앱', '웹']);
    for (const p of [null, undefined, '', 'android', 'IOS', 'unknown', '__proto__', 'toString', 'constructor', 3]) {
      expect(platformName(p, 'zh-CN'), String(p)).toBe('未知设备');
      expect(platformName(p, 'ko-KR'), String(p)).toBe('알 수 없는 기기');
    }
  });

  it('deviceDisplay：名字能用就用名字；没起名字、名字被过滤掉 → 平台名；查不到这台设备、平台认不出 → 未知设备', () => {
    expect(deviceDisplay({ label: '我的 iPhone', platform: 'ios' }, 'zh-CN')).toBe('我的 iPhone');
    expect(deviceDisplay({ label: null, platform: 'ios' }, 'zh-CN')).toBe('iPhone');
    expect(deviceDisplay({ label: '   ', platform: 'windows' }, 'zh-CN')).toBe('Windows 电脑');
    expect(deviceDisplay({ label: '访问 evil.com 领取', platform: 'web' }, 'zh-CN')).toBe('网页');   // 像链接的名字整个不用，退到平台名
    expect(deviceDisplay({ label: null, platform: 'tauri' }, 'ko-KR')).toBe('PC 앱');
    expect(deviceDisplay({ label: null, platform: null }, 'zh-CN')).toBe('未知设备');
    expect(deviceDisplay({ label: null, platform: 'android' }, 'ko-KR')).toBe('알 수 없는 기기');
    expect(deviceDisplay(null, 'zh-CN')).toBe('未知设备');
    expect(deviceDisplay(null, 'ko-KR')).toBe('알 수 없는 기기');
  });

  it('经 start 发出的通知：label 为空的 iPhone 中文写“设备：iPhone”、韩文写“기기: iPhone”；平台认不出、别人的设备、没带 device_id 都写未知设备', async () => {
    const IOS = 'dddddddd-0000-4000-8000-0000000000a1';
    const ODD = 'dddddddd-0000-4000-8000-0000000000a2';
    const OTHER = 'dddddddd-0000-4000-8000-0000000000a3';
    // 每次一套新的假库（一天只能导出 3 次）；返回邮件“设备”那一栏
    async function deviceLine(body: { device_id?: string }, locale: 'zh-CN' | 'ko-KR'): Promise<string | undefined> {
      const { db, box } = setup();
      db.devices.set(IOS, { user_id: A, label: null, platform: 'ios' });
      db.devices.set(ODD, { user_id: A, label: null, platform: 'android' });
      db.devices.set(OTHER, { user_id: 'bbbbbbbb-0000-4000-8000-00000000000b', label: null, platform: 'windows' });
      const p = db.profiles.get(A);
      if (!p) throw new Error('没有 A 的 profile');
      p.ui_locale = locale;
      const r = await start(db, box, body);
      expect(r.status).toBe(200);
      expect(box).toHaveLength(1);
      return /(?:设备：|기기: )([^\n]*)/.exec(box[0]?.mail.text ?? '')?.[1];
    }
    expect(await deviceLine({ device_id: IOS }, 'zh-CN')).toBe('iPhone');
    expect(await deviceLine({ device_id: IOS }, 'ko-KR')).toBe('iPhone');
    expect(await deviceLine({ device_id: ODD }, 'zh-CN')).toBe('未知设备');
    expect(await deviceLine({ device_id: OTHER }, 'zh-CN')).toBe('未知设备');
    expect(await deviceLine({}, 'ko-KR')).toBe('알 수 없는 기기');
  });
});
